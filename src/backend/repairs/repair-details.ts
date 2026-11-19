import { RepairValidationError } from "./repair-card.ts";
import type { RepairVisibility } from "../auth/user-position-store.ts";
import { parseStockDetails } from "../nomenclature/stock-details.ts";

function object(value: unknown, fields: string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !fields.includes(key))) invalid();
  return value as Record<string, unknown>;
}

function invalid(): never {
  throw new RepairValidationError("Некорректные данные формы заказ-наряда.");
}

function label(value: unknown, limit = 500) {
  if (typeof value !== "string" || value.length > limit) invalid();
  return value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
}

function numeric(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 9_999_999_999_999.99) invalid();
  return value;
}

function lines<T>(value: unknown, parse: (line: unknown) => T): T[] {
  if (!Array.isArray(value)) invalid();
  return value.map(parse);
}

function parseGoods(value: unknown) {
  const row = object(value, ["name", "article", "productId", "stock", "quantity", "price", "original", "replacement",
    "returnDays", "discountPercent", "discountAmount", "total", "seller", "awaitingDelivery", "stockDetails"]);
  const productId = label(row.productId, 36);
  if (productId && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(productId)) invalid();
  if (row.awaitingDelivery !== undefined && typeof row.awaitingDelivery !== "boolean") invalid();
  const stock = row.stock === null ? null : numeric(row.stock);
  const stockDetails = row.stockDetails === undefined ? undefined : parseStockDetails(row.stockDetails, stock ?? invalid(), invalid);
  return {
    name: label(row.name), article: label(row.article), productId,
    stock, quantity: numeric(row.quantity), price: numeric(row.price),
    ...(stockDetails === undefined ? {} : { stockDetails }),
    original: numeric(row.original), replacement: numeric(row.replacement),
    returnDays: row.returnDays === null ? null : Math.max(0, numeric(row.returnDays)),
    discountPercent: numeric(row.discountPercent), discountAmount: numeric(row.discountAmount),
    total: numeric(row.total), seller: label(row.seller),
    ...(row.awaitingDelivery === undefined ? {} : { awaitingDelivery: row.awaitingDelivery }),
  };
}

function parseWork(value: unknown) {
  const row = object(value, ["name", "performer", "price", "hours", "multiplier", "total", "seller"]);
  return {
    name: label(row.name), performer: label(row.performer), price: numeric(row.price),
    hours: numeric(row.hours), multiplier: numeric(row.multiplier), total: numeric(row.total), seller: label(row.seller),
  };
}

export function parseRepairDetails(value: unknown) {
  const data = object(value, ["customer", "contract", "mileage", "vin", "keySlot", "cashPayment", "goods", "work",
    "total", "cashTotal", "cardTotal", "paidAmount", "discountAmount", "discountPercent"]);
  if (typeof data.cashPayment !== "boolean") invalid();
  return {
    customer: label(data.customer), contract: label(data.contract), mileage: numeric(data.mileage),
    vin: label(data.vin, 100), keySlot: numeric(data.keySlot), cashPayment: data.cashPayment,
    goods: lines(data.goods, parseGoods), work: lines(data.work, parseWork), total: numeric(data.total),
    cashTotal: data.cashTotal === null ? null : numeric(data.cashTotal),
    ...(data.cardTotal === undefined ? {} : { cardTotal: data.cardTotal === null ? null : numeric(data.cardTotal) }),
    ...(data.paidAmount === undefined ? {} : { paidAmount: numeric(data.paidAmount) }),
    discountAmount: numeric(data.discountAmount), discountPercent: numeric(data.discountPercent),
  };
}

export type RepairDetails = ReturnType<typeof parseRepairDetails>;

export function repairProductForUser<T extends { name: string; article: string }>(row: T, visibility: RepairVisibility): T {
  const separator = visibility.hideBrand ? row.name.indexOf("|") : -1;
  return {
    ...row,
    name: separator < 0 ? row.name : row.name.slice(0, separator).trimEnd(),
    article: visibility.hideArticle ? "" : row.article,
  };
}

export function repairDetailsForUser(details: RepairDetails, visibility?: RepairVisibility) {
  if (!visibility || (!visibility.hideArticle && !visibility.hideBrand)) return details;
  return {
    ...details,
    ...(visibility.hideArticle ? { hideArticles: true } : {}),
    goods: details.goods.map((row) => {
      const product = repairProductForUser(row, visibility);
      if (row.stockDetails) product.stockDetails = {
        ...row.stockDetails,
        replacements: row.stockDetails.replacements.map((line) => repairProductForUser(line, visibility)),
      };
      return product;
    }),
  };
}
