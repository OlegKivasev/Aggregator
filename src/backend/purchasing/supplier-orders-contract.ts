import { NomenclatureError, objectFields, parseUuid } from "../nomenclature/contract.ts";
import { validCalendarDate } from "../nomenclature/incoming-contract.ts";

export const supplierOrdersPageSize = 50;
const sortFields = ["date", "number", "supplier", "buyer", "amount"] as const;
type SortField = typeof sortFields[number];
type SortDirection = "asc" | "desc";
type SortValue = string | number | null;

interface SupplierOrdersCursor { date: string; id: string }
interface ListOptions { sort: SortField; direction: SortDirection; query: string }
export type SupplierOrdersRequest =
  | { view: "list"; after: SupplierOrdersCursor | null }
  | ({ view: "listPage"; after: { id: string; value: SortValue } | null } & ListOptions)
  | { view: "order"; id: string };

interface Summary extends SupplierOrdersCursor {
  number: string;
  supplier: string;
  buyer: string;
  amount: number | null;
  currency: string;
}
interface Product {
  name: string;
  article: string;
  quantity: number;
}
interface OrderProduct extends Product {
  stock: number;
  receipt: string;
  price: number | null;
  amount: number | null;
  returnDays: number;
  expectedDate: string | null;
}
export type SupplierOrdersResult =
  | { view: "list"; orders: Summary[]; hasMore: boolean }
  | { view: "listPage"; orders: Summary[]; hasMore: boolean; lastValue?: SortValue }
  | { view: "order"; id: string; order: (Summary & { market: boolean; contract: string; products: OrderProduct[] }) | null };

const invalid = () => new NomenclatureError(400, "invalid_supplier_orders", "Некорректные данные заказа поставщику.");

function dateTime(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(value)
    || !validCalendarDate(value.slice(0, 10))) throw invalid();
  return value;
}

export function parseSupplierOrdersRequest(pathname: string, search: URLSearchParams): SupplierOrdersRequest {
  if (pathname === "/api/purchasing/supplier-orders") {
    if ([...search.keys()].some((key) => !["after", "sort", "direction", "q"].includes(key) || search.getAll(key).length > 1)) throw invalid();
    const sort = search.get("sort") ?? "date";
    const direction = search.get("direction") ?? (sort === "date" ? "desc" : "asc");
    if (!sortFields.includes(sort as SortField) || direction !== "asc" && direction !== "desc") throw invalid();
    const query = text(search.get("q") ?? "", 100).normalize("NFC").replace(/\s+/g, " ").toLocaleLowerCase("ru-RU");
    if (query.length > 100) throw invalid();
    const cursor = search.get("after");
    if (query || sort !== "date" || direction !== "desc") {
      const options: ListOptions = { sort: sort as SortField, direction, query };
      return { view: "listPage", ...options, after: cursor === null ? null : decodeCursor(cursor, options) };
    }
    if (cursor === null) return { view: "list", after: null };
    const parts = cursor.split(".");
    if (parts.length !== 2) throw invalid();
    return { view: "list", after: { date: dateTime(parts[0]), id: parseUuid(parts[1]) } };
  }
  const route = /^\/api\/purchasing\/supplier-orders\/([^/]+)$/.exec(pathname);
  if (!route) throw new NomenclatureError(404, "not_found", "Маршрут не найден.");
  if (search.size) throw invalid();
  return { view: "order", id: parseUuid(route[1]) };
}

function validateSortValue(value: unknown, field: SortField): SortValue {
  if (field === "date") return dateTime(value);
  if (field === "amount") return optionalNumber(value);
  if (typeof value !== "string" || value.length > (field === "number" ? 32 : 500) || value.includes("\0")) throw invalid();
  // Text keys keep the original database collation and whitespace.
  return value;
}

function decodeCursor(cursor: string, { sort, direction, query }: ListOptions) {
  if (!/^[\w-]{1,6200}$/.test(cursor)) throw invalid();
  let values: unknown;
  try { values = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); } catch { throw invalid(); }
  if (!Array.isArray(values) || values.length !== 5 || values[0] !== sort || values[1] !== direction || values[2] !== query) throw invalid();
  return { id: parseUuid(values[3]), value: validateSortValue(values[4], sort) };
}

export function supplierListCursor(read: Extract<SupplierOrdersRequest, { view: "list" | "listPage" }>,
  result: Extract<SupplierOrdersResult, { view: "list" | "listPage" }>): string | null {
  const last = result.orders.at(-1);
  if (!result.hasMore || !last) return null;
  if (read.view === "list" || result.view === "list") return `${last.date}.${last.id}`;
  return Buffer.from(JSON.stringify([read.sort, read.direction, read.query, last.id, result.lastValue])).toString("base64url");
}

export function validateSupplierOrdersResponse(read: SupplierOrdersRequest, result: SupplierOrdersResult): void {
  if (read.view !== result.view) throw invalid();
  if (read.view === "order" && result.view === "order") {
    if (read.id !== result.id) throw invalid();
    return;
  }
  if (read.view === "order" || result.view === "order") return;
  const afterId = read.after?.id;
  if (afterId && result.orders.some((order) => order.id === afterId)) throw invalid();
  const previousDate = read.view === "list" ? read.after?.date : undefined;
  if (previousDate && result.orders.some((order) => order.date > previousDate)) throw invalid();
  if (read.view === "listPage" && result.view === "listPage") {
    if (result.hasMore) validateSortValue(result.lastValue, read.sort);
    if (read.sort === "date" || read.sort === "amount") {
      const values = result.orders.map((order) => read.sort === "date" ? order.date : order.amount);
      const outOfOrder = (left: SortValue, right: SortValue) => right !== null && (left === null
        || (read.direction === "asc" ? left > right : left < right));
      if (result.hasMore && result.lastValue !== values.at(-1)
        || read.after && values.length && outOfOrder(read.after.value, values[0])
        || values.some((value, index) => index > 0 && outOfOrder(values[index - 1], value))) throw invalid();
    }
  }
}

function text(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length > maximum || /[\u0000-\u001f\u007f-\u009f]/.test(value)) throw invalid();
  return value.trim();
}
function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1e15) throw invalid();
  return value;
}
const optionalNumber = (value: unknown) => value === null ? null : number(value);

const summaryFields = ["id", "number", "date", "supplier", "buyer", "amount", "currency"];
function summary(item: Record<string, unknown>): Summary {
  return { id: parseUuid(item.id), number: text(item.number, 32), date: dateTime(item.date),
    supplier: text(item.supplier, 500), buyer: text(item.buyer, 500), amount: optionalNumber(item.amount),
    currency: text(item.currency, 3) };
}
const productFields = ["name", "article", "quantity"];
function product(item: Record<string, unknown>): Product {
  const name = text(item.name, 500);
  if (!name) throw invalid();
  return { name, article: text(item.article, 100), quantity: number(item.quantity) };
}
function products<T>(value: unknown, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > 10_000) throw invalid();
  return value.map(parse);
}

export function parseSupplierOrdersResult(value: unknown): SupplierOrdersResult {
  const data = objectFields(value, ["view", "orders", "hasMore", "id", "lastValue", "order"]);
  if (data.view === "list" || data.view === "listPage") {
    const { orders, hasMore, lastValue } = objectFields(value,
      data.view === "list" ? ["view", "orders", "hasMore"] : ["view", "orders", "hasMore", "lastValue"]);
    if (!Array.isArray(orders) || orders.length > supplierOrdersPageSize || typeof hasMore !== "boolean"
      || hasMore && orders.length !== supplierOrdersPageSize) throw invalid();
    const page = orders.map((item) => summary(objectFields(item, summaryFields)));
    if (new Set(page.map((item) => item.id)).size !== page.length) throw invalid();
    if (data.view === "list") {
      if (page.some((item, index) => index > 0 && page[index - 1].date < item.date)) throw invalid();
      return { view: "list", orders: page, hasMore };
    }
    if (!hasMore && lastValue !== undefined
      || hasMore && lastValue !== null && typeof lastValue !== "string" && typeof lastValue !== "number") throw invalid();
    return { view: "listPage", orders: page, hasMore, lastValue: lastValue as SortValue | undefined };
  }
  const id = parseUuid(data.id);
  if (data.view !== "order") throw invalid();
  objectFields(value, ["view", "id", "order"]);
  if (data.order === null) return { view: "order", id, order: null };
  const item = objectFields(data.order, [...summaryFields, "market", "contract", "products"]);
  const header = summary(item);
  if (header.id !== id || typeof item.market !== "boolean") throw invalid();
  const market = item.market;
  const lines = products(item.products, (value): OrderProduct => {
    const line = objectFields(value, [...productFields, "stock", "receipt", "price", "amount", "returnDays", "expectedDate"]);
    const price = optionalNumber(line.price);
    const amount = optionalNumber(line.amount);
    if (market && (price !== null || amount !== null) || !Number.isSafeInteger(line.returnDays) || Number(line.returnDays) < 0
      || line.expectedDate !== null && !validCalendarDate(line.expectedDate)) throw invalid();
    return { ...product(line), stock: number(line.stock), receipt: text(line.receipt, 100), price, amount,
      returnDays: Number(line.returnDays), expectedDate: line.expectedDate };
  });
  const contract = text(item.contract, 500);
  if (!market && (contract || (header.amount !== null) !== lines.some((line) => line.price !== null))) throw invalid();
  return { view: "order", id, order: { ...header, market, contract, products: lines } };
}
