import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { parseRepairCard, parseRepairDocumentId, RepairValidationError } from "../repairs/repair-card.ts";
import type { SqliteRepairRepository } from "../repairs/sqlite-repair-repository.ts";
import { readJsonBody, RequestBodyError } from "./request-body.ts";
import { serveJson } from "./responses.ts";

export async function serveRepairs(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  repository: SqliteRepairRepository,
  secret: string | null,
  reportError: () => void,
): Promise<boolean> {
  const importCard = url.pathname === "/api/integration/1c/repairs";
  const checkStatus = url.pathname === "/api/integration/1c/repairs/status";
  const clearTest = url.pathname === "/api/integration/1c/repairs/test";
  const clearProduction = url.pathname === "/api/integration/1c/repairs/production";
  const deleteCard = importCard && request.method === "DELETE";
  const integration = importCard || checkStatus || clearTest || clearProduction;
  if (!integration && url.pathname !== "/api/repairs") return false;
  response.setHeader("Cache-Control", "no-store");
  const method = deleteCard || clearTest || clearProduction ? "DELETE" : importCard ? "POST" : "GET";
  if (request.method !== method) {
    response.setHeader("Allow", importCard ? "POST, DELETE" : method);
    serveJson(response, 405, { message: "Method not allowed" });
    return true;
  }
  if (url.search) {
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
    if (!checkStatus && request.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
      serveJson(response, 415, { message: "Требуется Content-Type: application/json." });
      return true;
    }
  }
  try {
    if (deleteCard) {
      const payload = await readJsonBody(request);
      if (!payload || typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).length !== 2
        || !("documentId" in payload) || !("testPlatform" in payload) || typeof payload.testPlatform !== "boolean") {
        throw new RequestBodyError(400, "Для удаления карточки требуются documentId и логическое testPlatform.");
      }
      const documentId = parseRepairDocumentId(payload.documentId);
      if (!response.destroyed) serveJson(response, 200, {
        documentId, testPlatform: payload.testPlatform, deleted: repository.deleteCard(documentId, payload.testPlatform),
      });
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
      serveJson(response, 200, { repairs: repository.list() });
    }
  } catch (error) {
    if (!response.destroyed) {
      if (error instanceof RequestBodyError || error instanceof RepairValidationError) {
        serveJson(response, error instanceof RequestBodyError ? error.statusCode : 400, { message: error.message });
      } else {
        reportError();
        serveJson(response, 500, { message: "Не удалось сохранить или прочитать заказ-наряды." });
      }
    }
  }
  return true;
}
