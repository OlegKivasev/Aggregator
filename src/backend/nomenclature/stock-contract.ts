import { NomenclatureError, objectFields, parseUuid } from "./contract.ts";

export const stockPageSize = 100;
export interface StockProduct { id: string; name: string; article: string; quantity: number }
export interface StockPage { products: StockProduct[]; hasMore: boolean; nextCursor: string | null; receivedAt: string }
export interface StockResult {
  requestId: string; leaseId: string; status: "completed" | "error";
  products: StockProduct[]; hasMore: boolean;
}

export function parseStockQuery(value: unknown): string {
  if (typeof value !== "string" || value.length > 100 || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw new NomenclatureError(400, "invalid_stock_query", "Поиск должен содержать не более 100 символов без переносов строк.");
  }
  const query = value.normalize("NFC").trim().replace(/\s+/g, " ").toLocaleLowerCase("ru-RU");
  if (query.length > 100) throw new NomenclatureError(400, "invalid_stock_query", "Поиск после нормализации должен содержать не более 100 символов.");
  return query;
}

export function parseStockResult(value: unknown): StockResult {
  const data = objectFields(value, ["requestId", "leaseId", "status", "products", "hasMore"]);
  if (!["completed", "error"].includes(data.status as string) || !Array.isArray(data.products)
    || data.products.length > stockPageSize || typeof data.hasMore !== "boolean"
    || data.status === "error" && (data.products.length !== 0 || data.hasMore)
    || data.hasMore && data.products.length !== stockPageSize) {
    throw new NomenclatureError(400, "invalid_stock", "Некорректный список остатков.");
  }
  const identities = new Set<string>();
  const products = data.products.map((value): StockProduct => {
    const item = objectFields(value, ["id", "name", "article", "quantity"]);
    const id = parseUuid(item.id);
    if (identities.has(id) || typeof item.name !== "string" || !item.name.trim() || item.name.length > 500
      || typeof item.article !== "string" || item.article.length > 50
      || /[\u0000-\u001f\u007f-\u009f]/.test(item.name + item.article)
      || typeof item.quantity !== "number" || !Number.isFinite(item.quantity) || item.quantity <= 0 || item.quantity > 1e15) {
      throw new NomenclatureError(400, "invalid_stock", "Некорректный товар или остаток.");
    }
    identities.add(id);
    return { id, name: item.name.trim(), article: item.article.trim(), quantity: item.quantity };
  });
  return { requestId: parseUuid(data.requestId), leaseId: parseUuid(data.leaseId), status: data.status as StockResult["status"],
    products, hasMore: data.hasMore };
}
