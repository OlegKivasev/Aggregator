export const sourceNames = { production: "Основная база", test: "Тестовая база" } as const;
export type NomenclatureSource = keyof typeof sourceNames;
export interface ProductPrice { amount: number; currency: string }
export interface NomenclatureProduct {
  id: string;
  name: string;
  characteristicId: string | null;
  characteristicName: string | null;
  prices: { purchase: ProductPrice | null; retail: ProductPrice | null; retailCashless: ProductPrice | null };
}
export interface LookupResult { status: "found" | "not_found" | "error"; products: NomenclatureProduct[] }
export class NomenclatureError extends Error {
  readonly statusCode: number;
  readonly code: string;
  constructor(statusCode: number, code: string, message: string) { super(message); this.statusCode = statusCode; this.code = code; }
}
export function objectFields(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new NomenclatureError(400, "invalid_payload", "Некорректные данные запроса.");
  }
  return value as Record<string, unknown>;
}
export function parseSource(value: unknown): NomenclatureSource {
  if (value !== "production" && value !== "test") throw new NomenclatureError(400, "invalid_source", "Выберите основную или тестовую базу.");
  return value;
}
export function parseBarcode(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200 || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw new NomenclatureError(400, "invalid_barcode", "Для поиска нужен код длиной до 200 символов без переносов строк.");
  }
  return value;
}
export function parseUuid(value: unknown): string {
  if (typeof value !== "string" || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value)
    || /^0{8}(?:-0{4}){3}-0{12}$/.test(value)) throw new NomenclatureError(400, "invalid_id", "Некорректный идентификатор.");
  return value.toLowerCase();
}
function text(value: unknown, maximum = 500): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw new NomenclatureError(400, "invalid_product", "Некорректное описание товара.");
  }
  return value.trim();
}
function price(value: unknown): ProductPrice | null {
  if (value === null) return null;
  const data = objectFields(value, ["amount", "currency"]);
  if (typeof data.amount !== "number" || !Number.isFinite(data.amount) || data.amount < 0 || data.amount > 1e12
    || typeof data.currency !== "string" || !/^[A-Z]{3}$/.test(data.currency)) {
    throw new NomenclatureError(400, "invalid_price", "Некорректная цена или валюта.");
  }
  return { amount: data.amount, currency: data.currency };
}
export function parseLookupResult(value: unknown): LookupResult & { requestId: string; leaseId: string } {
  const data = objectFields(value, ["requestId", "leaseId", "status", "products"]);
  if (typeof data.status !== "string" || !["found", "not_found", "error"].includes(data.status) || !Array.isArray(data.products) || data.products.length > 20
    || (data.status === "found") !== (data.products.length > 0)) {
    throw new NomenclatureError(400, "invalid_result", "Некорректный результат поиска.");
  }
  const identities = new Set<string>();
  const products = data.products.map((value): NomenclatureProduct => {
    const item = objectFields(value, ["id", "name", "characteristicId", "characteristicName", "prices"]);
    const prices = objectFields(item.prices, ["purchase", "retail", "retailCashless"]);
    const id = parseUuid(item.id);
    const characteristicId = item.characteristicId === null ? null : parseUuid(item.characteristicId);
    if ((characteristicId === null) !== (item.characteristicName === null)) {
      throw new NomenclatureError(400, "invalid_product", "Характеристика товара передана неполностью.");
    }
    const identity = `${id}/${characteristicId ?? ""}`;
    if (identities.has(identity)) throw new NomenclatureError(400, "duplicate_product", "Повтор товара в результате поиска.");
    identities.add(identity);
    return { id, name: text(item.name), characteristicId,
      characteristicName: item.characteristicName === null ? null : text(item.characteristicName, 256),
      prices: { purchase: price(prices.purchase), retail: price(prices.retail), retailCashless: price(prices.retailCashless) } };
  });
  return { requestId: parseUuid(data.requestId), leaseId: parseUuid(data.leaseId), status: data.status as LookupResult["status"], products };
}
