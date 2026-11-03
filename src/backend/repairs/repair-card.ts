export interface GoodsReadiness {
  totalPositions: number;
  availablePositions: number;
}

export interface RepairCard {
  documentId: string;
  number: string;
  date: string;
  vehicleName: string;
  status: string;
  testPlatform?: boolean;
  counterpartyName?: string;
  goodsReadiness?: GoodsReadiness;
}

export class RepairValidationError extends Error {}

const fields = ["documentId", "number", "date", "vehicleName", "status", "testPlatform", "counterpartyName", "goodsReadiness"];

function cardText(payload: Record<string, unknown>, field: string, limit: number, allowEmpty = false): string {
  const value = payload[field];
  if (typeof value !== "string" || (!allowEmpty && !value.trim()) || value.length > limit || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw new RepairValidationError(`${field}: требуется ${allowEmpty ? "строка" : "непустая строка"} длиной до ${limit} символов без управляющих символов.`);
  }
  return value.trim();
}

function parseGoodsReadiness(value: unknown): GoodsReadiness {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RepairValidationError("goodsReadiness: требуется объект totalPositions, availablePositions.");
  }
  const payload = value as Record<string, unknown>;
  const { totalPositions, availablePositions } = payload;
  if (Object.keys(payload).length !== 2 || Object.keys(payload).some((key) => !["totalPositions", "availablePositions"].includes(key))
    || typeof totalPositions !== "number" || !Number.isSafeInteger(totalPositions) || totalPositions < 0 || totalPositions > 100_000
    || typeof availablePositions !== "number" || !Number.isSafeInteger(availablePositions) || availablePositions < 0 || availablePositions > totalPositions) {
    throw new RepairValidationError("goodsReadiness: требуются целые количества позиций от 0 до 100000; availablePositions не больше totalPositions.");
  }
  return { totalPositions, availablePositions };
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
  const counterpartyName = payload.counterpartyName === undefined ? undefined : cardText(payload, "counterpartyName", 500);
  const documentId = cardText(payload, "documentId", 36).toLowerCase();
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(documentId)
    || documentId === "00000000-0000-0000-0000-000000000000") {
    throw new RepairValidationError("documentId: требуется непустой UUID документа 1С с дефисами.");
  }
  const date = cardText(payload, "date", 19);
  const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(date) ? Date.parse(`${date}Z`) : NaN;
  if (date.startsWith("0000") || !Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 19) !== date) {
    throw new RepairValidationError("date: требуется реальная дата и время документа в формате YYYY-MM-DDTHH:mm:ss без часового пояса.");
  }
  return {
    documentId,
    number: cardText(payload, "number", 64),
    date,
    vehicleName: cardText(payload, "vehicleName", 500, counterpartyName !== undefined),
    status: cardText(payload, "status", 200),
    ...(payload.testPlatform === true ? { testPlatform: true } : {}),
    ...(counterpartyName !== undefined ? { counterpartyName } : {}),
    ...(payload.goodsReadiness !== undefined ? { goodsReadiness: parseGoodsReadiness(payload.goodsReadiness) } : {}),
  };
}
