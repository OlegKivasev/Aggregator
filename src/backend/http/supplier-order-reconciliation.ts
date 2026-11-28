import type { IncomingMessage, ServerResponse } from "node:http";
import { createBoundedAbortSignal } from "../abort.ts";
import { SupplierAuthError, SupplierIntegrationError, SupplierTimeoutError } from "../errors.ts";
import { NomenclatureError } from "../nomenclature/contract.ts";
import type { NomenclatureService } from "../nomenclature/nomenclature-service.ts";
import type { OrderHistorySupplier } from "../purchasing/order-cancellation-contract.ts";
import type { OrderHistoryItem } from "../purchasing/order-history-contract.ts";
import { compareReconciliation, parseReconciliation } from "../purchasing/supplier-order-reconciliation.ts";
import type { SupplierCounterparties } from "../purchasing/supplier-counterparties.ts";
import type { AggregatorApplication } from "./create-server.ts";
import { readJsonBody, RequestBodyError } from "./request-body.ts";
import { serveJson } from "./responses.ts";

export const supplierOrderReconciliationPath = "/api/integration/1c/nomenclature/supplier-order-reconciliation";
const supplierNames: Record<OrderHistorySupplier, string> = {
  "part-kom": "PartKOM", armtek: "Armtek", "forum-auto": "Forum Auto", rossko: "Rossko", autopiter: "Автопитер",
};

export async function serveSupplierOrderReconciliation(request: IncomingMessage, response: ServerResponse, url: URL,
  app: AggregatorApplication, nomenclature: NomenclatureService, counterparties: SupplierCounterparties,
  beginForeground: () => (() => void) | undefined, reportError: (error: unknown) => void) {
  response.setHeader("Cache-Control", "no-store");
  const controller = new AbortController();
  const disconnect = () => controller.abort();
  response.once("close", disconnect);
  const started = performance.now();
  try {
    const token = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(request.headers.authorization ?? "")?.[1];
    nomenclature.authenticate(token);
    if (request.method !== "POST") throw new NomenclatureError(405, "method", "Метод не поддерживается.");
    if (url.search) throw new NomenclatureError(400, "query", "Неизвестные параметры запроса.");
    if (request.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
      throw new NomenclatureError(415, "content_type", "Требуется Content-Type: application/json.");
    }
    const input = parseReconciliation(await readJsonBody(request, 2 * 1024 * 1024));
    const suppliers = counterparties.list().filter(({ id, supplier }) => id === input.counterpartyId && Object.hasOwn(supplierNames, supplier))
      .map(({ supplier }) => supplier as OrderHistorySupplier);
    if (!suppliers.length) {
      throw new NomenclatureError(422, "supplier_mapping_missing", "Для этого контрагента настройте соответствие с поставщиком в агрегаторе.");
    }
    const release = beginForeground();
    const bounded = createBoundedAbortSignal(controller.signal, 35_000, "Supplier order reconciliation timed out");
    let histories;
    try {
      histories = await Promise.allSettled(suppliers.map(async (supplier) => {
        const history = supplier === "part-kom" ? await app.partKomOrderHistory?.(false, bounded.signal)
          : await app.supplierOrderHistory?.(supplier === "armtek" || supplier === "autopiter"
            ? { supplier, from: input.from, to: input.to } : { supplier }, bounded.signal);
        bounded.signal.throwIfAborted();
        if (!history) throw new NomenclatureError(503, "history_unavailable", "История заказов недоступна.");
        return history;
      }));
    } finally { bounded.dispose(); release?.(); }
    if (response.destroyed) return;

    const items: OrderHistoryItem[] = [];
    const warnings: string[] = [];
    let sourcesRead = 0;
    for (const [index, history] of histories.entries()) {
      const supplier = suppliers[index];
      const name = supplierNames[supplier];
      if (history.status === "rejected") {
        const error = history.reason;
        if (!(error instanceof SupplierAuthError || error instanceof SupplierTimeoutError || error instanceof NomenclatureError)) reportError(error);
        const reason = error instanceof SupplierAuthError ? "требуется авторизация"
          : error instanceof SupplierTimeoutError ? "истекло время ожидания"
          : error instanceof SupplierIntegrationError ? error.publicMessage ?? "не удалось получить историю"
          : "не удалось получить историю";
        warnings.push(`${name} · ${reason}`);
        continue;
      }
      sourcesRead++;
      const { orders, limited } = history.value;
      const seen = new Set<string>();
      const repeated = new Set<string>();
      for (const order of orders) {
        if (seen.has(order.number)) repeated.add(order.number);
        seen.add(order.number);
      }
      let missingDate = false;
      let incomplete = limited;
      for (const order of orders) {
        const day = order.date?.slice(0, 10);
        if (!day) { missingDate = true; continue; }
        if (day >= input.from && day <= input.to) {
          incomplete ||= order.itemsLimited === true;
          if (repeated.has(order.number)) continue;
          for (const item of order.items) items.push(item);
        }
      }
      if (incomplete) warnings.push(`${name} · история достигла предела выдачи.`);
      if (repeated.size) warnings.push(`${name} · заказы с повторяющимися номерами пропущены.`);
      if (missingDate) warnings.push(`${name} · в истории есть заказы без даты.`);
      if (supplier === "forum-auto") warnings.push(`${name} · API показывает только активные заказы.`);
    }
    const rows = sourcesRead ? compareReconciliation(input.items, items, warnings.length === 0) : [];
    response.setHeader("Server-Timing", `supplier-order-reconciliation;dur=${(performance.now() - started).toFixed(1)}`);
    serveJson(response, 200, { sources: suppliers.map((supplier) => supplierNames[supplier]), sourcesRead, warnings, rows });
  } catch (error) {
    if (response.destroyed) return;
    if (error instanceof NomenclatureError || error instanceof RequestBodyError) {
      serveJson(response, error.statusCode, { message: error.message });
    } else {
      reportError(error);
      serveJson(response, 500, { message: "Не удалось выполнить сверку заказа поставщику." });
    }
  } finally { response.removeListener("close", disconnect); }
}
