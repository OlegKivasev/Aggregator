import type { PurchaseLine } from "../../purchasing/purchase-offer.ts";
import type { ArmtekOrderReceipt, OrderGroupResult } from "../../purchasing/order-contract.ts";
import type { ArmtekCredentials } from "../../types.ts";
import { createBoundedAbortSignal } from "../../abort.ts";
import { SupplierIntegrationError } from "../errors.ts";
import { requestArmtek, resolveArmtekConfig } from "./armtek-api-adapter.ts";

interface ArmtekOrderAllocation {
  KWMENG?: unknown;
  VBELN?: unknown;
  KEYZAK?: unknown;
  PRICE?: unknown;
  DLVDT?: unknown;
}

interface ArmtekOrderItem {
  PIN?: unknown;
  BRAND?: unknown;
  KEYZAK?: unknown;
  REMAIN?: unknown;
  ERROR?: unknown;
  RESULT?: unknown;
}

function array(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return [value];
  return [];
}

function nonNegativeInteger(value: unknown): number | null {
  const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof number === "number" && Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function positivePrice(value: unknown): number | undefined {
  const number = typeof value === "string" && /^\d+(?:[.,]\d{1,2})?$/.test(value.trim())
    ? Number(value.trim().replace(",", ".")) : value;
  return typeof number === "number" && Number.isFinite(number) && number > 0 ? number : undefined;
}

function shortText(value: unknown, max = 100): string | undefined {
  return typeof value === "string" && value.trim() && value.length <= max ? value.trim() : undefined;
}

function armtekDate(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{14}$/.test(value)) return undefined;
  const [year, month, day, hour, minute, second] = [value.slice(0, 4), value.slice(4, 6), value.slice(6, 8),
    value.slice(8, 10), value.slice(10, 12), value.slice(12, 14)].map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day
    || date.getUTCHours() !== hour || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) return undefined;
  return `${value.slice(6, 8)}.${value.slice(4, 6)}.${value.slice(0, 4)} ${value.slice(8, 10)}:${value.slice(10, 12)}`;
}

export function parseArmtekOrderDetails(payload: unknown, receipt: ArmtekOrderReceipt, line: PurchaseLine): ArmtekOrderReceipt {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return receipt;
  const response = payload as { HEADER?: unknown; ITEMS?: unknown };
  const header = array(response.HEADER).find((value) => value && typeof value === "object" && !Array.isArray(value)
    && (value as { ORDER?: unknown }).ORDER === receipt.orderId) as Record<string, unknown> | undefined;
  if (!header) return receipt;
  const item = array(response.ITEMS).find((value) => value && typeof value === "object" && !Array.isArray(value)
    && (value as { PIN?: unknown; BRAND?: unknown }).PIN === line.result.article
    && (value as { PIN?: unknown; BRAND?: unknown }).BRAND === line.result.brand) as Record<string, unknown> | undefined;
  return { ...receipt,
    ...(shortText(header.ORDER_STATUS) ? { status: shortText(header.ORDER_STATUS) } : {}),
    ...(armtekDate(header.ORDER_DATE) ? { createdAt: armtekDate(header.ORDER_DATE) } : {}),
    ...(shortText(header.INCOTERMS_TXT) ? { deliveryType: shortText(header.INCOTERMS_TXT) } : {}),
    ...(shortText(header.ADDRZA) ? { deliveryAddress: shortText(header.ADDRZA) } : {}),
    ...(positivePrice(header.ORDER_SUM) ? { total: positivePrice(header.ORDER_SUM) } : {}),
    ...(item && shortText(item.STATUS) ? { itemStatus: shortText(item.STATUS) } : {}),
  };
}

export function parseArmtekOrderResult(payload: unknown, lines: PurchaseLine[]): OrderGroupResult {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new SupplierIntegrationError("Armtek order response is invalid");
  const items = (payload as { ITEMS?: unknown }).ITEMS;
  const records = array(items);
  if (records.length !== lines.length) throw new SupplierIntegrationError("Armtek order response has unexpected line count");
  const confirmed: OrderGroupResult["confirmed"] = [];
  const rejected: OrderGroupResult["rejected"] = [];
  for (const [index, line] of lines.entries()) {
    if (line.reference.supplier !== "armtek") throw new SupplierIntegrationError("Armtek order line has invalid supplier");
    const item = records[index] as ArmtekOrderItem | null;
    if (!item || typeof item !== "object" || item.PIN !== line.result.article || item.BRAND !== line.result.brand
      || item.KEYZAK !== line.reference.keyzak) throw new SupplierIntegrationError("Armtek order response line does not match request");
    const remain = nonNegativeInteger(item.REMAIN);
    if (remain === null || remain > line.quantity) throw new SupplierIntegrationError("Armtek order response has invalid remainder");
    const acceptedQuantity = line.quantity - remain;
    const allocations = array(item.RESULT);
    if (acceptedQuantity > 0) {
      let allocated = 0;
      const orderIds: string[] = [];
      const armtekOrders: ArmtekOrderReceipt[] = [];
      for (const raw of allocations) {
        const allocation = raw as ArmtekOrderAllocation | null;
        const quantity = nonNegativeInteger(allocation?.KWMENG);
        const orderId = typeof allocation?.VBELN === "string" ? allocation.VBELN.trim() : "";
        if (quantity === null || quantity < 1 || !orderId || allocation?.KEYZAK !== line.reference.keyzak) {
          throw new SupplierIntegrationError("Armtek order allocation is incomplete");
        }
        allocated += quantity;
        if (!orderIds.includes(orderId)) orderIds.push(orderId);
        const price = positivePrice(allocation?.PRICE);
        armtekOrders.push({ orderId, quantity,
          ...(price ? { price } : {}),
          ...(armtekDate(allocation?.DLVDT) ? { deliveryAt: armtekDate(allocation?.DLVDT) } : {}) });
      }
      if (allocated !== acceptedQuantity) throw new SupplierIntegrationError("Armtek order allocation quantity does not match");
      confirmed.push({ id: line.id, acceptedQuantity, orderIds, armtekOrders,
        ...(remain > 0 ? { message: "Armtek подтвердил только часть запрошенного количества." } : {}) });
    }
    if (remain > 0 && acceptedQuantity === 0) rejected.push({ id: line.id, message: "Armtek не подтвердил запрошенное количество." });
  }
  return { confirmed, rejected };
}

export async function placeArmtekOrder(lines: PurchaseLine[], credentials: ArmtekCredentials, signal: AbortSignal): Promise<OrderGroupResult> {
  const resolved = await resolveArmtekConfig(credentials, signal);
  const params = new URLSearchParams({ VKORG: resolved.vkorg, KUNRG: resolved.kunnrRg, DBTYP: "3" });
  if (resolved.kunnrZa) params.set("KUNZA", resolved.kunnrZa);
  if (resolved.incoterms) params.set("INCOTERMS", resolved.incoterms);
  if (resolved.vbeln) params.set("VBELN", resolved.vbeln);
  for (const [index, line] of lines.entries()) {
    if (line.reference.supplier !== "armtek") throw new SupplierIntegrationError("Armtek order received another supplier's line");
    const prefix = `ITEMS[${index}]`;
    params.set(`${prefix}[PIN]`, line.result.article);
    params.set(`${prefix}[BRAND]`, line.result.brand);
    params.set(`${prefix}[KWMENG]`, String(line.quantity));
    params.set(`${prefix}[KEYZAK]`, line.reference.keyzak);
    params.set(`${prefix}[PRICEMAX]`, String(line.result.price));
  }
  const result = await requestArmtek<unknown>("ws_order/createOrder", credentials, { method: "POST", params, signal });
  const parsed = parseArmtekOrderResult(result, lines);
  const byId = new Map(lines.map((line) => [line.id, line]));
  const detailsByOrder = new Map<string, unknown>();
  const detailSignal = createBoundedAbortSignal(signal, 5_000, "Armtek order details timed out");
  try {
    for (const confirmed of parsed.confirmed) {
      const line = byId.get(confirmed.id);
      if (!line) continue;
      for (const receipt of confirmed.armtekOrders ?? []) {
        try {
          let order = detailsByOrder.get(receipt.orderId);
          if (!order) {
            order = await requestArmtek<unknown>("ws_order/getOrder", credentials, { method: "GET",
              params: new URLSearchParams({ VKORG: resolved.vkorg, KUNRG: resolved.kunnrRg, ORDER: receipt.orderId }),
              signal: detailSignal.signal });
            detailsByOrder.set(receipt.orderId, order);
          }
          Object.assign(receipt, parseArmtekOrderDetails(order, receipt, line));
        } catch {
          // Creation has already been confirmed; optional read-only details must not turn it into a failed order.
        }
      }
    }
  } finally { detailSignal.dispose(); }
  return parsed;
}
