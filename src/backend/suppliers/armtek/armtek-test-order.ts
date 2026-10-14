import type { ArmtekCredentials } from "../../types.ts";
import { SupplierIntegrationError } from "../errors.ts";
import type { PurchaseLine, TestOrderLineResult } from "../../purchasing/purchase-offer.ts";
import { requestArmtek, resolveArmtekConfig, type ArmtekResolvedConfig } from "./armtek-api-adapter.ts";

export function buildArmtekTestOrderParams(config: ArmtekResolvedConfig, lines: PurchaseLine[]): URLSearchParams {
  const params = new URLSearchParams({ VKORG: config.vkorg, KUNRG: config.kunnrRg, DBTYP: "3" });
  if (config.kunnrZa) params.set("KUNZA", config.kunnrZa);
  if (config.incoterms) params.set("INCOTERMS", config.incoterms);
  if (config.vbeln) params.set("VBELN", config.vbeln);
  lines.forEach((line, index) => {
    if (line.reference.supplier !== "armtek") throw new SupplierIntegrationError("Armtek purchase reference mismatch");
    for (const [name, value] of Object.entries({ PIN: line.result.article, BRAND: line.result.brand,
      KWMENG: String(line.quantity), KEYZAK: line.reference.keyzak, PRICEMAX: String(line.result.price), COMPL_DLV: "1" })) {
      params.set(`ITEMS[${index}][${name}]`, value);
    }
  });
  return params;
}

const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : null;
const number = (value: unknown): number | null => {
  if (typeof value !== "number" && (typeof value !== "string" || !/^\d+(?:[.,]\d+)?$/.test(value.trim()))) return null;
  const parsed = Number(typeof value === "string" ? value.replace(",", ".") : value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};
const hasError = (value: unknown): boolean => value !== undefined && value !== null && value !== "" && value !== "0" && value !== 0;

export function parseArmtekTestOrderResponse(payload: unknown, lines: PurchaseLine[]): TestOrderLineResult[] {
  const items = record(payload)?.ITEMS;
  if (!Array.isArray(items)) throw new SupplierIntegrationError("Armtek returned an invalid test order response");
  return lines.map((line) => {
    const unconfirmed: TestOrderLineResult = { id: line.id, status: "unconfirmed", acceptedQuantity: null,
      message: "Armtek не подтвердил проверку этой позиции." };
    if (line.reference.supplier !== "armtek") return unconfirmed;
    const keyzak = line.reference.keyzak;
    const matches = items.map(record).filter((item) => item?.PIN === line.result.article && item.BRAND === line.result.brand && item.KEYZAK === keyzak);
    if (matches.length !== 1) return unconfirmed;
    const item = matches[0]!;
    if (hasError(item.ERROR)) return { ...unconfirmed, status: "rejected", message: "Armtek отклонил позицию. Проверьте цену и остаток новым поиском." };
    const remaining = number(item.REMAIN);
    const requested = number(item.KWMENG);
    if (remaining === null || requested !== line.quantity || remaining > line.quantity || !Array.isArray(item.RESULT)) return unconfirmed;
    let accepted = 0;
    for (const raw of item.RESULT) {
      const allocation = record(raw);
      const quantity = number(allocation?.KWMENG);
      const price = number(allocation?.PRICE);
      if (!allocation || quantity === null || price === null || price <= 0 || price > line.result.price + 0.005
        || allocation.KEYZAK !== keyzak || hasError(allocation.ERROR)) return unconfirmed;
      accepted += quantity;
    }
    if (accepted + remaining !== line.quantity) return unconfirmed;
    if (remaining > 0) return { id: line.id, status: "rejected", acceptedQuantity: accepted,
      message: `Проверка подтвердила ${accepted} из ${line.quantity} шт. Обновите остаток.` };
    return { id: line.id, status: "accepted", acceptedQuantity: accepted, message: "Тестовая проверка пройдена." };
  });
}

export async function testArmtekOrder(credentials: ArmtekCredentials, lines: PurchaseLine[], signal: AbortSignal,
  api = { resolveConfig: resolveArmtekConfig, request: requestArmtek }): Promise<TestOrderLineResult[]> {
  const config = await api.resolveConfig(credentials, signal);
  const response = await api.request<unknown>("ws_order/createTestOrder", credentials,
    { method: "POST", params: buildArmtekTestOrderParams(config, lines), signal });
  return parseArmtekTestOrderResponse(response, lines);
}
