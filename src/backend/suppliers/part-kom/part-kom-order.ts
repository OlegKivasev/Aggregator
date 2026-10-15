import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { CheckoutDetails, OrderGroupResult, PartKomOrderChoices, PartKomOrderReceipt } from "../../purchasing/order-contract.ts";
import type { PartKomHistoryItem, PartKomOrderHistory } from "../../purchasing/order-history-contract.ts";
import type { PurchaseLine } from "../../purchasing/purchase-offer.ts";
import type { PartKomCredentials } from "../../types.ts";
import { SupplierAuthError, SupplierIntegrationError } from "../errors.ts";
import { siteHttpRequest } from "../site-http.ts";
import { parsePartKomApiResponse } from "./part-kom-api-adapter.ts";

const origin = "https://ws.part-kom.ru/v4/";
const maxBytes = 5 * 1024 * 1024;
const historyLimit = 500;

async function request(path: string, credentials: PartKomCredentials, signal: AbortSignal,
  post?: { contentType: string; body: string }): Promise<unknown> {
  const url = new URL(path, origin);
  if (url.origin !== new URL(origin).origin) throw new SupplierIntegrationError("Invalid PartKOM order URL");
  const response = await siteHttpRequest(url, { signal, timeoutMs: 30_000, maxResponseBytes: maxBytes,
    method: post ? "POST" : "GET", body: post?.body,
    headers: { Accept: "application/json", Authorization: `Basic ${Buffer.from(`${credentials.login}:${credentials.password}`).toString("base64")}`,
      ...(post ? { "Content-Type": post.contentType } : {}) } });
  if (!post) return parsePartKomApiResponse(response);
  if (response.status === 401 || response.status === 403) throw new SupplierAuthError("PartKOM rejected order credentials");
  if (response.status < 200 || response.status >= 300) throw new SupplierIntegrationError("PartKOM order request failed");
  if (!response.contentType?.toLowerCase().includes("json")) throw new SupplierIntegrationError("PartKOM order returned unsupported content type");
  try {
    const payload: unknown = JSON.parse(response.body);
    return typeof payload === "string" ? JSON.parse(payload) as unknown : payload;
  }
  catch { throw new SupplierIntegrationError("PartKOM order returned invalid JSON"); }
}

export function getPartKomOrderChoices(): PartKomOrderChoices {
  return { deliveries: [{ id: "regular", type: "regular", label: "Регулярная доставка (ближайшая волна)" }] };
}

function historyText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= maxLength ? text : null;
}

function historyDate(value: unknown): string | null {
  const text = historyText(value, 32);
  const match = text?.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!match) return null;
  const [, year, month, day, hour = "00", minute = "00", second = "00"] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  return date.getFullYear() === Number(year) && date.getMonth() === Number(month) - 1 && date.getDate() === Number(day)
    && date.getHours() === Number(hour) && date.getMinutes() === Number(minute) && date.getSeconds() === Number(second) ? text : null;
}

function historyPrice(value: unknown): number | null {
  const raw = typeof value === "number" ? value : typeof value === "string" && /^\d+(?:[.,]\d{1,2})?$/.test(value.trim())
    ? Number(value.trim().replace(",", ".")) : Number.NaN;
  return Number.isFinite(raw) && raw >= 0 ? raw : null;
}

export function parsePartKomOrderHistory(payload: unknown): PartKomOrderHistory {
  if (!Array.isArray(payload) || payload.length > historyLimit) throw new SupplierIntegrationError("PartKOM order history is invalid");
  const orders = new Map<string, PartKomOrderHistory["orders"][number]>();
  for (const entry of payload) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new SupplierIntegrationError("PartKOM order history item is invalid");
    const row = entry as Record<string, unknown>;
    const number = typeof row.orderNumber === "number" && Number.isSafeInteger(row.orderNumber) && row.orderNumber > 0
      ? String(row.orderNumber) : historyText(row.orderNumber, 100);
    const article = historyText(row.detailNum, 128);
    const quantity = row.quantity;
    if (!number || !article || typeof quantity !== "number" || !Number.isSafeInteger(quantity) || quantity < 1) {
      throw new SupplierIntegrationError("PartKOM order history item is incomplete");
    }
    const item: PartKomHistoryItem = {
      article, brand: historyText(row.maker, 200), title: historyText(row.description, 500), quantity,
      price: historyPrice(row.price), status: historyText(row.stateTxt, 300),
      expectedDate: historyDate(row.expectedDate), guaranteedDate: historyDate(row.guaranteedDate),
      warehouse: historyText(row.placement, 200),
    };
    const order = orders.get(number);
    if (order) {
      order.items.push(item);
      if (!order.date) order.date = historyDate(row.orderDate);
    } else orders.set(number, { number, date: historyDate(row.orderDate), items: [item] });
  }
  return { orders: [...orders.values()].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "")), limited: payload.length === historyLimit };
}

export async function listPartKomOrderHistory(credentials: PartKomCredentials, archive: boolean, signal: AbortSignal): Promise<PartKomOrderHistory> {
  const params = new URLSearchParams({ limit: String(historyLimit), archive: archive ? "1" : "0" });
  return parsePartKomOrderHistory(await request(`basket/motion?${params}`, credentials, signal));
}

function multipart(fields: Record<string, string>): { contentType: string; body: string } {
  const boundary = `aggregator-${randomUUID()}`;
  const body = Object.entries(fields).map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`).join("")
    + `--${boundary}--\r\n`;
  return { contentType: `multipart/form-data; boundary=${boundary}`, body };
}

export function parsePartKomMotion(payload: unknown, line: PurchaseLine): OrderGroupResult | null {
  if (!Array.isArray(payload) || line.reference.supplier !== "part-kom") throw new SupplierIntegrationError("PartKOM order history is invalid");
  const matches = payload.filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry));
  if (!matches.length) return null;
  const confirmed: OrderGroupResult["confirmed"] = [];
  let total = 0;
  const orderIds: string[] = [];
  const partKomOrders: PartKomOrderReceipt[] = [];
  for (const item of matches) {
    const value = item as Record<string, unknown>;
    const id = typeof value.orderNumber === "string" || typeof value.orderNumber === "number" ? String(value.orderNumber) : "";
    const quantity = typeof value.quantity === "number" ? value.quantity : Number.NaN;
    if (!id || !Number.isSafeInteger(quantity) || quantity < 1 || value.detailNum !== line.result.article
      || String(value.providerId) !== line.reference.providerId) throw new SupplierIntegrationError("PartKOM order history does not match the requested item");
    total += quantity;
    if (!orderIds.includes(id)) orderIds.push(id);
    const receipt: PartKomOrderReceipt = { orderNumber: id, quantity };
    for (const [key, limit] of [["orderDate", 100], ["detailNum", 128], ["maker", 200], ["description", 500],
      ["stateTxt", 300], ["expectedDate", 100], ["guaranteedDate", 100], ["placement", 200], ["comment", 500]] as const) {
      const text = value[key];
      if (typeof text === "string" && text.trim() && text.length <= limit) receipt[key] = text.trim();
    }
    for (const key of ["refusalCount", "storeCount", "releaseCount"] as const) {
      const count = value[key];
      if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0 && count <= quantity) receipt[key] = count;
    }
    const rawPrice = value.price;
    const price = typeof rawPrice === "number" ? rawPrice : typeof rawPrice === "string" && /^\d+(?:[.,]\d{1,2})?$/.test(rawPrice.trim())
      ? Number(rawPrice.trim().replace(",", ".")) : Number.NaN;
    if (Number.isFinite(price) && price > 0) receipt.price = price;
    partKomOrders.push(receipt);
  }
  if (total > line.quantity) throw new SupplierIntegrationError("PartKOM confirmed too many items");
  if (total > 0) confirmed.push({ id: line.id, acceptedQuantity: total, orderIds, partKomOrders,
    ...(total < line.quantity ? { message: "PartKOM подтвердил только часть количества." } : {}) });
  return { confirmed, rejected: total === 0 ? [{ id: line.id, message: "PartKOM не принял позицию." }] : [] };
}

export async function placePartKomOrder(line: PurchaseLine, credentials: PartKomCredentials, details: CheckoutDetails,
  attemptId: string, signal: AbortSignal): Promise<OrderGroupResult> {
  if (line.reference.supplier !== "part-kom") throw new SupplierIntegrationError("PartKOM order received another supplier's line");
  if (!Number.isFinite(line.result.price) || line.result.price <= 0) throw new SupplierIntegrationError("PartKOM order price is invalid");
  if (details.partKom?.deliveryId !== "regular") throw new SupplierIntegrationError("PartKOM delivery choice is invalid");
  const reference = attemptId;
  const fields: Record<string, string> = {
    flagTest: "0", returnOnSuccess: "1", "orderItems[0][detailNum]": line.result.article,
    "orderItems[0][makerId]": line.reference.makerId, "orderItems[0][providerId]": line.reference.providerId,
    "orderItems[0][price]": String(line.result.price), "orderItems[0][quantity]": String(line.quantity),
    "orderItems[0][reference]": reference, "orderItems[0][reorderAgreement]": "0",
    "orderItems[0][possibleIncreasePrice]": "0", "orderItems[0][possibleIncreaseDeliveryDate]": "0",
    "orderItems[0][delivery]": "regular",
  };
  await request("basket/order", credentials, signal, multipart(fields));
  for (let index = 0; index < 3; index++) {
    if (index) await delay(500 * index, undefined, { signal });
    const result = parsePartKomMotion(await request(`basket/motion/${encodeURIComponent(reference)}`, credentials, signal), line);
    if (result) return result;
  }
  throw new SupplierIntegrationError("PartKOM order status cannot be confirmed");
}
