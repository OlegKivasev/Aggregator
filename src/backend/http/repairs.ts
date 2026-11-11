import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { parseRepairCard, parseRepairRemoval, RepairValidationError } from "../repairs/repair-card.ts";
import type { SqliteRepairRepository } from "../repairs/sqlite-repair-repository.ts";
import { RepairRefreshError, refreshFailure } from "../repairs/repair-refresh-service.ts";
import { readJsonBody, RequestBodyError } from "./request-body.ts";
import { serveJson } from "./responses.ts";

export async function serveRepairs(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  repository: SqliteRepairRepository,
  secret: string | null,
  reportError: () => void,
  responsibleFio?: string,
  ownerId = "shared",
): Promise<boolean> {
  const importCard = url.pathname === "/api/integration/1c/repairs";
  const checkStatus = url.pathname === "/api/integration/1c/repairs/status";
  const clearTest = url.pathname === "/api/integration/1c/repairs/test";
  const clearProduction = url.pathname === "/api/integration/1c/repairs/production";
  const deleteCard = importCard && request.method === "DELETE";
  const workerRequests = url.pathname === "/api/integration/1c/repairs/refresh/requests";
  const workerResults = url.pathname === "/api/integration/1c/repairs/refresh/results";
  const refreshRoute = /^\/api\/repairs\/refresh(?:\/([a-f0-9-]{36}))?$/.exec(url.pathname);
  const integration = importCard || checkStatus || clearTest || clearProduction || workerRequests || workerResults;
  if (!integration && !refreshRoute && url.pathname !== "/api/repairs") return false;
  response.setHeader("Cache-Control", "no-store");
  let testPlatformFilter: boolean | undefined;
  let resultWaitSeconds = 0;
  if (!integration) {
    const searchKeys = [...url.searchParams.keys()];
    const supportsWait = Boolean(refreshRoute?.[1]) && request.method === "GET";
    if (searchKeys.some((key) => key !== "testPlatform" && !(supportsWait && key === "waitSeconds"))
      || url.searchParams.getAll("testPlatform").length > 1
      || url.searchParams.has("testPlatform") && !["true", "false"].includes(url.searchParams.get("testPlatform") ?? "")
      || url.searchParams.getAll("waitSeconds").length > 1
      || url.searchParams.has("waitSeconds") && !/^(?:\d|1\d|20)$/.test(url.searchParams.get("waitSeconds")!)) {
      serveJson(response, 400, { message: "Параметры URL не поддерживаются." });
      return true;
    }
    if (url.searchParams.has("testPlatform")) testPlatformFilter = url.searchParams.get("testPlatform") === "true";
    resultWaitSeconds = Number(url.searchParams.get("waitSeconds") ?? "0");
    if (refreshRoute && testPlatformFilter === undefined) { serveJson(response, 400, { message: "Укажите режим заказ-нарядов." }); return true; }
  }
  const method = deleteCard || clearTest || clearProduction ? "DELETE" : importCard || workerResults || refreshRoute && !refreshRoute[1] ? "POST" : "GET";
  const methods = refreshRoute?.[1] ? ["GET", "DELETE"] : [method];
  if (!methods.includes(request.method ?? "")) {
    response.setHeader("Allow", importCard ? "POST, DELETE" : methods.join(", "));
    serveJson(response, 405, { message: "Method not allowed" });
    return true;
  }
  if (integration && !workerRequests && url.search) {
    serveJson(response, 400, { message: "Параметры URL не поддерживаются." });
    return true;
  }
  if (integration) {
    if (!secret) {
      serveJson(response, 503, { message: "Интеграция с 1С не настроена." });
      return true;
    }
    const authorization = request.headers.authorization;
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!token || token.length > 256 || !timingSafeEqual(
      createHash("sha256").update(token).digest(), createHash("sha256").update(secret).digest(),
    )) {
      response.setHeader("WWW-Authenticate", "Bearer");
      serveJson(response, 401, { message: "Неверный секрет интеграции." });
      return true;
    }
    if (!checkStatus && !workerRequests && request.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
      serveJson(response, 415, { message: "Требуется Content-Type: application/json." });
      return true;
    }
  }
  try {
    if (workerRequests) {
      if ([...url.searchParams.keys()].some((key) => !["testPlatform", "waitSeconds"].includes(key))
        || url.searchParams.getAll("testPlatform").length !== 1 || !["true", "false"].includes(url.searchParams.get("testPlatform") ?? "")
        || url.searchParams.getAll("waitSeconds").length > 1 || !/^(?:\d|1\d|20)$/.test(url.searchParams.get("waitSeconds") ?? "20")) {
        throw new RepairRefreshError(400);
      }
      const release = repository.refreshes.beginPoll();
      const abort = new AbortController();
      const stop = () => abort.abort();
      response.once("close", stop);
      try {
        const deadline = Date.now() + Number(url.searchParams.get("waitSeconds") ?? "20") * 1000;
        while (!abort.signal.aborted) {
          const job = repository.refreshes.claim(url.searchParams.get("testPlatform") === "true");
          if (job || Date.now() >= deadline) { serveJson(response, 200, { request: job }); break; }
          await repository.refreshes.wait(abort.signal, Math.min(1000, deadline - Date.now()));
        }
      } finally { release(); response.removeListener("close", stop); }
    } else if (workerResults) {
      const result = repository.refreshes.complete(await readJsonBody(request, 512 * 1024));
      if (!response.destroyed) serveJson(response, 200, result);
    } else if (refreshRoute) {
      if (!secret) throw new RepairRefreshError(503);
      const id = refreshRoute[1];
      if (!id) {
        if (request.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() !== "application/json") throw new RepairRefreshError(415);
        const payload = await readJsonBody(request, 16 * 1024);
        if (!response.destroyed) serveJson(response, 202, { refresh: repository.refreshes.create(payload, testPlatformFilter!, ownerId, responsibleFio) });
      } else if (request.method === "DELETE") {
        repository.refreshes.cancel(id, testPlatformFilter!, ownerId);
        serveJson(response, 200, { cancelled: true });
      } else {
        const abort = new AbortController();
        const stop = () => abort.abort();
        response.once("close", stop);
        try {
          const refresh = await repository.refreshes.getWhenReady(id, testPlatformFilter!, ownerId, responsibleFio, abort.signal, resultWaitSeconds * 1000);
          if (!response.destroyed) serveJson(response, 200, { refresh });
        } finally { response.removeListener("close", stop); }
      }
    } else if (deleteCard) {
      const identity = parseRepairRemoval(await readJsonBody(request));
      if (!response.destroyed) {
        const deleted = repository.remove(identity.documentId, identity.testPlatform);
        serveJson(response, 200, { ...identity, deleted });
      }
    } else if (importCard) {
      const repair = parseRepairCard(await readJsonBody(request));
      if (!response.destroyed) {
        repository.save(repair);
        serveJson(response, 200, { repair });
      }
    } else if (clearTest || clearProduction) {
      const payload = await readJsonBody(request);
      const confirmation = clearTest ? "confirmTestCleanup" : "confirmProductionCleanup";
      if (!payload || typeof payload !== "object" || Array.isArray(payload)
        || Object.keys(payload).length !== 1 || !(confirmation in payload)
        || (payload as Record<string, unknown>)[confirmation] !== true) {
        throw new RequestBodyError(400, `Для удаления карточек требуется ${confirmation}: true.`);
      }
      if (!response.destroyed) serveJson(response, 200, {
        deleted: clearTest ? repository.clearTestCards() : repository.clearProductionCards(),
      });
    } else if (checkStatus) {
      serveJson(response, 200, { ready: true, cards: repository.counts() });
    } else {
      const repairs = repository.list().filter((repair) => (testPlatformFilter === undefined || (repair.testPlatform === true) === testPlatformFilter)
        && (responsibleFio === undefined
        || (repair.responsibleFio !== undefined && repair.responsibleFio.replace(/\s+/g, " ").trim().toLocaleLowerCase("ru-RU") === responsibleFio)));
      const unverified = [false, true].flatMap((test) => repository.refreshes.unverified(
        repairs.filter((card) => (card.testPlatform === true) === test).map((card) => card.documentId), test)
        .map((documentId) => ({ documentId, testPlatform: test })));
      serveJson(response, 200, { repairs, ...(unverified.length ? { unverified } : {}) });
    }
  } catch (error) {
    if (!response.destroyed) {
      if (error instanceof RepairRefreshError) {
        serveJson(response, error.statusCode, { message: error.message });
      } else if (error instanceof RequestBodyError || error instanceof RepairValidationError) {
        serveJson(response, error instanceof RequestBodyError ? error.statusCode : 400, { message: error.message });
      } else {
        reportError();
        serveJson(response, 500, { message: refreshRoute || workerResults || workerRequests ? refreshFailure : "Не удалось сохранить или прочитать заказ-наряды." });
      }
    }
  }
  return true;
}
