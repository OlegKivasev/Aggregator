import { NomenclatureError, objectFields, parseUuid } from "../nomenclature/contract.ts";
import { validCalendarDate } from "../nomenclature/incoming-contract.ts";

export const supplierOrdersPageSize = 50;

export interface SupplierOrdersCursor { date: string; id: string }
export type SupplierOrdersRequest =
  | { view: "list"; after: SupplierOrdersCursor | null }
  | { view: "preview" | "order"; id: string };

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
  | { view: "preview"; id: string; products: Product[] | null }
  | { view: "order"; id: string; order: (Summary & { market: boolean; contract: string; products: OrderProduct[] }) | null };

const invalid = () => new NomenclatureError(400, "invalid_supplier_orders", "Некорректные данные заказа поставщику.");

function dateTime(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(value)
    || !validCalendarDate(value.slice(0, 10))) throw invalid();
  return value;
}

export function parseSupplierOrdersRequest(pathname: string, search: URLSearchParams): SupplierOrdersRequest {
  if (pathname === "/api/purchasing/supplier-orders") {
    if ([...search.keys()].some((key) => key !== "after") || search.getAll("after").length > 1) throw invalid();
    const cursor = search.get("after");
    if (cursor === null) return { view: "list", after: null };
    const parts = cursor.split(".");
    if (parts.length !== 2) throw invalid();
    return { view: "list", after: { date: dateTime(parts[0]), id: parseUuid(parts[1]) } };
  }
  const route = /^\/api\/purchasing\/supplier-orders\/([^/]+)(\/preview)?$/.exec(pathname);
  if (!route) throw new NomenclatureError(404, "not_found", "Маршрут не найден.");
  if (search.size) throw invalid();
  return { view: route[2] ? "preview" : "order", id: parseUuid(route[1]) };
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
  const data = objectFields(value, ["view", "orders", "hasMore", "id", "products", "order"]);
  if (data.view === "list") {
    const { orders, hasMore } = objectFields(value, ["view", "orders", "hasMore"]);
    if (!Array.isArray(orders) || orders.length > supplierOrdersPageSize || typeof hasMore !== "boolean"
      || hasMore && orders.length !== supplierOrdersPageSize) throw invalid();
    const page = orders.map((item) => summary(objectFields(item, summaryFields)));
    if (new Set(page.map((item) => item.id)).size !== page.length
      || page.some((item, index) => index > 0 && page[index - 1].date < item.date)) throw invalid();
    return { view: "list", orders: page, hasMore };
  }
  const id = parseUuid(data.id);
  if (data.view === "preview") {
    objectFields(value, ["view", "id", "products"]);
    return { view: "preview", id, products: data.products === null ? null
      : products(data.products, (item) => product(objectFields(item, productFields))) };
  }
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
