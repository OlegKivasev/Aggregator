import { createBoundedAbortSignal } from "../abort.ts";
import { EncryptedPartsApiProxyStore } from "./encrypted-proxy-store.ts";
import { PartsApiApplicabilityClient } from "./partsapi-client.ts";
import { PartsApiIpLimitError } from "./partsapi-key-error.ts";
import type { ApplicabilitySearchQuery, ApplicabilityVehicle } from "./types.ts";

export class PartsApiRoutingClient {
  private readonly client: PartsApiApplicabilityClient;
  private readonly proxies: EncryptedPartsApiProxyStore;

  constructor(client: PartsApiApplicabilityClient, proxies: EncryptedPartsApiProxyStore) {
    this.client = client;
    this.proxies = proxies;
  }

  async search(query: ApplicabilitySearchQuery, signal: AbortSignal): Promise<ApplicabilityVehicle[]> {
    const deadline = createBoundedAbortSignal(signal, 30_000, "PartsAPI proxy selection timed out");
    const attempted = new Set<string | null>();
    try {
      let selection = this.proxies.getSelection();
      while (true) {
        deadline.signal.throwIfAborted();
        attempted.add(selection.id);
        const attemptWindowStartedAt = this.proxies.recordAttempt(selection.id);
        let outcomeRecorded = false;
        try {
          const results = await this.client.search(query, deadline.signal, selection.proxy);
          outcomeRecorded = true;
          this.proxies.recordOutcome(selection.id, results.length > 0 ? "data" : "empty", attemptWindowStartedAt);
          deadline.signal.throwIfAborted();
          this.proxies.recordSuccess(selection);
          return results;
        } catch (error) {
          if (!outcomeRecorded) this.proxies.recordOutcome(selection.id, "failed", attemptWindowStartedAt);
          deadline.signal.throwIfAborted();
          if (!(error instanceof PartsApiIpLimitError)) throw error;
          const next = this.proxies.advanceAfterIpLimit(selection, attempted);
          if (!next) throw new PartsApiIpLimitError(query.apiKey, true);
          selection = next;
        }
      }
    } finally {
      deadline.dispose();
    }
  }
}
