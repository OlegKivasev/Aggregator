import type { IncomingMessage, ServerResponse } from "node:http";
import { NomenclatureError, parseUuid } from "../nomenclature/contract.ts";
import type { NomenclatureService } from "../nomenclature/nomenclature-service.ts";
import { parseSupplierOrdersRequest, supplierListCursor } from "../purchasing/supplier-orders-contract.ts";
import { parseSupplierOrderNote, type SupplierOrderNotes } from "../purchasing/supplier-order-notes.ts";
import { readJsonBody, RequestBodyError } from "./request-body.ts";
import { serveJson } from "./responses.ts";

const supplierOrderNoteRoute = /^\/api\/purchasing\/supplier-orders\/([^/]+)\/items\/([^/]+)\/note$/;

export async function serveSupplierOrders(request: IncomingMessage, response: ServerResponse, url: URL,
  service: NomenclatureService, notes: SupplierOrderNotes, recheckAccess: () => boolean, reportError: () => void): Promise<void> {
  response.setHeader("Cache-Control", "no-store");
  const noteRoute = supplierOrderNoteRoute.exec(url.pathname);
  const method = noteRoute ? "PUT" : "GET";
  if (request.method !== method) {
    response.setHeader("Allow", method);
    serveJson(response, 405, { message: "Метод не поддерживается." });
    return;
  }
  if (noteRoute) {
    try {
      if (url.search) throw new NomenclatureError(400, "invalid_note", "Некорректный запрос заметки.");
      const orderId = parseUuid(noteRoute[1]);
      const itemKey = noteRoute[2];
      const input = parseSupplierOrderNote(itemKey, await readJsonBody(request, 16 * 1024));
      if (response.destroyed || !recheckAccess()) return;
      const result = notes.save(orderId, itemKey, input.text, input.revision);
      serveJson(response, result.saved ? 200 : 409, { note: result.note });
    } catch (error) {
      if (response.destroyed) return;
      if (error instanceof NomenclatureError || error instanceof RequestBodyError) {
        serveJson(response, error.statusCode, { message: error instanceof NomenclatureError ? error.message : "Некорректные данные заметки." });
      } else {
        reportError();
        serveJson(response, 500, { message: "Не удалось сохранить заметку." });
      }
    }
    return;
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  response.once("close", abort);
  try {
    const read = parseSupplierOrdersRequest(url.pathname, url.searchParams);
    const started = performance.now();
    const result = await service.loadSupplierOrders(read, controller.signal);
    if (response.destroyed || !recheckAccess()) return;
    if (result.view === "counterparties") throw new NomenclatureError(503, "stock_failed", "Ответ 1С не соответствует запросу заказов.");
    response.setHeader("Server-Timing", `supplier-orders;dur=${(performance.now() - started).toFixed(1)}`);
    if (read.view !== "order" && result.view !== "order") {
      serveJson(response, 200, { orders: result.orders, nextCursor: supplierListCursor(read, result) });
    } else {
      const data = result.view === "order" ? result.order : null;
      if (!data) serveJson(response, 404, { message: "Заказ больше недоступен в списке. Обновите заказы поставщикам." });
      else serveJson(response, 200, { ...data, products: notes.withNotes(data.id, data.products) });
    }
  } catch (error) {
    if (response.destroyed) return;
    if (error instanceof NomenclatureError) {
      const message = error.code === "stock_timeout" ? "1С не ответила вовремя. Повторите загрузку заказов."
        : error.code === "stock_failed" ? "Не удалось получить заказы поставщикам из 1С." : error.message;
      serveJson(response, error.statusCode, { code: error.code, message });
    } else {
      reportError();
      serveJson(response, 500, { message: "Не удалось загрузить заказы поставщикам." });
    }
  } finally { response.removeListener("close", abort); }
}
