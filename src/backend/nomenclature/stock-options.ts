import { NomenclatureError, parseUuid } from "./contract.ts";

export interface StockOptions {
  availability: "available" | "all" | "absent"; priceType: string | null;
  searchMode?: "text" | "oem"; category?: string | null; group?: string | null; oemBrand?: string | null; navigation?: boolean;
}
export function parseStockOptions(availability: string | null, priceType: string | null, search?: URLSearchParams): StockOptions {
  if (availability !== null && !["available", "all", "absent"].includes(availability)) {
    throw new NomenclatureError(400, "invalid_stock_filter", "Неизвестный отбор по остатку.");
  }
  const options: StockOptions = { availability: (availability ?? "available") as StockOptions["availability"], priceType: priceType === null ? null : parseUuid(priceType) };
  if (search && ["searchMode", "category", "group", "oemBrand", "navigation"].some((key) => search.has(key))) {
    const mode = search.get("searchMode") ?? "text";
    if (!["text", "oem"].includes(mode) || search.has("navigation") && !["0", "1"].includes(search.get("navigation")!)) {
      throw new NomenclatureError(400, "invalid_stock_filter", "Некорректные настройки поиска.");
    }
    options.searchMode = mode as "text" | "oem";
    for (const key of ["category", "group", "oemBrand"] as const) options[key] = search.has(key) ? parseUuid(search.get(key)) : null;
    if (mode !== "oem" && options.oemBrand) throw new NomenclatureError(400, "invalid_stock_filter", "Бренд OEM доступен в поиске по OEM-артикулу.");
    options.navigation = search.get("navigation") === "1";
  }
  return options;
}
// Empty is the legacy contract. A nonempty key requires a filter-aware worker.
export const stockOptionsKey = (options?: StockOptions): string => options ? JSON.stringify(options) : "";
