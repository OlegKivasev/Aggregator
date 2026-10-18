import type { IncomingMessage, ServerResponse } from "node:http";
import { PartImageError, partImageQuery, type PartImageSearch } from "../images/part-image-search.ts";
import { readJsonBody, RequestBodyError } from "./request-body.ts";
import { serveJson } from "./responses.ts";

export async function servePartImages(request: IncomingMessage, response: ServerResponse, url: URL, service?: PartImageSearch): Promise<boolean> {
  if (url.pathname !== "/api/part-images" && url.pathname !== "/api/part-images/key") return false;
  response.setHeader("Cache-Control", "no-store");
  const controller = new AbortController();
  const abort = () => { if (!response.writableEnded) controller.abort(); };
  response.once("close", abort);
  try {
    if (request.headers["sec-fetch-site"] === "cross-site") throw new PartImageError("Запрос изображений отклонён.", 403);
    if (!service) throw new PartImageError("Поиск изображений не подключён на сервере.", 503);
    if (url.pathname === "/api/part-images/key") {
      if (url.search) throw new PartImageError("Неверный запрос настроек изображений.", 400);
      if (request.method === "GET") serveJson(response, 200, service.state());
      else if (request.method === "DELETE") serveJson(response, 200, service.disconnect());
      else if (request.method === "PUT") {
        if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) throw new PartImageError("Требуется JSON.", 415);
        const payload = await readJsonBody(request, 1024);
        if (!payload || typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).some((key) => key !== "apiKey")) throw new PartImageError("Неверный запрос настроек изображений.", 400);
        serveJson(response, 200, service.configure((payload as { apiKey?: unknown }).apiKey));
      } else serveJson(response, 405, { message: "Method not allowed" });
    } else if (request.method !== "GET") serveJson(response, 405, { message: "Method not allowed" });
    else {
      if ([...url.searchParams.keys()].some((key) => !["article", "brand", "page"].includes(key) || url.searchParams.getAll(key).length !== 1)
        || !/^[0-9]$/.test(url.searchParams.get("page") ?? "0")) throw new PartImageError("Неверный запрос изображений.", 400);
      const query = partImageQuery(url.searchParams.get("article"), url.searchParams.get("brand"), Number(url.searchParams.get("page") ?? 0));
      const result = await service.search(query, controller.signal);
      if (!controller.signal.aborted) serveJson(response, 200, result);
    }
  } catch (error) {
    if (!controller.signal.aborted) serveJson(response, error instanceof PartImageError ? error.status : error instanceof RequestBodyError ? error.statusCode : 500,
      { message: error instanceof PartImageError ? error.message : "Не удалось выполнить запрос изображений." });
  } finally { response.removeListener("close", abort); }
  return true;
}
