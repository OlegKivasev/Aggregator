import type { IncomingMessage, ServerResponse } from "node:http";
import { NomenclatureError, objectFields, parseUuid } from "../nomenclature/contract.ts";
import type { NomenclatureService } from "../nomenclature/nomenclature-service.ts";
import type { OrderSupplier } from "../purchasing/order-contract.ts";
import { orderSuppliers, type SupplierCounterparties } from "../purchasing/supplier-counterparties.ts";
import { readJsonBody, RequestBodyError } from "./request-body.ts";
import { serveJson } from "./responses.ts";

const settingsPath = "/api/suppliers/onec-counterparties";
const streamPath = "/api/cart/test-order/counterparties/events";

export async function serveSupplierCounterparties(request: IncomingMessage, response: ServerResponse, url: URL,
  store: SupplierCounterparties, nomenclature: NomenclatureService, recheckAdmin: () => boolean, reportError: () => void) {
  const search = url.pathname === `${settingsPath}/search`;
  const stream = url.pathname === streamPath;
  if (!search && !stream && url.pathname !== settingsPath) return false;
  response.setHeader("Cache-Control", "no-store");
  if (request.method !== "GET" && (search || stream || request.method !== "PUT")) {
    serveJson(response, 405, { message: "Метод не поддерживается." });
    return true;
  }
  if (stream) {
    const write = (ids: Record<string, string>) => {
      if (!response.destroyed && !response.writableEnded && !response.write(`data: ${JSON.stringify(ids)}\n\n`)) response.end();
    };
    const unsubscribe = store.subscribe(write);
    if (!unsubscribe) {
      serveJson(response, 503, { message: "Слишком много открытых окон тестовых заказов." });
      return true;
    }
    response.once("close", unsubscribe);
    response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    write(store.ids());
    return true;
  }
  const controller = new AbortController();
  const disconnect = () => controller.abort();
  response.once("close", disconnect);
  try {
    if (search) {
      const query = (url.searchParams.get("q") ?? "").trim();
      if (query.length > 100 || /[\u0000-\u001f\u007f-\u009f]/.test(query)) {
        throw new NomenclatureError(400, "invalid_counterparty_search", "Введите до 100 символов для поиска контрагента.");
      }
      const result = await nomenclature.loadSupplierOrders({ view: "counterparties", query, id: null }, controller.signal);
      if (response.destroyed || !recheckAdmin()) return true;
      if (result.view !== "counterparties") throw new Error("Unexpected counterparty search result");
      serveJson(response, 200, result.counterparties);
    } else if (request.method === "PUT") {
      const { supplier, id } = objectFields(await readJsonBody(request, 4096), ["supplier", "id"]);
      if (!orderSuppliers.includes(supplier as OrderSupplier)) {
        throw new NomenclatureError(400, "invalid_supplier", "Выберите поставщика из корзины.");
      }
      const requestedId = id === null ? null : parseUuid(id);
      const result = requestedId && await nomenclature.loadSupplierOrders({ view: "counterparties", query: "", id: requestedId }, controller.signal);
      if (response.destroyed || !recheckAdmin()) return true;
      const entry = result && result.view === "counterparties" ? result.counterparties[0] : null;
      if (requestedId && !entry) {
        throw new NomenclatureError(404, "counterparty_missing", "Поставщик не найден в 1С. Повторите поиск.");
      }
      store.save(supplier as OrderSupplier, entry ?? null);
      serveJson(response, 200, store.list());
    } else {
      serveJson(response, 200, store.list());
    }
  } catch (error) {
    if (!response.destroyed) {
      if (error instanceof NomenclatureError || error instanceof RequestBodyError) {
        serveJson(response, error.statusCode, { message: error.message });
      } else {
        reportError();
        serveJson(response, 500, { message: "Не удалось загрузить или сохранить контрагента 1С." });
      }
    }
  } finally { response.removeListener("close", disconnect); }
  return true;
}
