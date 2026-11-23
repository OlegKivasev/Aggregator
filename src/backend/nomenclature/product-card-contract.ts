import { NomenclatureError, objectFields, parseUuid } from "./contract.ts";
import { validCalendarDate } from "./incoming-contract.ts";
import { parseStockDetails } from "./stock-details.ts";
import { repairProductForUser } from "../repairs/repair-details.ts";

type Period = { from: string; to: string };
export type ProductCardRequest = { id: string; testPlatform?: boolean } & (
  { view: "card" | "preview" | "details" } | { view: "history"; period: Period });

const invalid = (): never => { throw new NomenclatureError(400, "invalid_product_card", "Некорректные данные карточки товара."); };
const label = (value: unknown, max = 500) => {
  if (typeof value !== "string" || value.length > max || /[\u0000-\u001f\u007f-\u009f]/.test(value)) return invalid();
  return value.trim();
};
const number = (value: unknown, min = -1e15, max = 1e15) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) return invalid();
  return value;
};
const rows = <T>(value: unknown, limit: number, parse: (row: unknown) => T): T[] => {
  if (!Array.isArray(value) || value.length > limit) return invalid();
  return value.map(parse);
};
function period(from: unknown, to: unknown): Period {
  if (typeof from !== "string" || typeof to !== "string" || !validCalendarDate(from) || !validCalendarDate(to) || from > to) return invalid();
  return { from, to };
}

export function parseProductCardRequest(id: string, params: URLSearchParams, testPlatform?: boolean): ProductCardRequest {
  const scope = { id: parseUuid(id), ...(testPlatform === undefined ? {} : { testPlatform }) };
  if (!params.size) return { ...scope, view: "card" };
  if (params.size === 1 && params.get("details") === "1") return { ...scope, view: "details" };
  if (params.size !== 2 || !params.has("from") || !params.has("to")) return invalid();
  return { ...scope, view: "history", period: period(params.get("from"), params.get("to")) };
}

function photo(value: unknown) {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 2_796_204 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return invalid();
  const bytes = Buffer.from(value.slice(0, 16), "base64");
  const hex = bytes.toString("hex");
  const type = hex.startsWith("89504e470d0a1a0a") ? "png" : hex.startsWith("ffd8ff") ? "jpeg"
    : /^474946383[79]61/.test(hex) ? "gif"
    : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" ? "webp" : null;
  return type ? `data:image/${type};base64,${value}` : null;
}

const detailFields = ["image", "incoming", "monthlySales", "average", "recommendation"];
function parseDetails(fields: Record<string, unknown>) {
  const incoming = fields.incoming === null ? null : objectFields(fields.incoming, ["original", "replacement"]);
  return {
    image: photo(fields.image),
    incoming: incoming && { original: number(incoming.original, 0), replacement: number(incoming.replacement, 0) },
    monthlySales: fields.monthlySales === null ? null : rows(fields.monthlySales, 5, (value) => {
      const { month, quantity } = objectFields(value, ["month", "quantity"]);
      if (typeof month !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return invalid();
      return { month, quantity: number(quantity) };
    }),
    average: fields.average === null ? null : number(fields.average),
    recommendation: fields.recommendation === null ? null : number(fields.recommendation, 0),
  };
}

function parseCard(value: unknown) {
  const fields = objectFields(value, ["name", "article", "brand", "category", "unit", "stock", "stockDetails",
    ...detailFields, "period", "prices", "oem", "applicability", "replacements", "detailsPending", "priceTypes", "defaultPriceTypes"]);
  const stock = number(fields.stock, 0);
  const dates = objectFields(fields.period, ["from", "to"]);
  if (fields.detailsPending !== undefined && typeof fields.detailsPending !== "boolean") return invalid();
  return {
    name: label(fields.name), article: label(fields.article, 100), brand: label(fields.brand, 150), category: label(fields.category, 150),
    unit: label(fields.unit, 100), stock, stockDetails: parseStockDetails(fields.stockDetails, stock, invalid),
    ...parseDetails(fields),
    ...(fields.detailsPending === undefined ? {} : { detailsPending: fields.detailsPending }),
    ...(fields.priceTypes === undefined ? {} : { priceTypes: rows(fields.priceTypes, 1000, (value) => {
      const row = objectFields(value, ["id", "name"]);
      return { id: parseUuid(row.id), name: label(row.name, 150) };
    }) }),
    ...(fields.defaultPriceTypes === undefined ? {} : { defaultPriceTypes: rows(fields.defaultPriceTypes, 3, parseUuid) }),
    period: period(dates.from, dates.to),
    prices: rows(fields.prices, 5000, (value) => {
      const row = objectFields(value, ["typeId", "name", "characteristic", "unit", "amount", "currency", "primary"]);
      const currency = label(row.currency, 3);
      if (!/^[A-Z]{3}$/.test(currency) || typeof row.primary !== "boolean") return invalid();
      return { ...(row.typeId === undefined ? {} : { typeId: parseUuid(row.typeId) }),
        name: label(row.name, 150), characteristic: label(row.characteristic, 150), unit: label(row.unit, 100),
        amount: number(row.amount, 0, 1e12), currency, primary: row.primary };
    }),
    oem: rows(fields.oem, 10000, (value) => {
      const { article, make } = objectFields(value, ["article", "make"]);
      return { article: label(article, 150), make: label(make, 150) };
    }),
    applicability: rows(fields.applicability, 10000, (value) => {
      const row = objectFields(value, ["make", "model", "from", "to", "body", "bodyCode", "engine", "engineCode", "note"]);
      return { make: label(row.make, 150), model: label(row.model, 300), from: label(row.from, 10), to: label(row.to, 10),
        body: label(row.body, 150), bodyCode: label(row.bodyCode, 150), engine: label(row.engine, 100),
        engineCode: label(row.engineCode, 150), note: label(row.note) };
    }),
    replacements: rows(fields.replacements, 10000, (value) => {
      const row = objectFields(value, ["id", "name", "article", "brand"]);
      return { id: parseUuid(row.id), name: label(row.name), article: label(row.article, 100), brand: label(row.brand, 150) };
    }),
  };
}

function parseHistory(value: unknown) {
  const result = objectFields(value, ["rows", "hasMore"]);
  if (typeof result.hasMore !== "boolean") return invalid();
  return { hasMore: result.hasMore, rows: rows(result.rows, 500, (value) => {
    const row = objectFields(value, ["date", "operation", "document", "quantity"]);
    const date = label(row.date, 19);
    if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(date) || !validCalendarDate(date.slice(0, 10))) return invalid();
    return { date, operation: label(row.operation, 150), document: label(row.document), quantity: number(row.quantity) };
  }) };
}

export function parseProductCardResult(value: unknown) {
  const { id, view, data } = objectFields(value, ["id", "view", "data"]);
  if (view === "card" || view === "preview") return { id: parseUuid(id), view, data: data === null ? null : parseCard(data) } as const;
  if (view === "details") return { id: parseUuid(id), view, data: data === null ? null : parseDetails(objectFields(data, detailFields)) } as const;
  if (view === "history") return { id: parseUuid(id), view, data: data === null ? null : parseHistory(data) } as const;
  return invalid();
}

export type ProductCardResult = ReturnType<typeof parseProductCardResult>;

export function productCardForRepair(result: ProductCardResult, visibility: { hideArticle: boolean; hideBrand: boolean }) {
  if (!result.data || !(visibility.hideArticle || visibility.hideBrand) || result.view === "history") return result;
  if (result.view === "details") return { ...result, data: { ...result.data, image: null } };
  const card = result.data;
  return { ...result, data: {
    ...repairProductForUser(card, visibility), brand: visibility.hideBrand ? "" : card.brand,
    image: null, oem: visibility.hideArticle ? [] : card.oem,
    stockDetails: { ...card.stockDetails, replacements: card.stockDetails.replacements.map((row) => repairProductForUser(row, visibility)) },
    replacements: card.replacements.map((row) => ({ ...repairProductForUser(row, visibility), brand: visibility.hideBrand ? "" : row.brand })),
  } };
}
