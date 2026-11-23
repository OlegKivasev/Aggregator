import { NomenclatureError, objectFields, parseUuid } from "./contract.ts";

export interface IncomingRequest {
  productId: string;
  side: "original" | "replacement";
  testPlatform?: boolean;
  after?: { orderId: string; productId: string };
}
export interface IncomingOrder {
  orderId: string;
  productId: string;
  supplier: string;
  number: string;
  name: string;
  article: string;
  ordered: number | null;
  quantity: number;
  expectedDate: string | null;
}
export interface IncomingDetails { orders: IncomingOrder[]; hasMore: boolean }

export const validCalendarDate = (date: unknown): date is string => typeof date === "string"
  && /^(?!0000)\d{4}-\d{2}-\d{2}$/.test(date)
  && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;

export function parseIncomingRequest(params: URLSearchParams): IncomingRequest {
  const side = params.get("side");
  const after = params.get("after");
  if ([...params.keys()].some((key) => !["product", "side", "after"].includes(key) || params.getAll(key).length !== 1)
    || side !== "original" && side !== "replacement") {
    throw new NomenclatureError(400, "invalid_incoming", "Некорректный запрос поставок.");
  }
  const request: IncomingRequest = { productId: parseUuid(params.get("product")), side };
  if (after !== null) {
    const keys = after.split(".");
    if (keys.length !== 2) throw new NomenclatureError(400, "invalid_incoming", "Некорректная позиция списка поставок.");
    request.after = { orderId: parseUuid(keys[0]), productId: parseUuid(keys[1]) };
  }
  return request;
}

export function parseIncomingDetails(value: unknown): IncomingDetails {
  const data = objectFields(value, ["orders", "hasMore"]);
  const fail = () => new NomenclatureError(400, "invalid_incoming", "Некорректный список поставок.");
  if (!Array.isArray(data.orders) || data.orders.length > 100 || typeof data.hasMore !== "boolean"
    || data.hasMore && data.orders.length !== 100) throw fail();
  const keys = new Set<string>();
  const quantity = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1e15;
  const readText = (value: unknown, limit: number, required = false): string => {
    if (typeof value !== "string" || value.length > limit || /[\u0000-\u001f\u007f-\u009f]/.test(value) || required && !value.trim()) throw fail();
    return value.trim();
  };
  const orders = data.orders.map((value): IncomingOrder => {
    const item = objectFields(value, ["orderId", "productId", "supplier", "number", "name", "article", "ordered", "quantity", "expectedDate"]);
    const orderId = parseUuid(item.orderId);
    const productId = parseUuid(item.productId);
    const key = orderId + "." + productId;
    if (keys.has(key) || !quantity(item.quantity) || item.ordered !== null && !quantity(item.ordered)
      || item.expectedDate !== null && !validCalendarDate(item.expectedDate)) throw fail();
    keys.add(key);
    return { orderId, productId, supplier: readText(item.supplier, 500), number: readText(item.number, 50),
      name: readText(item.name, 500, true), article: readText(item.article, 50),
      quantity: item.quantity, ordered: item.ordered, expectedDate: item.expectedDate };
  });
  return { orders, hasMore: data.hasMore };
}
