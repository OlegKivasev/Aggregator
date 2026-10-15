import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { CheckoutDetails, OrderGroupResult, PartKomOrderChoices } from "../../purchasing/order-contract.ts";
import type { PurchaseLine } from "../../purchasing/purchase-offer.ts";
import type { PartKomCredentials } from "../../types.ts";
import { SupplierAuthError, SupplierIntegrationError } from "../errors.ts";
import { siteHttpRequest } from "../site-http.ts";

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
  if (response.status === 401 || response.status === 403) throw new SupplierAuthError("PartKOM rejected order credentials");
  if (response.status < 200 || response.status >= 300) throw new SupplierIntegrationError("PartKOM order request failed");
  if (!response.contentType?.toLowerCase().includes("json")) throw new SupplierIntegrationError("PartKOM order returned unsupported content type");
  try {
    const payload: unknown = JSON.parse(response.body);
    return typeof payload === "string" ? JSON.parse(payload) as unknown : payload;
  }
  catch { throw new SupplierIntegrationError("PartKOM order returned invalid JSON"); }
}

export function parsePartKomPickupChoices(payload: unknown): PartKomOrderChoices["deliveries"] {
  if (!Array.isArray(payload)) throw new SupplierIntegrationError("PartKOM pickup list is invalid");
  return payload.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const value = entry as { id?: unknown; title?: unknown; address?: unknown };
    const id = typeof value.id === "number" && Number.isSafeInteger(value.id) && value.id > 0 ? String(value.id)
      : typeof value.id === "string" && /^[1-9]\d*$/.test(value.id) ? value.id : null;
    return id && typeof value.title === "string" && value.title.trim()
      ? [{ id: `pickup:${id}`, type: "pickup" as const, point: id,
        label: `Самовывоз: ${value.title.trim()}${typeof value.address === "string" && value.address.trim() ? `, ${value.address.trim()}` : ""}` }]
      : [];
  });
}

export async function getPartKomOrderChoices(credentials: PartKomCredentials, signal: AbortSignal): Promise<PartKomOrderChoices> {
  const pickups = parsePartKomPickupChoices(await request("basket/pickup-list", credentials, signal));
  return { deliveries: [{ id: "regular", type: "regular", label: "Регулярная доставка (ближайшая волна)" }, ...pickups] };
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
  delivery: PartKomOrderChoices["deliveries"][number], attemptId: string, signal: AbortSignal): Promise<OrderGroupResult> {
  if (line.reference.supplier !== "part-kom") throw new SupplierIntegrationError("PartKOM order received another supplier's line");
  if (!Number.isSafeInteger(line.result.price)) throw new SupplierIntegrationError("PartKOM requires an integer order price");
  const selected = details.partKom;
  if (delivery.id !== selected?.deliveryId) throw new SupplierIntegrationError("PartKOM delivery choice is invalid");
  if (delivery.type === "pickup" && (typeof selected?.name !== "string" || !selected.name.trim() || selected.name.length > 100
    || typeof selected?.phone !== "string" || !/^[+\d()\s-]{6,40}$/.test(selected.phone))) {
    throw new SupplierIntegrationError("PartKOM pickup contact is invalid");
  }
  const reference = attemptId;
  const fields: Record<string, string> = {
    flagTest: "0", returnOnSuccess: "1", "orderItems[0][detailNum]": line.result.article,
    "orderItems[0][makerId]": line.reference.makerId, "orderItems[0][providerId]": line.reference.providerId,
    "orderItems[0][price]": String(line.result.price), "orderItems[0][quantity]": String(line.quantity),
    "orderItems[0][reference]": reference, "orderItems[0][reorderAgreement]": "0",
    "orderItems[0][possibleIncreasePrice]": "0", "orderItems[0][possibleIncreaseDeliveryDate]": "0",
    "orderItems[0][delivery]": delivery.type,
  };
  if (delivery.type === "pickup") {
    fields["orderItems[0][deliveryData][name]"] = selected!.name!.trim();
    fields["orderItems[0][deliveryData][phone]"] = selected!.phone!.trim();
    fields["orderItems[0][deliveryData][point]"] = delivery.point!;
  }
  await request("basket/order", credentials, signal, multipart(fields));
  for (let index = 0; index < 3; index++) {
    if (index) await delay(500 * index, undefined, { signal });
    const result = parsePartKomMotion(await request(`basket/motion/${encodeURIComponent(reference)}`, credentials, signal), line);
    if (result) return result;
  }
  throw new SupplierIntegrationError("PartKOM order status cannot be confirmed");
}
