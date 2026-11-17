import { NomenclatureError, objectFields, parseUuid } from "./contract.ts";

export type StockSortField = "id" | "name" | "article" | "quantity";
export interface StockSort { field: StockSortField; direction: "asc" | "desc" }
export interface StockPosition { id: string; value: string | null }
export const defaultStockSort: StockSort = { field: "id", direction: "asc" };
const invalid = () => new NomenclatureError(400, "invalid_stock_sort", "Некорректная сортировка или позиция списка. Обновите список.");

export function parseStockSort(field: string | null, direction: string | null): StockSort {
  const sort = { field: field ?? "id", direction: direction ?? "asc" };
  if (!["id", "name", "article", "quantity"].includes(sort.field) || !["asc", "desc"].includes(sort.direction)
    || sort.field === "id" && sort.direction !== "asc") throw invalid();
  return sort as StockSort;
}

export function validateStockSortValue(value: unknown, field: StockSortField, signed = false): string | null {
  if (field === "id") { if (value !== null) throw invalid(); return null; }
  if (typeof value !== "string") throw invalid();
  if (field === "quantity") {
    // Keep 1C's exact decimal text, even above Number's exact fractional range.
    if (value.length > 64 || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)
      || !Number.isFinite(Number(value)) || (!signed && Number(value) <= 0) || Math.abs(Number(value)) > 1e15) throw invalid();
  } else if (value.length > (field === "name" ? 500 : 50)) throw invalid();
  return value;
}

export function encodeStockCursor(position: StockPosition, query: string, sort: StockSort, scope = ""): string {
  if (sort.field === "id" && !scope) return position.id;
  return "s1." + Buffer.from(JSON.stringify({ id: position.id, value: position.value, query, ...sort, ...(scope ? { scope } : {}) })).toString("base64url");
}

// This read-only cursor scopes pagination, not authorization. API permissions still apply.
export function decodeStockCursor(cursor: string | null, query: string, sort: StockSort, scope = ""): StockPosition | null {
  if (cursor === null) return null;
  if (sort.field === "id" && !scope) return { id: parseUuid(cursor), value: null };
  if (!/^s1\.[A-Za-z0-9_-]{1,8189}$/.test(cursor)) throw invalid();
  try {
    const data = objectFields(JSON.parse(Buffer.from(cursor.slice(3), "base64url").toString("utf8")), ["id", "value", "query", "field", "direction", "scope"]);
    if (data.query !== query || data.field !== sort.field || data.direction !== sort.direction || (data.scope ?? "") !== scope) throw invalid();
    const position = { id: parseUuid(data.id), value: validateStockSortValue(data.value, sort.field, !!scope) };
    if (encodeStockCursor(position, query, sort, scope) !== cursor) throw invalid();
    return position;
  } catch { throw invalid(); }
}
