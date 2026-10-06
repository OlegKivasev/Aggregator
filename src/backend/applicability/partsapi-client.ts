import { createBoundedAbortSignal } from "../abort.ts";
import { SupplierAuthError, SupplierIntegrationError } from "../errors.ts";
import { readBoundedJsonResponse } from "../suppliers/fetch-json.ts";
import type { ApplicabilitySearchQuery, ApplicabilityVehicle } from "./types.ts";

const partsApiOrigin = "https://api.partsapi.ru";
const timeoutMs = 8_000;
const maximumResponseBytes = 2 * 1024 * 1024;

type FetchImplementation = (input: URL, init: RequestInit) => Promise<Response>;

function readRequiredText(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new SupplierIntegrationError("PartsAPI returned an invalid applicability record");
  }
  return value.trim();
}

function readVehicle(value: unknown): ApplicabilityVehicle {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SupplierIntegrationError("PartsAPI returned an invalid applicability record");
  }
  const record = value as Record<string, unknown>;
  const carId = record.carId;
  if (typeof carId !== "number" || !Number.isSafeInteger(carId) || carId <= 0) {
    throw new SupplierIntegrationError("PartsAPI returned an invalid applicability record");
  }

  return {
    carId,
    carName: readRequiredText(record, "carName"),
    carType: readRequiredText(record, "carType"),
    makeName: readRequiredText(record, "makeName"),
    modelName: readRequiredText(record, "modelName"),
    yearEnd: readRequiredText(record, "yearEnd"),
    yearStart: readRequiredText(record, "yearStart"),
  };
}

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

      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel();
        throw new SupplierAuthError("PartsAPI rejected the API key");
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new SupplierIntegrationError(`PartsAPI applicability request failed with HTTP ${response.status}`);
      }

      const payload = await readBoundedJsonResponse(response, maximumResponseBytes, "PartsAPI");
      if (!Array.isArray(payload)) {
        throw new SupplierIntegrationError("PartsAPI returned an invalid applicability response");
      }
      return payload.map(readVehicle);
    } finally {
      boundedSignal.dispose();
    }
  }
}
