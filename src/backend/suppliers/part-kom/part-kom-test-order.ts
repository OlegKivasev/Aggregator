import type { PartKomCredentials } from "../../types.ts";
import type { PurchaseLine, TestOrderLineResult } from "../../purchasing/purchase-offer.ts";
import { SupplierAuthError, SupplierIntegrationError } from "../errors.ts";
import { siteHttpRequest, type SiteHttpResponse } from "../site-http.ts";

export function buildPartKomTestOrderForm(lines: PurchaseLine[]): FormData {
  const form = new FormData();
  form.set("flagTest", "1");
  form.set("returnOnSuccess", "1");
  lines.forEach((line, index) => {
    if (line.reference.supplier !== "part-kom") throw new SupplierIntegrationError("PartKOM purchase reference mismatch");
    for (const [name, value] of Object.entries({ detailNum: line.result.article, makerId: line.reference.makerId,
      providerId: line.reference.providerId, price: String(line.result.price), quantity: String(line.quantity),
      reference: line.id, reorderAgreement: "0", delivery: "regular" })) {
      form.set(`orderItems[${index}][${name}]`, value);
    }
  });
  return form;
}

export function parsePartKomTestOrderResponse(response: SiteHttpResponse, lines: PurchaseLine[]): TestOrderLineResult[] {
  if (response.status === 401 || response.status === 403) throw new SupplierAuthError("PartKOM test order authorization failed");
  if (response.status < 200 || response.status >= 300) throw new SupplierIntegrationError("PartKOM test order HTTP error");
  // PartKOM documents JSON strings and also uses non-standard media types in v4 responses.
  // Validate the bounded body itself, as the existing PartKOM search boundary does.
  try { JSON.parse(response.body.replace(/^\uFEFF/, "")); }
  catch { throw new SupplierIntegrationError("PartKOM test order returned invalid JSON"); }
  // The supplied v4 order contract has no response schema. Never infer acceptance from HTTP 200.
  return lines.map((line) => ({ id: line.id, status: "unconfirmed", acceptedQuantity: null,
    message: "PartKOM ответил на тестовый запрос. Результат не подтверждён: требуется схема ответа поставщика." }));
}

export async function testPartKomOrder(credentials: PartKomCredentials, lines: PurchaseLine[], signal: AbortSignal,
  requestHttp: typeof siteHttpRequest = siteHttpRequest): Promise<TestOrderLineResult[]> {
  const url = new URL("https://ws.part-kom.ru/v4/basket/order");
  const request = new Request(url, { method: "POST", body: buildPartKomTestOrderForm(lines) });
  const body = Buffer.from(await request.arrayBuffer()).toString("utf8");
  signal.throwIfAborted();
  const response = await requestHttp(url, {
    method: "POST", body, signal, timeoutMs: 25_000, maxResponseBytes: 5 * 1024 * 1024,
    headers: { Accept: "application/json", "Content-Type": request.headers.get("content-type")!,
      Authorization: `Basic ${Buffer.from(`${credentials.login}:${credentials.password}`, "utf8").toString("base64")}` },
  });
  return parsePartKomTestOrderResponse(response, lines);
}
