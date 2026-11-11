export interface GoodsReadiness {
  totalPositions: number;
  availablePositions: number;
}

export type RepairPaymentStatus = "paid" | "payment_required" | "partially_paid";

export interface RepairPaymentOptions {
  cardAmountDue: number;
  cashAmountDue: number | null;
  cashDiscountPercent: number | null;
}

export interface RepairCard {
  documentId: string;
  number: string;
  date: string;
  vehicleName: string;
  status: string;
  responsibleFio?: string;
  testPlatform?: boolean;
  counterpartyName?: string;
  goodsReadiness?: GoodsReadiness;
  paymentStatus?: RepairPaymentStatus;
  amountDue?: number;
  paymentOptions?: RepairPaymentOptions;
}

export class RepairValidationError extends Error {}

const fields = ["documentId", "number", "date", "vehicleName", "status", "responsibleFio", "testPlatform", "counterpartyName", "goodsReadiness", "paymentStatus", "amountDue", "paymentOptions"];

function validAmount(value: unknown, maximum = 9_999_999_999_999.99): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= maximum
    && /^\d+(?:\.\d{1,2})?$/.test(String(value)) && Number.isSafeInteger(Math.round(value * 100));
}

export function parseRepairPaymentOptions(value: unknown): RepairPaymentOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RepairValidationError("paymentOptions: требуется объект расчёта карты и наличных из 1С.");
  }
  const payload = value as Record<string, unknown>;
  const { cardAmountDue, cashAmountDue, cashDiscountPercent } = payload;
  if (Object.keys(payload).length !== 3 || Object.keys(payload).some((key) => !["cardAmountDue", "cashAmountDue", "cashDiscountPercent"].includes(key))
    || !validAmount(cardAmountDue)
    || !(cashAmountDue === null && cashDiscountPercent === null
      || validAmount(cashAmountDue) && validAmount(cashDiscountPercent, 100))) {
    throw new RepairValidationError("paymentOptions: требуются остатки до копеек и скидка от 0 до 100%; для недоступных наличных оба значения null.");
  }
  return { cardAmountDue, cashAmountDue: cashAmountDue as number | null, cashDiscountPercent: cashDiscountPercent as number | null };
}

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

function parseDocumentId(payload: Record<string, unknown>): string {
  const documentId = cardText(payload, "documentId", 36).toLowerCase();
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(documentId)
    || documentId === "00000000-0000-0000-0000-000000000000") {
    throw new RepairValidationError("documentId: требуется непустой UUID документа 1С с дефисами.");
  }
  return documentId;
}

export function parseRepairRemoval(value: unknown): { documentId: string; testPlatform: boolean } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RepairValidationError("Требуется JSON-объект идентификатора ремонта.");
  }
  const payload = value as Record<string, unknown>;
  if (Object.keys(payload).some((key) => !["documentId", "testPlatform"].includes(key))
    || (payload.testPlatform !== undefined && typeof payload.testPlatform !== "boolean")) {
    throw new RepairValidationError("Допустимы documentId и логический testPlatform.");
  }
  return { documentId: parseDocumentId(payload), testPlatform: payload.testPlatform === true };
}

export function parseRepairCard(value: unknown): RepairCard {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RepairValidationError("Требуется JSON-объект карточки ремонта.");
  }
  const payload = value as Record<string, unknown>;
  if (Object.keys(payload).some((key) => !fields.includes(key))) {
    throw new RepairValidationError("Допустимы только поля documentId, number, date, vehicleName, status, responsibleFio, testPlatform, counterpartyName, goodsReadiness, paymentStatus, amountDue, paymentOptions.");
  }
  if (payload.testPlatform !== undefined && typeof payload.testPlatform !== "boolean") {
    throw new RepairValidationError("testPlatform: требуется логическое значение true или false.");
  }
  if (payload.paymentStatus !== undefined && payload.paymentStatus !== "paid" && payload.paymentStatus !== "payment_required" && payload.paymentStatus !== "partially_paid") {
    throw new RepairValidationError("paymentStatus: требуется paid, payment_required или partially_paid.");
  }
  if (payload.amountDue !== undefined) {
    const amount = payload.amountDue;
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0 || amount > 9_999_999_999_999.99
      || !/^\d+(?:\.\d{1,2})?$/.test(String(amount)) || !Number.isSafeInteger(Math.round(amount * 100))
      || payload.paymentStatus === undefined || (payload.paymentStatus === "paid" ? amount !== 0 : amount <= 0)) {
      throw new RepairValidationError("amountDue: требуется неотрицательная сумма долга с точностью до копеек, соответствующая paymentStatus.");
    }
  } else if (payload.paymentStatus === "partially_paid") {
    throw new RepairValidationError("amountDue: для частичной оплаты требуется положительный остаток долга.");
  }
  if (payload.paymentOptions !== undefined && (payload.paymentStatus === undefined || payload.amountDue === undefined)) {
    throw new RepairValidationError("paymentOptions: требуются paymentStatus и amountDue текущего режима оплаты.");
  }
  const counterpartyName = payload.counterpartyName === undefined ? undefined : cardText(payload, "counterpartyName", 500);
  const responsibleFio = payload.responsibleFio === undefined ? undefined : cardText(payload, "responsibleFio", 256);
  const documentId = parseDocumentId(payload);
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
    ...(responsibleFio !== undefined ? { responsibleFio } : {}),
    ...(payload.testPlatform === true ? { testPlatform: true } : {}),
    ...(counterpartyName !== undefined ? { counterpartyName } : {}),
    ...(payload.goodsReadiness !== undefined ? { goodsReadiness: parseGoodsReadiness(payload.goodsReadiness) } : {}),
    ...(payload.paymentStatus !== undefined ? { paymentStatus: payload.paymentStatus } : {}),
    ...(payload.amountDue !== undefined ? { amountDue: payload.amountDue as number } : {}),
    ...(payload.paymentOptions !== undefined ? { paymentOptions: parseRepairPaymentOptions(payload.paymentOptions) } : {}),
  };
}
