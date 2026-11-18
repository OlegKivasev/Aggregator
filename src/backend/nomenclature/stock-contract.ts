import { NomenclatureError, objectFields, parseUuid } from "./contract.ts";
import { parseStockNavigation, type StockNavigation } from "./stock-navigation.ts";
import { parseIncomingDetails, type IncomingDetails } from "./incoming-contract.ts";

export const stockPageSize = 100;
export interface StockPrice { amount: number; currency: string; unit?: string }
export interface StockPriceType { id: string; name: string }
export interface StockIncoming { original: number; replacement: number }
export interface StockProduct { id: string; name: string; article: string; quantity: number; incoming?: StockIncoming; price?: StockPrice | null; nameMatches?: string[] }
export interface StockPage { products: StockProduct[]; hasMore: boolean; nextCursor: string | null; receivedAt: string; totalCount?: number; priceTypes?: StockPriceType[]; navigation?: StockNavigation; incomingDetails?: IncomingDetails }
export interface StockResult {
  requestId: string; leaseId: string; status: "completed" | "error";
  products: StockProduct[]; hasMore: boolean;
  lastSortValue?: string | null;
  totalCount?: number;
  priceTypes?: StockPriceType[];
  navigation?: StockNavigation;
  incomingDetails?: IncomingDetails;
}

export function parseStockQuery(value: unknown, preserveOrder = false): string {
  if (typeof value !== "string" || value.length > 100 || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw new NomenclatureError(400, "invalid_stock_query", "Поиск должен содержать не более 100 символов без переносов строк.");
  }
  const query = value.normalize("NFC").trim().replace(/\s+/g, " ").toLocaleLowerCase("ru-RU");
  if (query.length > 100) throw new NomenclatureError(400, "invalid_stock_query", "Поиск после нормализации должен содержать не более 100 символов.");
  if (preserveOrder) return query;
  const terms = [...new Set(query.split(" ").filter(Boolean))];
  return terms.sort().join(" ");
}

export function parseStockResult(value: unknown, signed = false): StockResult {
  const data = objectFields(value, ["requestId", "leaseId", "status", "products", "hasMore", "lastSortValue", "totalCount", "priceTypes", "navigation", "incomingDetails"]);
  if (!["completed", "error"].includes(data.status as string) || !Array.isArray(data.products)
    || data.products.length > stockPageSize || typeof data.hasMore !== "boolean"
    || data.status === "error" && (data.products.length !== 0 || data.hasMore)
    || data.hasMore && data.products.length !== stockPageSize) {
    throw new NomenclatureError(400, "invalid_stock", "Некорректный список остатков.");
  }
  if (data.lastSortValue !== undefined && data.lastSortValue !== null
    && (typeof data.lastSortValue !== "string" || data.lastSortValue.length > 500)) {
    throw new NomenclatureError(400, "invalid_stock", "Некорректное значение сортировки.");
  }
  const identities = new Set<string>();
  const products = data.products.map((value): StockProduct => {
    const item = objectFields(value, ["id", "name", "article", "quantity", "incoming", "price", "nameMatches"]);
    const id = parseUuid(item.id);
    if (identities.has(id) || typeof item.name !== "string" || !item.name.trim() || item.name.length > 500
      || typeof item.article !== "string" || item.article.length > 50
      || /[\u0000-\u001f\u007f-\u009f]/.test(item.name + item.article)
      || typeof item.quantity !== "number" || !Number.isFinite(item.quantity) || (!signed && item.quantity <= 0) || Math.abs(item.quantity) > 1e15) {
      throw new NomenclatureError(400, "invalid_stock", "Некорректный товар или остаток.");
    }
    identities.add(id);
    let price: StockPrice | null | undefined;
    if (item.price === null) price = null;
    else if (item.price !== undefined) {
      const value = objectFields(item.price, ["amount", "currency", "unit"]);
      if (typeof value.amount !== "number" || !Number.isFinite(value.amount) || value.amount < 0 || value.amount > 1e12
        || typeof value.currency !== "string" || !/^[A-Z]{3}$/.test(value.currency)) throw new NomenclatureError(400, "invalid_stock", "Некорректная цена товара.");
      if (value.unit !== undefined && (typeof value.unit !== "string" || value.unit.length > 100 || /[\u0000-\u001f\u007f-\u009f]/.test(value.unit))) throw new NomenclatureError(400, "invalid_stock", "Некорректная единица цены.");
      price = { amount: value.amount, currency: value.currency, ...(value.unit === undefined ? {} : { unit: value.unit as string }) };
    }
    let incoming: StockIncoming | undefined;
    if (item.incoming !== undefined) {
      const { original, replacement } = objectFields(item.incoming, ["original", "replacement"]);
      const valid = (count: unknown): count is number => typeof count === "number" && Number.isFinite(count) && count >= 0 && count <= 1e15;
      if (!valid(original) || !valid(replacement)) throw new NomenclatureError(400, "invalid_stock", "Некорректное количество к поступлению.");
      incoming = { original, replacement };
    }
    let nameMatches: string[] | undefined;
    if (item.nameMatches !== undefined) {
      const matches = item.nameMatches;
      if (!Array.isArray(matches) || matches.length === 0 || matches.length > 16
        || matches.some((term) => typeof term !== "string" || !term.length || /[\u0000-\u0020\u007f-\u009f]/u.test(term))
        || matches.join("").length > 100) {
        throw new NomenclatureError(400, "invalid_stock", "Некорректные совпадения в наименовании.");
      }
      nameMatches = [...new Set(matches)];
    }
    return { id, name: item.name.trim(), article: item.article.trim(), quantity: item.quantity,
      ...(nameMatches === undefined ? {} : { nameMatches }),
      ...(incoming === undefined ? {} : { incoming }), ...(price === undefined ? {} : { price }) };
  });
  if (data.totalCount !== undefined && (!Number.isSafeInteger(data.totalCount) || Number(data.totalCount) < products.length || Number(data.totalCount) > 1e9)) {
    throw new NomenclatureError(400, "invalid_stock", "Некорректное число строк.");
  }
  let priceTypes: StockPriceType[] | undefined;
  if (data.priceTypes !== undefined) {
    if (!Array.isArray(data.priceTypes) || data.priceTypes.length > 1000) throw new NomenclatureError(400, "invalid_stock", "Некорректные виды цен.");
    const ids = new Set();
    priceTypes = data.priceTypes.map((value) => {
      const item = objectFields(value, ["id", "name"]); const id = parseUuid(item.id);
      if (ids.has(id) || typeof item.name !== "string" || !item.name.trim() || item.name.length > 150 || /[\u0000-\u001f\u007f-\u009f]/.test(item.name)) {
        throw new NomenclatureError(400, "invalid_stock", "Некорректный вид цен.");
      }
      ids.add(id); return { id, name: item.name.trim() };
    });
  }
  return { requestId: parseUuid(data.requestId), leaseId: parseUuid(data.leaseId), status: data.status as StockResult["status"],
    products, hasMore: data.hasMore, ...(data.navigation === undefined ? {} : { navigation: parseStockNavigation(data.navigation) }), ...(data.lastSortValue === undefined ? {} : { lastSortValue: data.lastSortValue as string | null }),
    ...(data.incomingDetails === undefined ? {} : { incomingDetails: parseIncomingDetails(data.incomingDetails) }),
    ...(data.totalCount === undefined ? {} : { totalCount: data.totalCount as number }), ...(priceTypes === undefined ? {} : { priceTypes }) };
}
