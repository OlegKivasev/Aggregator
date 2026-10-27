import type { IncomingMessage, ServerResponse } from "node:http";
import { SupplierAuthError, SupplierIntegrationError, SupplierTimeoutError } from "../errors.ts";
import { CartError } from "../purchasing/cart-application-service.ts";
import { RosskoOrderSettingsValidationError, type RosskoOrderSettingsState } from "../purchasing/rossko-order-settings.ts";
import { readJsonBody, RequestBodyError } from "./request-body.ts";
import { serveJson } from "./responses.ts";

export interface RosskoOrderSettingsApplication {
  getRosskoOrderSettings?: (signal: AbortSignal) => Promise<RosskoOrderSettingsState>;
  saveRosskoOrderSettings?: (settings: unknown, signal: AbortSignal) => Promise<RosskoOrderSettingsState>;
}

export async function serveRosskoOrderSettings(request: IncomingMessage, response: ServerResponse, url: URL,
  application: RosskoOrderSettingsApplication, reportFailure: (error: unknown) => void): Promise<boolean> {
  if (url.pathname !== "/api/suppliers/rossko/order-settings") return false;
  response.setHeader("Cache-Control", "no-store");
  if (request.method !== "GET" && request.method !== "PUT") {
    serveJson(response, 405, { message: "Метод не поддерживается." }); return true;
  }
  if (url.search) { serveJson(response, 400, { message: "Неверный запрос настроек Rossko." }); return true; }
  if (!application.getRosskoOrderSettings || !application.saveRosskoOrderSettings) {
    serveJson(response, 503, { message: "Настройки заказа Rossko недоступны." }); return true;
  }
  const controller = new AbortController();
  const disconnect = () => { if (!response.writableEnded) controller.abort(new Error("Client disconnected")); };
  response.once("close", disconnect);
  try {
    const state = request.method === "GET"
      ? await application.getRosskoOrderSettings(controller.signal)
      : await application.saveRosskoOrderSettings(await readJsonBody(request), controller.signal);
    if (!controller.signal.aborted) serveJson(response, 200, state);
  } catch (error) {
    if (!controller.signal.aborted) {
      if (error instanceof RosskoOrderSettingsValidationError) serveJson(response, 400, { message: error.message });
      else if (error instanceof RequestBodyError || error instanceof CartError) serveJson(response, error.statusCode, { message: error.message });
      else if (error instanceof SupplierAuthError) serveJson(response, 401, { message: "Подключите Rossko с действующими ключами K1 и K2." });
      else if (error instanceof SupplierTimeoutError) serveJson(response, 504, { message: "Rossko не ответил вовремя. Повторите загрузку настроек." });
      else if (error instanceof SupplierIntegrationError) serveJson(response, 502, { message: error.publicMessage ?? "Не удалось получить параметры заказа Rossko." });
      else { reportFailure(error); serveJson(response, 500, { message: "Не удалось сохранить или загрузить настройки Rossko." }); }
    }
  } finally { response.removeListener("close", disconnect); }
  return true;
}
