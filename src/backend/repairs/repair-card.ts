export interface RepairCard {
  documentId: string;
  number: string;
  date: string;
  vehicleName: string;
  status: string;
  testPlatform?: boolean;
  counterpartyName?: string;
  goodsReadiness?: { totalPositions: number; availablePositions: number };
}

export class RepairValidationError extends Error {}

const fields = ["documentId", "number", "date", "vehicleName", "status", "testPlatform", "counterpartyName", "goodsReadiness"];

export function parseRepairDocumentId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)
    || value === "00000000-0000-0000-0000-000000000000") {
    throw new RepairValidationError("documentId: требуется непустой UUID документа 1С с дефисами.");
  }
  return value.toLowerCase();
}

function requiredText(payload: Record<string, unknown>, field: string, limit: number): string {
  const value = payload[field];
  if (typeof value !== "string" || !value.trim() || value.length > limit || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw new RepairValidationError(`${field}: требуется непустая строка длиной до ${limit} символов без управляющих символов.`);
  }
  return value.trim();
}

export function parseRepairCard(value: unknown): RepairCard {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RepairValidationError("Требуется JSON-объект карточки ремонта.");
  }
  const payload = value as Record<string, unknown>;
  if (Object.keys(payload).some((key) => !fields.includes(key))) {
    throw new RepairValidationError("Допустимы только поля documentId, number, date, vehicleName, status, testPlatform, counterpartyName, goodsReadiness.");
  }
  if (payload.testPlatform !== undefined && typeof payload.testPlatform !== "boolean") {
    throw new RepairValidationError("testPlatform: требуется логическое значение true или false.");
  }
  const documentId = parseRepairDocumentId(requiredText(payload, "documentId", 36));
  const date = requiredText(payload, "date", 19);
  const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(date) ? Date.parse(`${date}Z`) : NaN;
  if (date.startsWith("0000") || !Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 19) !== date) {
    throw new RepairValidationError("date: требуется реальная дата и время документа в формате YYYY-MM-DDTHH:mm:ss без часового пояса.");
  }
  let goodsReadiness: RepairCard["goodsReadiness"];
  if ("goodsReadiness" in payload) {
    const value = payload.goodsReadiness;
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).length !== 2 || !("totalPositions" in value) || !("availablePositions" in value)
      || typeof value.totalPositions !== "number" || typeof value.availablePositions !== "number"
      || !Number.isSafeInteger(value.totalPositions) || !Number.isSafeInteger(value.availablePositions)
      || value.totalPositions < 0 || value.totalPositions > 100_000
      || value.availablePositions < 0 || value.availablePositions > value.totalPositions) {
      throw new RepairValidationError("goodsReadiness: требуются целые totalPositions и availablePositions от 0 до 100000, availablePositions не больше totalPositions.");
    }
    goodsReadiness = { totalPositions: value.totalPositions, availablePositions: value.availablePositions };
  }
  return {
    documentId,
    number: requiredText(payload, "number", 64),
    date,
    vehicleName: requiredText(payload, "vehicleName", 500),
    status: requiredText(payload, "status", 200),
    ...(payload.testPlatform === true ? { testPlatform: true } : {}),
    ...("counterpartyName" in payload ? { counterpartyName: requiredText(payload, "counterpartyName", 500) } : {}),
    ...(goodsReadiness ? { goodsReadiness } : {}),
  };
}
