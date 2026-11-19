import type { IncomingMessage, ServerResponse } from "node:http";
import { NomenclatureError } from "../nomenclature/contract.ts";
import type { NomenclatureService } from "../nomenclature/nomenclature-service.ts";
import { parseSupplierOrdersRequest } from "../purchasing/supplier-orders-contract.ts";
import { serveJson } from "./responses.ts";

export async function serveSupplierOrders(request: IncomingMessage, response: ServerResponse, url: URL,
  service: NomenclatureService, recheckAccess: () => boolean, reportError: () => void): Promise<void> {
  response.setHeader("Cache-Control", "no-store");
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    serveJson(response, 405, { message: "Метод не поддерживается." });
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
    response.setHeader("Server-Timing", `supplier-orders;dur=${(performance.now() - started).toFixed(1)}`);
    if (result.view === "list") {
      const last = result.orders.at(-1);
      serveJson(response, 200, { orders: result.orders, nextCursor: result.hasMore && last ? `${last.date}.${last.id}` : null });
    } else {
      const data = result.view === "preview" ? result.products : result.order;
      if (data === null) serveJson(response, 404, { message: "Заказ больше недоступен в списке. Обновите заказы поставщикам." });
      else serveJson(response, 200, data);
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
