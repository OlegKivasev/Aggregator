import { SupplierIntegrationError } from "../errors.ts";
import type { ApplicabilityVehicle } from "./types.ts";

function readOptionalText(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new SupplierIntegrationError("PartsAPI returned an invalid applicability record");
  }
  return value.trim() || null;
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
    carName: readOptionalText(record, "carName"),
    carType: readOptionalText(record, "carType"),
    makeName: readOptionalText(record, "makeName"),
    modelName: readOptionalText(record, "modelName"),
    yearEnd: readOptionalText(record, "yearEnd"),
    yearStart: readOptionalText(record, "yearStart"),
  };
}

export function parseApplicabilityVehicles(payload: unknown): ApplicabilityVehicle[] {
  if (!Array.isArray(payload)) {
    throw new SupplierIntegrationError("PartsAPI returned an invalid applicability response");
  }
  return payload.map(readVehicle);
}
