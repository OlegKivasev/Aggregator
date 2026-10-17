import type { IncomingMessage, ServerResponse } from "node:http";
import type { OrderNotificationService } from "../notifications/order-notification-service.ts";
import { NotificationSettingsError } from "../notifications/order-notification-service.ts";
import { VkError } from "../notifications/vk-client.ts";
import { readJsonBody, RequestBodyError } from "./request-body.ts";
import { serveJson } from "./responses.ts";

export async function serveVkNotifications(request: IncomingMessage, response: ServerResponse, url: URL, service?: OrderNotificationService): Promise<boolean> {
  if (!["/api/notifications/vk", "/api/notifications/vk/state", "/api/notifications/vk/pairing"].includes(url.pathname)) return false;
  response.setHeader("Cache-Control", "no-store");
  if (!service) { serveJson(response, 503, { message: "Уведомления ВК не подключены на сервере." }); return true; }
  if (url.search) { serveJson(response, 400, { message: "Неверный запрос уведомлений ВК." }); return true; }
  const controller = new AbortController();
  const abort = () => { if (!response.writableEnded) controller.abort(); };
  response.once("close", abort);
  try {
    if (request.method !== "GET" && (request.headers["sec-fetch-site"] === "cross-site"
      || request.method !== "DELETE" && !request.headers["content-type"]?.toLowerCase().startsWith("application/json"))) {
      serveJson(response, 403, { message: "Запрос настроек ВК отклонён." }); return true;
    }
    if (url.pathname === "/api/notifications/vk" && request.method === "GET") serveJson(response, 200, service.state());
    else if (url.pathname === "/api/notifications/vk" && request.method === "PUT") {
      const payload = await readJsonBody(request);
      const token = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as { token?: unknown }).token : null;
      const state = await service.connect(token, controller.signal);
      if (!controller.signal.aborted) serveJson(response, 200, state);
    } else if (url.pathname === "/api/notifications/vk" && request.method === "DELETE") serveJson(response, 200, service.disconnect());
    else if (url.pathname === "/api/notifications/vk/state" && request.method === "PUT") {
      const state = await service.configure(await readJsonBody(request), controller.signal);
      if (!controller.signal.aborted) serveJson(response, 200, state);
    }
    else if (url.pathname === "/api/notifications/vk/pairing" && request.method === "POST") {
      const payload = await readJsonBody(request);
      if (!payload || typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).length) throw new NotificationSettingsError("Неверный запрос подключения беседы.");
      const state = await service.beginChatPairing(controller.signal);
      if (!controller.signal.aborted) serveJson(response, 200, state);
    }
    else if (url.pathname === "/api/notifications/vk/pairing" && request.method === "DELETE") serveJson(response, 200, service.cancelChatPairing());
    else serveJson(response, 405, { message: "Method not allowed" });
  } catch (error) {
    if (!controller.signal.aborted) {
      const status = error instanceof NotificationSettingsError ? error.status : error instanceof RequestBodyError ? error.statusCode : error instanceof VkError ? 502 : 500;
      const message = error instanceof NotificationSettingsError || error instanceof VkError ? error.message : "Не удалось изменить настройки уведомлений ВК.";
      serveJson(response, status, { message });
    }
  } finally { response.removeListener("close", abort); }
  return true;
}
