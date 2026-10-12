import { createBoundedAbortSignal } from "../abort.ts";
import { SupplierIntegrationError } from "../errors.ts";
import { readBoundedJsonResponse } from "../suppliers/fetch-json.ts";
import { PartsApiIpLimitError, PartsApiKeyError } from "./partsapi-key-error.ts";
import type { PartsApiProxyConfig } from "./partsapi-proxy-config.ts";
import { requestPartsApiViaProxy } from "./partsapi-proxy-request.ts";
import type { ApplicabilitySearchQuery, ApplicabilityVehicle } from "./types.ts";
import { parseApplicabilityVehicles } from "./vehicle-records.ts";

const partsApiOrigin = "https://api.partsapi.ru";
const timeoutMs = 8_000;
const maximumResponseBytes = 2 * 1024 * 1024;

type FetchImplementation = (input: URL, init: RequestInit) => Promise<Response>;

async function hasIpLimitResponse(response: Response, signal: AbortSignal): Promise<boolean> {
  const reader = response.body?.getReader();
  if (!reader) return false;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16 * 1024) {
        await reader.cancel();
        return false;
      }
      chunks.push(value);
    }
    const payload: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
    const { error_code, message, status } = payload as Record<string, unknown>;
    return error_code === 5000 && status === 401 && message === "Exceeded the number of requests from the current IP address.";
  } catch {
    signal.throwIfAborted();
    // The optional error body may be malformed; the HTTP rejection remains an authorization error.
    return false;
  } finally {
    reader.releaseLock();
  }
}

export class PartsApiApplicabilityClient {
  private readonly request: FetchImplementation;
  private readonly proxyRequest: typeof requestPartsApiViaProxy;

  constructor(request: FetchImplementation = globalThis.fetch, proxyRequest: typeof requestPartsApiViaProxy = requestPartsApiViaProxy) {
    this.request = request;
    this.proxyRequest = proxyRequest;
  }

  async search(query: ApplicabilitySearchQuery, signal: AbortSignal, proxy: PartsApiProxyConfig | null = null): Promise<ApplicabilityVehicle[]> {
    signal.throwIfAborted();
    const url = new URL("/", partsApiOrigin);
    url.searchParams.set("method", "getApplicability");
    url.searchParams.set("key", query.apiKey);
    url.searchParams.set("sku", query.sku);
    url.searchParams.set("brand", query.brand);
    const boundedSignal = createBoundedAbortSignal(signal, timeoutMs, "PartsAPI applicability request timed out");

    try {
      let response: Response;
      try {
        response = proxy
          ? await this.proxyRequest(url, proxy, boundedSignal.signal)
          : await this.request(url, { headers: { Accept: "application/json" }, signal: boundedSignal.signal });
      } catch (error) {
        if (boundedSignal.signal.aborted) {
          throw boundedSignal.signal.reason;
        }
        if (error instanceof SupplierIntegrationError) throw error;
        throw new SupplierIntegrationError("PartsAPI applicability request failed", { cause: error });
      }

      if (response.status === 401 || response.status === 403 || response.status === 429) {
        const ipLimit = await hasIpLimitResponse(response, boundedSignal.signal);
        boundedSignal.signal.throwIfAborted();
        if (ipLimit) throw new PartsApiIpLimitError(query.apiKey);
        throw new PartsApiKeyError(query.apiKey);
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new SupplierIntegrationError(`PartsAPI applicability request failed with HTTP ${response.status}`);
      }

      const payload = await readBoundedJsonResponse(response, maximumResponseBytes, "PartsAPI");
      return parseApplicabilityVehicles(payload);
    } catch (error) {
      if (boundedSignal.signal.aborted) throw boundedSignal.signal.reason;
      throw error;
    } finally {
      boundedSignal.dispose();
    }
  }
}
