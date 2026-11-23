import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { normalizeRepairOwner, parseRepairCard, parseRepairRemoval, parseRepairStatuses, RepairValidationError } from "../repairs/repair-card.ts";
import { repairDetailsForUser, repairProductForUser } from "../repairs/repair-details.ts";
import type { AuthenticatedUser } from "../auth/user-auth-service.ts";
import type { SqliteRepairRepository } from "../repairs/sqlite-repair-repository.ts";
import { RepairRefreshError, refreshFailure } from "../repairs/repair-refresh-service.ts";
import { parseIncomingRequest } from "../nomenclature/incoming-contract.ts";
import { NomenclatureError } from "../nomenclature/contract.ts";
import type { NomenclatureService } from "../nomenclature/nomenclature-service.ts";
import { serveIncoming, serveProductCard } from "./nomenclature.ts";
import { parseProductCardRequest, productCardForRepair } from "../nomenclature/product-card-contract.ts";
import { readJsonBody, RequestBodyError } from "./request-body.ts";
import { serveJson } from "./responses.ts";

const positionRepairStatuses = (user?: AuthenticatedUser) => user?.repairSettings?.statuses ?? (user?.positionId ? [] : undefined);

const repairAccess = (user?: AuthenticatedUser, statuses = positionRepairStatuses(user)) => ({
  allOpen: user?.showAllOpenRepairs === true,
  responsibleFio: user && !user.isAdmin && !user.showAllOpenRepairs ? normalizeRepairOwner(user.fio) : undefined,
  statuses: statuses === undefined ? undefined : new Set(statuses),
});

const canReadProductCards = (user?: AuthenticatedUser) => !user || user.isAdmin || user.permissions.includes("nomenclature");

export async function serveRepairs(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  repository: SqliteRepairRepository,
  nomenclature: NomenclatureService,
  secret: string | null,
  reportError: () => void,
  user?: AuthenticatedUser,
  readCurrentUser?: () => AuthenticatedUser | null,
): Promise<boolean> {
  const importCard = url.pathname === "/api/integration/1c/repairs";
  const checkStatus = url.pathname === "/api/integration/1c/repairs/status";
  const saveStatuses = url.pathname === "/api/integration/1c/repairs/statuses";
  const listStatuses = url.pathname === "/api/repairs/statuses";
  const clearTest = url.pathname === "/api/integration/1c/repairs/test";
  const clearProduction = url.pathname === "/api/integration/1c/repairs/production";
  const deleteCard = importCard && request.method === "DELETE";
  const workerRequests = url.pathname === "/api/integration/1c/repairs/refresh/requests";
  const workerResults = url.pathname === "/api/integration/1c/repairs/refresh/results";
  const refreshRoute = /^\/api\/repairs\/refresh(?:\/([a-f0-9-]{36}))?$/.exec(url.pathname);
  const incomingRoute = /^\/api\/repairs\/refresh\/([a-f0-9-]{36})\/incoming$/.exec(url.pathname);
  const productRoute = /^\/api\/repairs\/refresh\/([a-f0-9-]{36})\/products\/([a-f0-9-]{36})$/.exec(url.pathname);
  const integration = importCard || checkStatus || saveStatuses || clearTest || clearProduction || workerRequests || workerResults;
  if (!integration && !listStatuses && !refreshRoute && !incomingRoute && !productRoute && url.pathname !== "/api/repairs") return false;
  response.setHeader("Cache-Control", "no-store");
  let testPlatformFilter: boolean | undefined;
  let resultWaitSeconds = 0;
  if (listStatuses && url.search) {
    serveJson(response, 400, { message: "Параметры URL не поддерживаются." });
    return true;
  }
  if (!integration) {
    const searchKeys = [...url.searchParams.keys()];
    const supportsWait = Boolean(refreshRoute?.[1]) && request.method === "GET";
    if (searchKeys.some((key) => key !== "testPlatform" && !(supportsWait && key === "waitSeconds")
      && !(incomingRoute && ["product", "side", "after", "grant"].includes(key))
      && !(productRoute && ["from", "to", "details", "grant"].includes(key)))
      || url.searchParams.getAll("grant").length > 1
      || url.searchParams.getAll("testPlatform").length > 1
      || url.searchParams.has("testPlatform") && !["true", "false"].includes(url.searchParams.get("testPlatform") ?? "")
      || url.searchParams.getAll("waitSeconds").length > 1
      || url.searchParams.has("waitSeconds") && !/^(?:\d|1\d|20)$/.test(url.searchParams.get("waitSeconds")!)) {
      serveJson(response, 400, { message: "Параметры URL не поддерживаются." });
      return true;
    }
    if (url.searchParams.has("testPlatform")) testPlatformFilter = url.searchParams.get("testPlatform") === "true";
    resultWaitSeconds = Number(url.searchParams.get("waitSeconds") ?? "0");
    if ((refreshRoute || incomingRoute || productRoute) && testPlatformFilter === undefined) { serveJson(response, 400, { message: "Укажите режим заказ-нарядов." }); return true; }
  }
  const method = saveStatuses ? "PUT" : deleteCard || clearTest || clearProduction ? "DELETE"
    : importCard || workerResults || refreshRoute && !refreshRoute[1] ? "POST" : "GET";
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
  const statuses = positionRepairStatuses(user);
  const access = repairAccess(user, statuses);
  const ownerId = user?.id ?? "shared";
  const filterKey = JSON.stringify(statuses);
  // 1C may answer after an administrator has changed this user's position or access.
  const currentOrderUser = () => {
    if (!readCurrentUser) return user;
    const current = readCurrentUser();
    const currentAccess = repairAccess(current ?? undefined);
    if (!current || current.id !== ownerId
      || !current.isAdmin && !current.permissions.includes(testPlatformFilter ? "testRepairs" : "repairs")
      || currentAccess.allOpen !== access.allOpen || currentAccess.responsibleFio !== access.responsibleFio
      || JSON.stringify(positionRepairStatuses(current)) !== filterKey) {
      throw new RepairRefreshError(403, "Доступ к заказ-наряду изменился.");
    }
    return current;
  };
  const userForVisibleOrder = (documentId: string) => {
    const current = currentOrderUser();
    if (!repository.readableIds([documentId], testPlatformFilter!, access).has(documentId)) {
      throw new RepairRefreshError(404, "Заказ-наряд больше недоступен.");
    }
    return current;
  };
  const requireProductAccess = (current?: AuthenticatedUser) => {
    if (!canReadProductCards(current)) throw new RepairRefreshError(403, "Для карточки товара нужен доступ к разделу «Номенклатура».");
  };
  const productGrant = (refreshId: string, id: string) => createHmac("sha256", secret!)
    .update(JSON.stringify(["repair-product", refreshId, ownerId, testPlatformFilter, id])).digest("base64url");
  const hasProductGrant = (refreshId: string, id: string, grant: string | null) =>
    secret && grant !== null && /^[A-Za-z0-9_-]{43}$/.test(grant) &&
    timingSafeEqual(Buffer.from(grant), Buffer.from(productGrant(refreshId, id)));
  try {
    if (saveStatuses) {
      const payload = await readJsonBody(request, 128 * 1024) as Record<string, unknown> | null;
      if (!payload || typeof payload.testPlatform !== "boolean" || Object.keys(payload).length !== 2) {
        throw new RequestBodyError(400, "Укажите список статусов и режим заказ-нарядов.");
      }
      const statuses = parseRepairStatuses(payload.statuses);
      if (!response.destroyed) {
        repository.saveStatuses(payload.testPlatform, statuses);
        serveJson(response, 200, { accepted: true });
      }
    } else if (listStatuses) {
      serveJson(response, 200, { statuses: repository.statuses() });
    } else if (workerRequests) {
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
    } else if (productRoute) {
      requireProductAccess(user);
      if (!secret) throw new RepairRefreshError(503);
      const params = new URLSearchParams(url.searchParams);
      params.delete("testPlatform");
      const grant = params.get("grant");
      params.delete("grant");
      const card = parseProductCardRequest(productRoute[2], params, testPlatformFilter);
      const refresh = repository.refreshes.get(productRoute[1], testPlatformFilter!, ownerId, access);
      const granted = hasProductGrant(productRoute[1], card.id, grant);
      if (!refresh.details || !granted && !refresh.details.goods.some((row) => row.productId === card.id
        || row.stockDetails?.replacements.some((item) => item.id === card.id && item.quantity > 0))) {
        throw new RepairRefreshError(404, "Товар недоступен в этом заказ-наряде.");
      }
      await serveProductCard(response, nomenclature, card, (result) => {
        const current = userForVisibleOrder(refresh.repairs![0].documentId);
        requireProductAccess(current);
        const visibility = current?.repairVisibility;
        const projected = visibility ? productCardForRepair(result, visibility) : result;
        if ((projected.view !== "card" && projected.view !== "preview") || !projected.data) return projected;
        const withGrant = <T extends { id?: string }>(item: T) =>
          item.id ? { ...item, cardProof: productGrant(productRoute[1], item.id) } : item;
        return { ...projected, data: {
          ...projected.data, incomingProof: productGrant(productRoute[1], card.id),
          stockDetails: { ...projected.data.stockDetails, replacements: projected.data.stockDetails.replacements.map(withGrant) },
          replacements: projected.data.replacements.map(withGrant),
        } };
      });
    } else if (incomingRoute) {
      const params = new URLSearchParams(url.searchParams);
      params.delete("testPlatform");
      const grant = params.get("grant");
      params.delete("grant");
      const incoming = parseIncomingRequest(params);
      const refresh = repository.refreshes.get(incomingRoute[1], testPlatformFilter!, ownerId, access);
      const inOrder = refresh.details?.goods.some((row) => row.productId === incoming.productId && row[incoming.side] > 0);
      if (!refresh.details || !inOrder && !(canReadProductCards(user) && hasProductGrant(incomingRoute[1], incoming.productId, grant))) {
        throw new RepairRefreshError(404, "Поставки недоступны. Откройте заказ-наряд заново.");
      }
      await serveIncoming(response, nomenclature, { ...incoming, testPlatform: testPlatformFilter }, (details) => {
        const current = userForVisibleOrder(refresh.repairs![0].documentId);
        if (!inOrder) requireProductAccess(current);
        const visibility = current?.repairVisibility;
        const canGrant = Boolean(secret) && canReadProductCards(current);
        return { ...details, orders: details.orders.map((row) => {
          const projected = visibility ? repairProductForUser(row, visibility) : row;
          return canGrant && row.productId !== incoming.productId
            ? { ...projected, cardProof: productGrant(incomingRoute[1], row.productId) } : projected;
        }) };
      });
    } else if (refreshRoute) {
      if (!secret) throw new RepairRefreshError(503);
      const id = refreshRoute[1];
      if (!id) {
        if (request.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() !== "application/json") throw new RepairRefreshError(415);
        const payload = await readJsonBody(request, 16 * 1024);
        if (!response.destroyed) {
          currentOrderUser();
          serveJson(response, 202, { refresh: repository.refreshes.create(payload, testPlatformFilter!, ownerId, access) });
        }
      } else if (request.method === "DELETE") {
        repository.refreshes.cancel(id, testPlatformFilter!, ownerId);
        serveJson(response, 200, { cancelled: true });
      } else {
        const abort = new AbortController();
        const stop = () => abort.abort();
        response.once("close", stop);
        try {
          const refresh = await repository.refreshes.getWhenReady(id, testPlatformFilter!, ownerId, access, abort.signal, resultWaitSeconds * 1000);
          if (!response.destroyed) {
            const current = currentOrderUser();
            serveJson(response, 200, { refresh: refresh.details
              ? { ...refresh, details: repairDetailsForUser(refresh.details, current?.repairVisibility), canOpenProductCards: canReadProductCards(current) }
              : refresh });
          }
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
      const repairs = repository.list(false, testPlatformFilter, access);
      const idsByPlatform: [string[], string[]] = [[], []];
      for (const card of repairs) idsByPlatform[card.testPlatform ? 1 : 0].push(card.documentId);
      const unverified = idsByPlatform.flatMap((ids, platform) => ids.length
        ? repository.refreshes.unverified(ids, platform === 1).map((documentId) => ({ documentId, testPlatform: platform === 1 }))
        : []);
      const settings = user?.repairSettings;
      const repairView = settings ? { showStatus: settings.showStatus, showAssignee: settings.showAssignee }
        : statuses !== undefined && !access.allOpen ? { showStatus: false, showAssignee: false } : undefined;
      serveJson(response, 200, { repairs, ...(unverified.length ? { unverified } : {}), ...(access.allOpen ? { allOpen: true } : {}),
        ...(repairView ? { repairView } : {}) });
    }
  } catch (error) {
    if (!response.destroyed) {
      if (error instanceof RepairRefreshError || error instanceof NomenclatureError) {
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
