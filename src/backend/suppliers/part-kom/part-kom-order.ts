import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { CheckoutDetails, OrderGroupResult, PartKomOrderChoices } from "../../purchasing/order-contract.ts";
import type { PurchaseLine } from "../../purchasing/purchase-offer.ts";
import type { PartKomCredentials } from "../../types.ts";
import { SupplierAuthError, SupplierIntegrationError } from "../errors.ts";
import { siteHttpRequest } from "../site-http.ts";
import { parsePartKomApiResponse } from "./part-kom-api-adapter.ts";

const origin = "https://ws.part-kom.ru/v4/";
const maxBytes = 5 * 1024 * 1024;

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
  for (const item of matches) {
    const value = item as Record<string, unknown>;
    const id = typeof value.orderNumber === "string" || typeof value.orderNumber === "number" ? String(value.orderNumber) : "";
    const quantity = typeof value.quantity === "number" ? value.quantity : Number.NaN;
    if (!id || !Number.isSafeInteger(quantity) || quantity < 1 || value.detailNum !== line.result.article
      || String(value.providerId) !== line.reference.providerId) throw new SupplierIntegrationError("PartKOM order history does not match the requested item");
    total += quantity;
    if (!orderIds.includes(id)) orderIds.push(id);
  }
  if (total > line.quantity) throw new SupplierIntegrationError("PartKOM confirmed too many items");
  if (total > 0) confirmed.push({ id: line.id, acceptedQuantity: total, orderIds,
    ...(total < line.quantity ? { message: "PartKOM подтвердил только часть количества." } : {}) });
  return { confirmed, rejected: total === 0 ? [{ id: line.id, message: "PartKOM не принял позицию." }] : [] };
}

export async function placePartKomOrder(line: PurchaseLine, credentials: PartKomCredentials, details: CheckoutDetails,
  attemptId: string, signal: AbortSignal): Promise<OrderGroupResult> {
  if (line.reference.supplier !== "part-kom") throw new SupplierIntegrationError("PartKOM order received another supplier's line");
  if (!Number.isSafeInteger(line.result.price)) throw new SupplierIntegrationError("PartKOM requires an integer order price");
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
