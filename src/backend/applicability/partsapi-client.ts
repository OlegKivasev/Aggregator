import { createBoundedAbortSignal } from "../abort.ts";
import { SupplierIntegrationError } from "../errors.ts";
import { readBoundedJsonResponse } from "../suppliers/fetch-json.ts";
import { PartsApiKeyError } from "./partsapi-key-error.ts";
import type { ApplicabilitySearchQuery, ApplicabilityVehicle } from "./types.ts";
import { parseApplicabilityVehicles } from "./vehicle-records.ts";

const partsApiOrigin = "https://api.partsapi.ru";
const timeoutMs = 8_000;
const maximumResponseBytes = 2 * 1024 * 1024;
const maximumErrorResponseBytes = 16 * 1024;

async function isPartsApiLimitError(response: Response, apiKey: string, signal: AbortSignal): Promise<boolean> {
  const reader = response.body?.getReader();
  if (!reader) return false;
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumErrorResponseBytes) {
        await reader.cancel();
        return false;
      }
      chunks.push(value);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    const classificationText = text.replaceAll(apiKey, "[ключ скрыт]");
    return /(?:Exceeded the number of requests from the current IP address\.|лимит.{0,48}(?:исчерпан|законч|превыш)|(?:исчерпан|законч|превыш).{0,48}лимит|(?:quota|limit)[\s_-]*(?:exceeded|exhausted|reached)|(?:exceeded|exhausted)[\s_-]*(?:quota|limit)|too many requests)/iu.test(classificationText);
  } catch {
    if (signal.aborted) throw signal.reason;
    // HTTP rejection remains authoritative when optional error details cannot be read.
    return false;
  } finally {
    reader.releaseLock();
  }
}

type FetchImplementation = (input: URL, init: RequestInit) => Promise<Response>;

export class PartsApiApplicabilityClient {
  private readonly request: FetchImplementation;

  constructor(request: FetchImplementation = globalThis.fetch) {
    this.request = request;
  }

  async search(query: ApplicabilitySearchQuery, signal: AbortSignal): Promise<ApplicabilityVehicle[]> {
    const url = new URL("/", partsApiOrigin);
    url.searchParams.set("method", "getApplicability");
    url.searchParams.set("key", query.apiKey);
    url.searchParams.set("sku", query.sku);
    url.searchParams.set("brand", query.brand);
    const boundedSignal = createBoundedAbortSignal(signal, timeoutMs, "PartsAPI applicability request timed out");

    try {
      let response: Response;
      try {
        response = await this.request(url, { headers: { Accept: "application/json" }, signal: boundedSignal.signal });
      } catch (error) {
        if (boundedSignal.signal.aborted) {
          throw boundedSignal.signal.reason;
        }
        throw new SupplierIntegrationError("PartsAPI applicability request failed", { cause: error });
      }

      if (response.status === 401 || response.status === 403 || response.status === 429) {
        const limitExceeded = await isPartsApiLimitError(response, query.apiKey, boundedSignal.signal);
        boundedSignal.signal.throwIfAborted();
        throw new PartsApiKeyError(query.apiKey, response.status === 429 || limitExceeded);
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new SupplierIntegrationError(`PartsAPI applicability request failed with HTTP ${response.status}`);
      }

      const payload = await readBoundedJsonResponse(response, maximumResponseBytes, "PartsAPI");
      return parseApplicabilityVehicles(payload);
    } finally {
      boundedSignal.dispose();
    }
  }
}
