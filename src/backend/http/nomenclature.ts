import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthenticatedUser } from "../auth/user-auth-service.ts";
import { NomenclatureError, objectFields, parseBarcode, parseLookupResult, parseUuid } from "../nomenclature/contract.ts";
import { parseStockResult, parseStockQuery } from "../nomenclature/stock-contract.ts";
import type { NomenclatureService } from "../nomenclature/nomenclature-service.ts";
import { readJsonBody, RequestBodyError } from "./request-body.ts";
import { serveJson } from "./responses.ts";

export async function serveNomenclature(request: IncomingMessage, response: ServerResponse, url: URL,
  service: NomenclatureService, user: AuthenticatedUser | null, reportError: () => void): Promise<boolean> {
  const integration = url.pathname.startsWith("/api/integration/1c/nomenclature/");
  if (!integration && !url.pathname.startsWith("/api/nomenclature/")) return false;
  response.setHeader("Cache-Control", "no-store");
  const owner = user?.id ?? "development";
  const admin = user?.isAdmin ?? true; // With enabled auth the composition root already rejected anonymous API requests.
  const jsonBody = async (limit = 16 * 1024) => {
    if (request.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
      throw new NomenclatureError(415, "content_type", "Требуется Content-Type: application/json.");
    }
    return readJsonBody(request, limit);
  };
  const onlyMethod = (...methods: string[]) => {
    if (!methods.includes(request.method ?? "")) throw new NomenclatureError(405, "method", "Метод не поддерживается.");
  };
  try {
    if (integration) {
      const match = /^\/api\/integration\/1c\/nomenclature\/(requests|results|stock-results|status)$/.exec(url.pathname);
      if (!match) throw new NomenclatureError(404, "not_found", "Маршрут не найден.");
      const token = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(request.headers.authorization ?? "")?.[1];
      service.authenticate(token);
      if (match[1] === "status") {
        onlyMethod("GET");
        if (url.search) throw new NomenclatureError(400, "query", "Неизвестные параметры запроса.");
        // Checking a key must not make a stopped worker appear online.
        const state = service.state();
        serveJson(response, 200, { ready: true, workerOnline: state.online, lastSeenAt: state.lastSeenAt });
      } else if (match[1] === "results" || match[1] === "stock-results") {
        onlyMethod("POST");
        if (url.search) throw new NomenclatureError(400, "query", "Неизвестные параметры запроса.");
        const result = match[1] === "stock-results" ? parseStockResult(await jsonBody(256 * 1024)) : parseLookupResult(await jsonBody(64 * 1024));
        if ("hasMore" in result) service.completeStock(token, result); else service.complete(token, result);
        serveJson(response, 200, { accepted: true, requestId: result.requestId });
      } else {
        onlyMethod("GET");
        const wait = url.searchParams.get("waitSeconds") ?? "20";
        if ([...url.searchParams.keys()].some((key) => !["waitSeconds", "stock"].includes(key)) || url.searchParams.getAll("waitSeconds").length > 1
          || url.searchParams.getAll("stock").length > 1 || url.searchParams.has("stock") && !["1", "2", "3"].includes(url.searchParams.get("stock")!)
          || !/^(?:\d|1\d|20)$/.test(wait)) throw new NomenclatureError(400, "wait", "Ожидание должно быть от 0 до 20 секунд.");
        const release = service.beginPoll();
        const controller = new AbortController();
        const abort = () => controller.abort();
        response.once("close", abort);
        try {
          const deadline = Date.now() + Number(wait) * 1000;
          while (!controller.signal.aborted) {
            const job = service.claim(token, url.searchParams.has("stock"), ["2", "3"].includes(url.searchParams.get("stock")!), url.searchParams.get("stock") === "3");
            if (job || Date.now() >= deadline) { serveJson(response, 200, { request: job }); break; }
            await service.wait(controller.signal, deadline - Date.now());
          }
        } finally { response.removeListener("close", abort); release(); }
      }
      return true;
    }

    if (url.pathname === "/api/nomenclature/stock") {
      onlyMethod("GET");
      if ([...url.searchParams.keys()].some((key) => !["after", "q"].includes(key)) || url.searchParams.getAll("after").length > 1 || url.searchParams.getAll("q").length > 1) {
        throw new NomenclatureError(400, "query", "Неизвестные параметры запроса.");
      }
      const cursor = url.searchParams.has("after") ? parseUuid(url.searchParams.get("after")) : null;
      const query = parseStockQuery(url.searchParams.get("q") ?? "");
      const controller = new AbortController();
      const abort = () => controller.abort();
      response.once("close", abort);
      try {
        const page = await service.loadStock(cursor, controller.signal, query);
        if (!response.destroyed) serveJson(response, 200, page);
      } finally { response.removeListener("close", abort); }
      return true;
    }
    if (url.search) throw new NomenclatureError(400, "query", "Неизвестные параметры запроса.");
    if (url.pathname === "/api/nomenclature/connection" && request.method === "GET") {
      onlyMethod("GET");
      serveJson(response, 200, service.state());
    } else if (url.pathname === "/api/nomenclature/settings") {
      if (!admin) throw new NomenclatureError(403, "forbidden", "Настройки доступны администратору.");
      onlyMethod("GET");
      serveJson(response, 200, service.state());
    } else if (url.pathname === "/api/nomenclature/connection") {
      if (!admin) throw new NomenclatureError(403, "forbidden", "Настройки доступны администратору.");
      onlyMethod("POST", "DELETE");
      if (request.method === "POST") {
        objectFields(await jsonBody(), []);
        const token = service.rotateKey();
        serveJson(response, 200, { ...service.state(), token });
      } else {
        service.disconnect();
        serveJson(response, 200, service.state());
      }
    } else if (url.pathname === "/api/nomenclature/lookups") {
      onlyMethod("POST");
      const data = objectFields(await jsonBody(), ["barcode"]);
      serveJson(response, 202, { lookup: service.create(parseBarcode(data.barcode), owner) });
    } else {
      const match = /^\/api\/nomenclature\/lookups\/([^/]+)$/.exec(url.pathname);
      if (!match) throw new NomenclatureError(404, "not_found", "Маршрут не найден.");
      onlyMethod("GET", "DELETE");
      const id = parseUuid(match[1]);
      if (request.method === "DELETE") service.cancel(id, owner, admin);
      serveJson(response, 200, { lookup: service.get(id, owner, admin) });
    }
  } catch (error) {
    if (!response.destroyed) {
      if (error instanceof NomenclatureError || error instanceof RequestBodyError) {
        serveJson(response, error.statusCode, { code: error instanceof NomenclatureError ? error.code : "invalid_body", message: error.message });
      } else {
        reportError();
        serveJson(response, 500, { code: "internal", message: "Не удалось выполнить поиск номенклатуры." });
      }
    }
  }
  return true;
}
