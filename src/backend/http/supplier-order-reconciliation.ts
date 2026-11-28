import type { IncomingMessage, ServerResponse } from "node:http";
import { createBoundedAbortSignal } from "../abort.ts";
import { SupplierAuthError, SupplierIntegrationError, SupplierTimeoutError } from "../errors.ts";
import { NomenclatureError } from "../nomenclature/contract.ts";
import type { NomenclatureService } from "../nomenclature/nomenclature-service.ts";
import type { OrderHistorySupplier } from "../purchasing/order-cancellation-contract.ts";
import type { OrderFulfillment, OrderHistory, OrderHistoryItem } from "../purchasing/order-history-contract.ts";
import { compareReconciliation, parseReconciliation, reconciliationArticleKey, reconciliationBodyLimit } from "../purchasing/supplier-order-reconciliation.ts";
import type { SupplierCounterparties } from "../purchasing/supplier-counterparties.ts";
import type { AggregatorApplication } from "./create-server.ts";
import { readJsonBody, RequestBodyError } from "./request-body.ts";
import { serveJson } from "./responses.ts";

export const supplierOrderReconciliationPath = "/api/integration/1c/nomenclature/supplier-order-reconciliation";
const supplierNames: Record<OrderHistorySupplier, string> = {
  "part-kom": "PartKOM", armtek: "Armtek", "forum-auto": "Forum Auto", rossko: "Rossko", autopiter: "Автопитер",
};
const historySuppliers = Object.keys(supplierNames) as OrderHistorySupplier[];
const finishedStatuses = new Set<OrderFulfillment>(["delivered", "cancelled", "partially_cancelled", "returned"]);

interface ReconciliationScope {
  name: string;
  local: Parameters<typeof compareReconciliation>[0];
  localArticles: Set<string>;
  remote: OrderHistoryItem[];
  suppliers: OrderHistorySupplier[];
  warnings: string[];
  sourcesRead: number;
}

function mappedHistorySources(app: AggregatorApplication, counterparties: SupplierCounterparties, connectedOnly: boolean) {
  const mappings = new Map(counterparties.list().map((mapping) => [mapping.supplier, mapping]));
  const connected = new Set(connectedOnly ? app.listSupplierSessions().filter(({ authorized }) => authorized).map(({ supplier }) => supplier) : []);
  return historySuppliers.flatMap((supplier) => {
    const mapping = mappings.get(supplier);
    const hasHistory = supplier === "part-kom" ? app.partKomOrderHistory : app.supplierOrderHistory;
    return mapping && (!connectedOnly || connected.has(supplier) && hasHistory) ? [{ ...mapping, supplier }] : [];
  });
}

function collectHistory(scope: ReconciliationScope, supplier: OrderHistorySupplier, history: OrderHistory,
  from: string, to: string, activeOnly: boolean) {
  const name = supplierNames[supplier];
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const order of history.orders) {
    if (seen.has(order.number)) repeated.add(order.number);
    seen.add(order.number);
  }
  let missingDate = false;
  let incomplete = history.limited;
  let skippedRepeated = false;
  for (const order of history.orders) {
    const day = order.date?.slice(0, 10);
    if (!day) { missingDate = true; continue; }
    if (day < from || day > to) continue;
    incomplete ||= order.itemsLimited === true;
    if (repeated.has(order.number)) { skippedRepeated = true; continue; }
    for (const item of order.items) {
      if (!activeOnly || !finishedStatuses.has(item.fulfillment)
        || scope.localArticles.has(reconciliationArticleKey(item.article))) scope.remote.push(item);
    }
  }
  if (incomplete) scope.warnings.push(`${name} · история достигла предела выдачи.`);
  if (skippedRepeated) scope.warnings.push(`${name} · заказы с повторяющимися номерами пропущены.`);
  if (missingDate) scope.warnings.push(`${name} · в истории есть заказы без даты.`);
  if (!activeOnly && supplier === "forum-auto") scope.warnings.push(`${name} · API показывает только активные заказы.`);
}

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
    if (url.search) throw new NomenclatureError(400, "query", "Неизвестные параметры запроса.");
    if (request.method === "GET") {
      const ids = new Set(mappedHistorySources(app, counterparties, true).map(({ id }) => id));
      serveJson(response, 200, { counterpartyIds: [...ids] });
      return;
    }
    if (request.method !== "POST") throw new NomenclatureError(405, "method", "Метод не поддерживается.");
    if (request.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
      throw new NomenclatureError(415, "content_type", "Требуется Content-Type: application/json.");
    }
    const input = parseReconciliation(await readJsonBody(request, reconciliationBodyLimit));
    const requestedIds = input.all && input.scopeIds ? new Set(input.scopeIds) : null;
    const mappings = mappedHistorySources(app, counterparties, input.all)
      .filter(({ id }) => input.all ? !requestedIds || requestedIds.has(id) : id === input.counterpartyId);
    const local = new Map(input.counterparties.map((entry) => [entry.id, entry]));
    const scopes = new Map<string, ReconciliationScope>();
    const reads: { supplier: OrderHistorySupplier; scope: ReconciliationScope }[] = [];
    for (const { supplier, id, name } of mappings) {
      let scope = scopes.get(id);
      if (!scope) {
        const entry = local.get(id);
        const items = entry?.items ?? [];
        const localArticles = new Set<string>();
        if (input.all) {
          for (const item of items) {
            const article = item.quantity > 0 && reconciliationArticleKey(item.article);
            if (article) localArticles.add(article);
          }
        }
        scope = { name: entry?.name || name, local: items, localArticles, remote: [], suppliers: [], warnings: [], sourcesRead: 0 };
        scopes.set(id, scope);
      }
      scope.suppliers.push(supplier);
      reads.push({ supplier, scope });
    }
    if (!input.all && !reads.length) {
      throw new NomenclatureError(422, "supplier_mapping_missing", "Для этого контрагента настройте соответствие с поставщиком в агрегаторе.");
    }
    const bounded = createBoundedAbortSignal(controller.signal, 35_000, "Supplier order reconciliation timed out");
    const release = reads.length ? beginForeground() : undefined;
    let histories;
    try {
      histories = await Promise.allSettled(reads.map(async ({ supplier }) => {
        const history = supplier === "part-kom" ? await app.partKomOrderHistory?.(false, bounded.signal)
          : await app.supplierOrderHistory?.(supplier === "armtek" || supplier === "autopiter"
            ? { supplier, from: input.from, to: input.to }
            : supplier === "rossko" ? { supplier, period: { from: input.from, to: input.to } } : { supplier }, bounded.signal);
        bounded.signal.throwIfAborted();
        if (!history) throw new NomenclatureError(503, "history_unavailable", "История заказов недоступна.");
        return history;
      }));
    } finally { bounded.dispose(); release?.(); }
    if (response.destroyed) return;

    const warnings: string[] = [];
    let sourcesRead = 0;
    for (const [index, history] of histories.entries()) {
      const { supplier, scope } = reads[index];
      const name = supplierNames[supplier];
      if (history.status === "rejected") {
        const error = history.reason;
        if (!(error instanceof SupplierAuthError || error instanceof SupplierTimeoutError || error instanceof NomenclatureError)) reportError(error);
        const reason = error instanceof SupplierAuthError ? "требуется авторизация"
          : error instanceof SupplierTimeoutError ? "истекло время ожидания"
          : error instanceof SupplierIntegrationError ? error.publicMessage ?? "не удалось получить историю"
          : "не удалось получить историю";
        scope.warnings.push(`${name} · ${reason}`);
        continue;
      }
      sourcesRead++;
      scope.sourcesRead++;
      collectHistory(scope, supplier, history.value, input.from, input.to, input.all);
    }
    const rows = [];
    for (const scope of scopes.values()) {
      const names = scope.suppliers.map((supplier) => supplierNames[supplier]).join(", ");
      const label = names && scope.name && scope.name !== names ? `${scope.name} · ${names}` : scope.name || names;
      warnings.push(...scope.warnings);
      if (!input.all && !scope.sourcesRead) continue;
      const compare = compareReconciliation(scope.local, scope.remote, scope.warnings.length === 0, {
        incompleteReason: scope.warnings[0],
      });
      for (const row of compare) {
        rows.push({ ...row, supplier: label });
      }
    }
    response.setHeader("Server-Timing", `supplier-order-reconciliation;dur=${(performance.now() - started).toFixed(1)}`);
    serveJson(response, 200, { ...(input.all ? { scope: "all-active" } : {}),
      sources: reads.map(({ supplier }) => supplierNames[supplier]), sourcesRead, warnings, rows });
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
