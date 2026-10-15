import type { PurchaseLine } from "../../purchasing/purchase-offer.ts";
import type { OrderGroupResult } from "../../purchasing/order-contract.ts";
import type { ArmtekCredentials } from "../../types.ts";
import { SupplierIntegrationError } from "../errors.ts";
import { requestArmtek, resolveArmtekConfig } from "./armtek-api-adapter.ts";

interface ArmtekOrderAllocation {
  KWMENG?: unknown;
  VBELN?: unknown;
  KEYZAK?: unknown;
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
      for (const raw of allocations) {
        const allocation = raw as ArmtekOrderAllocation | null;
        const quantity = nonNegativeInteger(allocation?.KWMENG);
        const orderId = typeof allocation?.VBELN === "string" ? allocation.VBELN.trim() : "";
        if (quantity === null || quantity < 1 || !orderId || allocation?.KEYZAK !== line.reference.keyzak) {
          throw new SupplierIntegrationError("Armtek order allocation is incomplete");
        }
        allocated += quantity;
        if (!orderIds.includes(orderId)) orderIds.push(orderId);
      }
      if (allocated !== acceptedQuantity) throw new SupplierIntegrationError("Armtek order allocation quantity does not match");
      confirmed.push({ id: line.id, acceptedQuantity, orderIds,
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
  return parseArmtekOrderResult(result, lines);
}
