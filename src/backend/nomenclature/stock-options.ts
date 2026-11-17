import { NomenclatureError, parseUuid } from "./contract.ts";

export interface StockOptions { availability: "available" | "all" | "absent"; priceType: string | null }
export function parseStockOptions(availability: string | null, priceType: string | null): StockOptions {
  if (availability !== null && !["available", "all", "absent"].includes(availability)) {
    throw new NomenclatureError(400, "invalid_stock_filter", "Неизвестный отбор по остатку.");
  }
  return { availability: (availability ?? "available") as StockOptions["availability"], priceType: priceType === null ? null : parseUuid(priceType) };
}
// Empty is the legacy contract. A nonempty key requires a filter-aware worker.
export const stockOptionsKey = (options?: StockOptions): string => options ? JSON.stringify(options) : "";
