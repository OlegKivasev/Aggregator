import { NomenclatureError, parseUuid } from "./contract.ts";

interface StockPeriod {
  from: string;
  to: string;
  source: "free" | "customer" | "all";
}

export const inventoryParameters = ["inventory", "receiptFrom", "receiptTo", "receiptSource",
  "saleFrom", "saleTo", "saleSource", "oemPresence", "oemFilterBrand"];

export interface StockOptions {
  availability: "available" | "all" | "absent"; priceType: string | null;
  searchMode?: "text" | "oem"; category?: string | null; group?: string | null; oemBrand?: string | null; navigation?: boolean;
  inventory?: true;
  receipts?: StockPeriod;
  sales?: StockPeriod;
  oemPresence?: "present" | "absent";
  oemFilterBrand?: string;
}

function parsePeriod(params: URLSearchParams, prefix: "receipt" | "sale"): StockPeriod | undefined {
  const from = params.get(prefix + "From");
  const to = params.get(prefix + "To");
  const source = params.get(prefix + "Source");
  if (from === null && to === null && source === null) return;
  const validDate = (date: string | null): date is string => date !== null
    && /^(?!0000)\d{4}-\d{2}-\d{2}$/.test(date)
    && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;
  if (!validDate(from) || !validDate(to) || from > to || (source !== "free" && source !== "customer" && source !== "all")) {
    throw new NomenclatureError(400, "invalid_stock_filter", "Выберите корректный период и источник товара.");
  }
  return { from, to, source };
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
  if (search && inventoryParameters.some((key) => search.has(key))) {
    const presence = search.get("oemPresence");
    const brand = search.get("oemFilterBrand");
    if (search.get("inventory") !== "1" || presence !== null && presence !== "present" && presence !== "absent" || brand !== null && presence === null) {
      throw new NomenclatureError(400, "invalid_stock_filter", "Некорректный отбор номенклатуры.");
    }
    options.inventory = true;
    const receipts = parsePeriod(search, "receipt");
    const sales = parsePeriod(search, "sale");
    if (receipts) options.receipts = receipts;
    if (sales) options.sales = sales;
    if (presence) options.oemPresence = presence;
    if (brand !== null) options.oemFilterBrand = parseUuid(brand);
  }
  return options;
}
// Empty is the legacy contract. A nonempty key requires a filter-aware worker.
export const stockOptionsKey = (options?: StockOptions): string => options ? JSON.stringify(options) : "";
