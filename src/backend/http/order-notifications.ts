import type { IncomingMessage, ServerResponse } from "node:http";
import { NotificationSettingsError, type OrderNotificationService } from "../notifications/order-notification-service.ts";
import { readJsonBody, RequestBodyError } from "./request-body.ts";
import { serveJson } from "./responses.ts";

export async function serveOrderNotifications(request: IncomingMessage, response: ServerResponse, url: URL, service?: OrderNotificationService): Promise<boolean> {
  if (url.pathname !== "/api/notifications/orders" && url.pathname !== "/api/notifications/orders/seen") return false;
  response.setHeader("Cache-Control", "no-store");
  if (!service) { serveJson(response, 503, { message: "Уведомления о заказах недоступны на сервере." }); return true; }
  const seen = url.pathname.endsWith("/seen");
  if (request.method !== (seen ? "POST" : "GET")) { serveJson(response, 405, { message: "Method not allowed" }); return true; }
  try {
    const params = [...url.searchParams];
    const before = url.searchParams.get("before");
    if (seen && url.search || params.length > 1 || params.some(([key]) => key !== "before")
      || before !== null && (!/^[1-9]\d{0,15}$/.test(before) || !Number.isSafeInteger(Number(before)))) {
      throw new NotificationSettingsError("Неверный запрос уведомлений.");
    }
    if (seen) {
      if (request.headers["sec-fetch-site"] === "cross-site" || !request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
        serveJson(response, 403, { message: "Запрос прочтения уведомлений отклонён." }); return true;
      }
      serveJson(response, 200, service.markOrdersSeen(await readJsonBody(request)));
    } else serveJson(response, 200, service.orderFeed(before === null ? null : Number(before)));
  } catch (error) {
    serveJson(response, error instanceof NotificationSettingsError ? error.status : error instanceof RequestBodyError ? error.statusCode : 500,
      { message: error instanceof NotificationSettingsError ? error.message : "Не удалось загрузить уведомления о заказах." });
  }
  return true;
}
