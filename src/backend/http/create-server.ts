import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { classifyOperationalError, SupplierAuthError, SupplierIntegrationError, SupplierTimeoutError, type OperationalErrorCategory } from "../errors.ts";
import type {
  ArmtekCredentials,
  ForumAutoCredentials,
  MladovCredentials,
  MotorDetalCredentials,
  PartKomCredentials,
  RosskoApiCredentials,
  SearchStreamEvent,
  StpartsCredentials,
  SupplierId,
  SupplierSessionState,
  SupplierSessionValidationResult,
  SupplierSearchQuery,
} from "../types.ts";
import type { ApplicabilityApiKeyState, ApplicabilitySavedArticlesPage, ApplicabilitySavedArticlesQuery, ApplicabilitySearchRequest, ApplicabilitySearchResult, ApplicabilityVehicle } from "../applicability/types.ts";
import { PartsApiKeyError } from "../applicability/partsapi-key-error.ts";
import { parsePartsApiProxyConfig, parsePartsApiProxyImport, PartsApiProxyValidationError, type PartsApiProxyConfig, type PartsApiProxyImportResult, type PartsApiProxyState } from "../applicability/partsapi-proxy-config.ts";
import {
  articleLengthLimit,
  parseApplicabilityApiKeyPayload,
  parseApplicabilitySkuQuery,
  parseApplicabilitySavedArticlesQuery,
  parseApplicabilitySearchPayload,
  parseCredentials,
  parseRosskoApiCredentials,
  parseSessionValidationPayload,
  parseSupplierIds,
  readJsonBody,
  RequestBodyError,
} from "./request-body.ts";
import { securityHeaders, serveJson, writeSseEvent } from "./responses.ts";
import { serveStatic } from "./static-files.ts";
import { createHttpGarageApplication } from "../garage/http-garage-application.ts";
import { GarageConflictError, GarageNotFoundError, GarageOfferExpiredError, GarageValidationError } from "../garage/garage-application-service.ts";
import { getGarageDatabasePath } from "../config.ts";
import { CartApplicationService, CartError, type RealOrderGateway } from "../purchasing/cart-application-service.ts";
import { SqliteCartRepository } from "../purchasing/sqlite-cart-repository.ts";
import type { TestOrder } from "../purchasing/purchase-offer.ts";
import type { OrderHistory, SupplierOrderHistoryQuery } from "../purchasing/order-history-contract.ts";
import { historyDate } from "../purchasing/order-history-values.ts";
import { OrderCancellationService, CancellationInputError } from "../purchasing/order-cancellation-service.ts";
import { SqliteOrderCancellationRepository } from "../purchasing/sqlite-order-cancellation-repository.ts";
import type { OrderHistorySupplier } from "../purchasing/order-cancellation-contract.ts";
import type { OrderNotificationService } from "../notifications/order-notification-service.ts";
import { serveVkNotifications } from "./vk-notifications.ts";
import { serveOrderNotifications } from "./order-notifications.ts";

export interface AggregatorApplication {
  testCartOrder?: TestOrder;
  realCartOrder?: RealOrderGateway;
  partKomOrderHistory?: (archive: boolean, signal: AbortSignal) => Promise<OrderHistory>;
  supplierOrderHistory?: (query: SupplierOrderHistoryQuery, signal: AbortSignal) => Promise<OrderHistory>;
  listSupplierSessions(): SupplierSessionState[];
  validateSupplierSessions(
    article: string,
    suppliers: SupplierId[],
    signal: AbortSignal,
  ): Promise<{ results: SupplierSessionValidationResult[]; sessions: SupplierSessionState[] }>;
  authorizeRossko(credentials: RosskoApiCredentials, signal: AbortSignal): Promise<SupplierSessionState>;
  authorizeArmtek(credentials: ArmtekCredentials, signal: AbortSignal): Promise<SupplierSessionState>;
  authorizePartKom(credentials: PartKomCredentials, signal: AbortSignal): Promise<SupplierSessionState>;
  authorizeStparts(credentials: StpartsCredentials, signal: AbortSignal): Promise<SupplierSessionState>;
  authorizeForumAuto(credentials: ForumAutoCredentials, signal: AbortSignal): Promise<SupplierSessionState>;
  authorizeMotorDetal(credentials: MotorDetalCredentials, signal: AbortSignal): Promise<SupplierSessionState>;
  authorizeMladov(credentials: MladovCredentials, signal: AbortSignal): Promise<SupplierSessionState>;
  logoutRossko(): SupplierSessionState;
  logoutArmtek(): SupplierSessionState;
  logoutPartKom(): SupplierSessionState;
  logoutStparts(): SupplierSessionState;
  logoutForumAuto(): SupplierSessionState;
  logoutMotorDetal(): SupplierSessionState;
  logoutMladov(): SupplierSessionState;
  streamSearch(query: SupplierSearchQuery, emit: (event: SearchStreamEvent) => void, signal: AbortSignal): Promise<void>;
  searchApplicability(query: ApplicabilitySearchRequest, signal: AbortSignal): Promise<ApplicabilitySearchResult>;
  getApplicabilityCachedBrands(sku: string): string[];
  listApplicabilitySavedArticles(query: ApplicabilitySavedArticlesQuery): ApplicabilitySavedArticlesPage;
  getApplicabilitySavedArticle(query: ApplicabilitySearchRequest): ApplicabilityVehicle[] | null;
  deleteApplicabilitySavedArticle(query: ApplicabilitySearchRequest): boolean;
  getApplicabilityApiKeyState(): ApplicabilityApiKeyState;
  saveApplicabilityApiKey(apiKey: string): ApplicabilityApiKeyState;
  deleteApplicabilityApiKey(): ApplicabilityApiKeyState;
  getApplicabilityProxyState(): PartsApiProxyState;
  addApplicabilityProxy(config: PartsApiProxyConfig): PartsApiProxyState;
  importApplicabilityProxies(configs: PartsApiProxyConfig[]): PartsApiProxyImportResult;
  selectApplicabilityProxy(routeId: string | null): PartsApiProxyState;
  deleteApplicabilityProxy(id: string): PartsApiProxyState;
  resetApplicabilityProxyUsage(routeId: string | null): PartsApiProxyState;
}

interface CreateAggregatorServerOptions {
  application: AggregatorApplication;
  publicDir: string;
  notifications?: OrderNotificationService;
  reportError?: (event: OperationalErrorEvent) => void;
}

export interface OperationalErrorEvent {
  operation: string;
  category: OperationalErrorCategory;
  diagnosticCode?: string;
}

function serveAuthorizationError(
  response: ServerResponse,
  error: unknown,
  operation: string,
  reportError: (event: OperationalErrorEvent) => void,
): void {
  if (error instanceof RequestBodyError) {
    serveJson(response, error.statusCode, { message: error.message });
    return;
  }

  const category = classifyOperationalError(error);
  const diagnosticCode = error instanceof SupplierIntegrationError ? error.diagnosticCode : null;
  reportError({ operation, category, ...(diagnosticCode ? { diagnosticCode } : {}) });
  const statusCode = category === "authorization"
    ? 401
    : category === "timeout"
      ? 504
      : category === "integration"
        ? 502
        : 500;
  const message = error instanceof SupplierIntegrationError && error.publicMessage
    ? error.publicMessage
    : "Supplier authorization failed";
  serveJson(response, statusCode, { message });
}

function serveApplicabilityError(
  response: ServerResponse,
  error: unknown,
  reportError: (event: OperationalErrorEvent) => void,
): void {
  if (error instanceof PartsApiProxyValidationError) {
    serveJson(response, 400, { message: error.message });
    return;
  }
  if (error instanceof RequestBodyError) {
    serveJson(response, error.statusCode, { message: "Applicability request is invalid" });
    return;
  }
  const category = classifyOperationalError(error);
  reportError({ operation: "search-applicability", category });
  const statusCode = category === "authorization" ? 401 : category === "timeout" ? 504 : category === "integration" ? 502 : 500;
  const message = error instanceof PartsApiKeyError
    ? error.publicMessage
    : category === "authorization"
      ? "PartsAPI rejected the API key"
      : category === "timeout"
        ? "PartsAPI did not respond in time"
        : error instanceof SupplierIntegrationError && error.publicMessage
          ? error.publicMessage
          : "Applicability search failed";
  serveJson(response, statusCode, { message });
}

async function serveAuthorization<TCredentials>(
  request: IncomingMessage,
  response: ServerResponse,
  authorize: (credentials: TCredentials, signal: AbortSignal) => Promise<SupplierSessionState>,
  operation: string,
  reportError: (event: OperationalErrorEvent) => void,
  parsePayload: (payload: unknown) => TCredentials,
): Promise<void> {
  const controller = new AbortController();
  const abortAuthorization = () => {
    if (!response.writableEnded) {
      controller.abort(new Error("Client disconnected"));
    }
  };
  response.once("close", abortAuthorization);

  try {
    const credentials = parsePayload(await readJsonBody(request));
    const session = await authorize(credentials, controller.signal);
    if (!controller.signal.aborted) {
      serveJson(response, 200, { session });
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      serveAuthorizationError(response, error, operation, reportError);
    }
  } finally {
    response.removeListener("close", abortAuthorization);
  }
}

function garagePayload(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new GarageValidationError("request payload is invalid");
  }
  return payload as Record<string, unknown>;
}

function serveGarageError(response: ServerResponse, error: unknown, reportError: (event: OperationalErrorEvent) => void, operation: string): void {
  if (error instanceof RequestBodyError || error instanceof GarageValidationError) {
    serveJson(response, 400, { message: "Garage request is invalid" });
    return;
  }
  if (error instanceof GarageOfferExpiredError) {
    serveJson(response, 410, { message: "Предложение устарело. Выполните поиск ещё раз." });
    return;
  }
  if (error instanceof GarageConflictError) {
    serveJson(response, 409, { message: "Garage data was changed by another employee. Reload it and try again." });
    return;
  }
  if (error instanceof GarageNotFoundError) {
    serveJson(response, 404, { message: "Garage record was not found" });
    return;
  }
  reportError({ operation, category: "internal" });
  serveJson(response, 500, { message: "Garage operation failed" });
}

export function createAggregatorServer({
  application,
  publicDir,
  notifications,
  reportError = ({ operation, category, diagnosticCode }) => console.error(
    `[aggregator] ${operation} failed (${category})${diagnosticCode ? ` [${diagnosticCode}]` : ""}`,
  ),
}: CreateAggregatorServerOptions): Server {
  const resolvedPublicDir = resolve(publicDir);
  const garage = createHttpGarageApplication(application.streamSearch.bind(application));
  const cart = new CartApplicationService(new SqliteCartRepository(getGarageDatabasePath()), (lines, signal) => {
    if (!application.testCartOrder) throw new CartError("Тестовая проверка заказов не настроена.", 503);
    return application.testCartOrder(lines, signal);
  }, application.realCartOrder ?? null);
  const cancellations = new OrderCancellationService(new SqliteOrderCancellationRepository(getGarageDatabasePath()));

  const server = createServer(async (request, response) => {
    if (!request.url) {
      serveJson(response, 400, { message: "Missing URL" });
      return;
    }

    const url = new URL(request.url, "http://127.0.0.1");

    if (await serveVkNotifications(request, response, url, notifications)) return;
    if (await serveOrderNotifications(request, response, url, notifications)) return;
    if (/^\/api\/(?:search|cart|order-history|suppliers)(?:\/|$)/.test(url.pathname)) {
      const release = notifications?.beginForegroundOperation();
      if (release) response.once("close", release);
    }

    if (url.pathname === "/api/order-cancellations" || url.pathname === "/api/order-cancellations/seen") {
      response.setHeader("Cache-Control", "no-store");
      const expectedMethod = url.pathname.endsWith("/seen") ? "POST" : "GET";
      if (request.method !== expectedMethod) { serveJson(response, 405, { message: "Method not allowed" }); return; }
      if (url.search) { serveJson(response, 400, { message: "Неверный запрос уведомлений об отменах." }); return; }
      try {
        const result = expectedMethod === "GET" ? cancellations.unread() : cancellations.acknowledge(await readJsonBody(request));
        if (!response.destroyed) serveJson(response, 200, result);
      } catch (error) {
        if (error instanceof RequestBodyError || error instanceof CancellationInputError) {
          serveJson(response, error instanceof RequestBodyError ? error.statusCode : 400, { message: "Неверный запрос уведомлений об отменах." });
        } else {
          reportError({ operation: "order-cancellations", category: classifyOperationalError(error) });
          serveJson(response, 500, { message: "Не удалось сохранить или прочитать уведомления об отменах." });
        }
      }
      return;
    }

    const historyMatch = /^\/api\/order-history\/(part-kom|armtek|forum-auto|rossko)$/.exec(url.pathname);
    if (historyMatch) {
      const supplier = historyMatch[1] as OrderHistorySupplier;
      const name = ({ "part-kom": "PartKOM", armtek: "Armtek", "forum-auto": "Forum Auto", rossko: "Rossko" } as Record<string, string>)[supplier];
      response.setHeader("Cache-Control", "no-store");
      if (request.method !== "GET") {
        serveJson(response, 405, { message: "Method not allowed" });
        return;
      }
      const archive = url.searchParams.get("archive");
      const allowed = supplier === "part-kom" ? ["archive"] : supplier === "armtek" ? ["from", "to"] : [];
      if ([...url.searchParams.keys()].some((key) => !allowed.includes(key) || url.searchParams.getAll(key).length > 1)
        || archive !== null && archive !== "0" && archive !== "1") {
        serveJson(response, 400, { message: "Неверный фильтр истории заказов." });
        return;
      }
      let query: SupplierOrderHistoryQuery | null = null;
      if (supplier === "armtek") {
        const from = url.searchParams.get("from");
        const to = url.searchParams.get("to");
        if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)
          || historyDate(from) !== from || historyDate(to) !== to || from > to
          || Date.parse(to) - Date.parse(from) > 92 * 86_400_000) {
          serveJson(response, 400, { message: "Выберите корректный период Armtek: не более 93 дней." });
          return;
        }
        query = { supplier, from, to };
      } else if (supplier === "forum-auto" || supplier === "rossko") query = { supplier };
      const controller = new AbortController();
      const abort = () => { if (!response.writableEnded) controller.abort(new Error("Client disconnected")); };
      response.once("close", abort);
      try {
        const loadHistory = query ? application.supplierOrderHistory?.bind(application, query)
          : application.partKomOrderHistory?.bind(application, archive === "1");
        if (!loadHistory) {
          serveJson(response, 503, { message: `История заказов ${name} недоступна.` });
        } else {
          const history = await loadHistory(controller.signal);
          if (!controller.signal.aborted) {
            const result = supplier === "armtek" ? cart.withArmtekReturnDays(history) : history;
            cancellations.observe(supplier, result);
            serveJson(response, 200, result);
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          if (error instanceof SupplierAuthError) serveJson(response, 401, { message: `Авторизация ${name} недоступна.` });
          else if (error instanceof SupplierTimeoutError) serveJson(response, 504, { message: `${name} не ответил вовремя.` });
          else if (error instanceof SupplierIntegrationError) serveJson(response, 502, { message: `Не удалось получить историю заказов ${name}.` });
          else {
            reportError({ operation: `${supplier}-order-history`, category: classifyOperationalError(error) });
            serveJson(response, 500, { message: "Не удалось получить историю заказов." });
          }
        }
      } finally { response.removeListener("close", abort); }
      return;
    }

    const cartItemMatch = /^\/api\/cart\/items\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (url.pathname === "/api/cart" || url.pathname === "/api/cart/items" || url.pathname === "/api/cart/test-order"
      || url.pathname === "/api/cart/order-options" || url.pathname === "/api/cart/order" || url.pathname === "/api/cart/refresh"
      || url.pathname === "/api/cart/uncertain/resolve" || cartItemMatch) {
      response.setHeader("Cache-Control", "no-store");
      const controller = new AbortController();
      const abort = () => { if (!response.writableEnded) controller.abort(new Error("Client disconnected")); };
      response.once("close", abort);
      try {
        if (url.pathname === "/api/cart" && request.method === "GET") {
          serveJson(response, 200, cart.view());
        } else if (url.pathname === "/api/cart/order-options" && request.method === "GET") {
          const revisionText = url.searchParams.get("revision");
          if (!revisionText || !/^\d{1,15}$/.test(revisionText)) throw new CartError("Неверная версия корзины.");
          const choices = await cart.orderChoices(Number(revisionText), url.searchParams.get("supplier"), controller.signal);
          if (!controller.signal.aborted) serveJson(response, 200, choices);
        } else if (url.pathname === "/api/cart/items" && (request.method === "POST" || request.method === "DELETE")
          || cartItemMatch && (request.method === "PATCH" || request.method === "DELETE")
          || (url.pathname === "/api/cart/test-order" || url.pathname === "/api/cart/order" || url.pathname === "/api/cart/refresh"
            || url.pathname === "/api/cart/uncertain/resolve"
            || url.pathname === "/api/cart/order-options") && request.method === "POST") {
          const payload = await readJsonBody(request);
          if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new CartError("Неверные параметры корзины.");
          const fields = payload as Record<string, unknown>;
          if (url.pathname === "/api/cart/order-options") {
            const choices = await cart.orderChoices(fields.revision, fields.supplier, controller.signal, fields.itemIds);
            if (!controller.signal.aborted) serveJson(response, 200, choices);
          } else if (url.pathname === "/api/cart/refresh") {
            const result = await cart.refreshForOrder(fields.revision, fields.supplier, controller.signal);
            if (!controller.signal.aborted) serveJson(response, 200, result);
          } else if (url.pathname === "/api/cart/uncertain/resolve") {
            serveJson(response, 200, cart.resolveUncertainForumAutoLine(fields.id, fields.revision, fields.confirmedAbsent));
          } else if (url.pathname === "/api/cart/order") {
            const details = fields.details;
            if (!details || typeof details !== "object" || Array.isArray(details)) throw new CartError("Неверные параметры заказа.");
            const result = await cart.order(fields.revision, fields.supplier, fields.itemIds, details, controller.signal);
            if (!controller.signal.aborted) serveJson(response, 200, result);
          } else if (url.pathname === "/api/cart/test-order") {
            const result = await cart.test(fields.revision, controller.signal, fields.supplier);
            if (!controller.signal.aborted) serveJson(response, 200, result);
          } else if (url.pathname === "/api/cart/items" && request.method === "DELETE") {
            serveJson(response, 200, cart.clear(fields.supplier, fields.revision));
          } else {
            const action = cartItemMatch ? request.method === "DELETE" ? "remove" : "update" : "add";
            serveJson(response, action === "add" ? 201 : 200, cart.mutate(action, { ...fields, ...(cartItemMatch ? { id: cartItemMatch[1] } : {}) }));
          }
        } else serveJson(response, 405, { message: "Method not allowed" });
      } catch (error) {
        if (!controller.signal.aborted) {
          if (error instanceof CartError || error instanceof RequestBodyError) serveJson(response, error.statusCode, { message: error.message });
          else if (error instanceof SupplierAuthError) serveJson(response, 401, { message: "Авторизация поставщика недоступна." });
          else if (error instanceof SupplierTimeoutError) serveJson(response, 504, { message: "Поставщик не ответил вовремя." });
          else if (error instanceof SupplierIntegrationError) {
            const safeMessage = error.publicMessage && (url.pathname === "/api/cart/refresh" || url.pathname === "/api/cart/order-options");
            serveJson(response, url.pathname === "/api/cart/refresh" && safeMessage ? 409 : 502,
              { message: safeMessage ? error.publicMessage : url.pathname === "/api/cart/order"
                ? "Не удалось подготовить заказ у поставщика. Заказ не отправлен." : "Не удалось получить параметры заказа у поставщика." });
          }
          else {
            reportError({ operation: "cart", category: classifyOperationalError(error) });
            serveJson(response, 500, { message: "Не удалось выполнить действие в корзине." });
          }
        }
      } finally { response.removeListener("close", abort); }
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/health") {
      serveJson(response, 200, { status: "ok" });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/suppliers/sessions") {
      serveJson(response, 200, { sessions: application.listSupplierSessions() });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/applicability/search") {
      const controller = new AbortController();
      const abortSearch = () => {
        if (!response.writableEnded) controller.abort(new Error("Client disconnected"));
      };
      response.once("close", abortSearch);
      try {
        const result = await application.searchApplicability(parseApplicabilitySearchPayload(await readJsonBody(request)), controller.signal);
        if (!controller.signal.aborted) serveJson(response, 200, result);
      } catch (error) {
        if (!controller.signal.aborted) serveApplicabilityError(response, error, reportError);
      } finally {
        response.removeListener("close", abortSearch);
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/applicability/cached-brands") {
      try {
        serveJson(response, 200, { brands: application.getApplicabilityCachedBrands(parseApplicabilitySkuQuery(url.searchParams.get("sku"))) });
      } catch (error) {
        serveApplicabilityError(response, error, reportError);
      }
      return;
    }

    if (url.pathname === "/api/applicability/saved-articles") {
      try {
        if (request.method === "GET") {
          serveJson(response, 200, application.listApplicabilitySavedArticles(parseApplicabilitySavedArticlesQuery(url.searchParams)));
          return;
        }
        if (request.method === "DELETE") {
          const query = parseApplicabilitySearchPayload(await readJsonBody(request));
          serveJson(response, 200, { deleted: application.deleteApplicabilitySavedArticle(query) });
          return;
        }
      } catch (error) {
        serveApplicabilityError(response, error, reportError);
        return;
      }
    }

    if (request.method === "GET" && url.pathname === "/api/applicability/saved-articles/result") {
      try {
        const query = parseApplicabilitySearchPayload({ sku: url.searchParams.get("sku"), brand: url.searchParams.get("brand") });
        const results = application.getApplicabilitySavedArticle(query);
        if (results === null) serveJson(response, 404, { message: "Сохранённый OEM-артикул не найден." });
        else serveJson(response, 200, { results });
      } catch (error) {
        serveApplicabilityError(response, error, reportError);
      }
      return;
    }

    if (url.pathname === "/api/applicability/api-key") {
      try {
        if (request.method === "GET") {
          serveJson(response, 200, application.getApplicabilityApiKeyState());
          return;
        }
        if (request.method === "PUT") {
          const { apiKey } = parseApplicabilityApiKeyPayload(await readJsonBody(request));
          serveJson(response, 200, application.saveApplicabilityApiKey(apiKey));
          return;
        }
        if (request.method === "DELETE") {
          serveJson(response, 200, application.deleteApplicabilityApiKey());
          return;
        }
      } catch (error) {
        serveApplicabilityError(response, error, reportError);
        return;
      }
    }

    if (url.pathname === "/api/applicability/proxies/import" && request.method === "POST") {
      try {
        serveJson(response, 200, application.importApplicabilityProxies(parsePartsApiProxyImport(await readJsonBody(request, 1024 * 1024))));
      } catch (error) { serveApplicabilityError(response, error, reportError); }
      return;
    }

    if (url.pathname === "/api/applicability/proxies") {
      try {
        if (request.method === "GET") {
          serveJson(response, 200, application.getApplicabilityProxyState());
          return;
        }
        if (request.method === "POST") {
          serveJson(response, 200, application.addApplicabilityProxy(parsePartsApiProxyConfig(await readJsonBody(request))));
          return;
        }
      } catch (error) { serveApplicabilityError(response, error, reportError); return; }
    }

    if ((url.pathname === "/api/applicability/proxy-route" && request.method === "PUT")
      || (url.pathname === "/api/applicability/proxy-usage/reset" && request.method === "POST")) {
      try {
        const payload = await readJsonBody(request);
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new PartsApiProxyValidationError();
        const { routeId } = payload as Record<string, unknown>;
        if (routeId !== null && typeof routeId !== "string") throw new PartsApiProxyValidationError();
        serveJson(response, 200, url.pathname === "/api/applicability/proxy-route"
          ? application.selectApplicabilityProxy(routeId) : application.resetApplicabilityProxyUsage(routeId));
      } catch (error) { serveApplicabilityError(response, error, reportError); }
      return;
    }

    const proxyMatch = /^\/api\/applicability\/proxies\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (proxyMatch && request.method === "DELETE") {
      try {
        serveJson(response, 200, application.deleteApplicabilityProxy(proxyMatch[1]));
      } catch (error) { serveApplicabilityError(response, error, reportError); }
      return;
    }

    if (url.pathname === "/api/ui-preferences/table-column-widths") {
      try {
        if (request.method === "GET") {
          serveJson(response, 200, garage.getTablePreferences());
          return;
        }
        if (request.method === "PUT") {
          const payload = garagePayload(await readJsonBody(request));
          serveJson(response, 200, garage.setTablePreferences(payload.widths, payload.alignments));
          return;
        }
      } catch (error) { serveGarageError(response, error, reportError, "table-column-widths"); return; }
    }

    if (request.method === "GET" && url.pathname === "/api/garage/vehicles") {
      try {
        serveJson(response, 200, { vehicles: garage.listVehicles(url.searchParams.get("search") ?? "") });
      } catch (error) { serveGarageError(response, error, reportError, "list-garage-vehicles"); }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/garage/vehicles") {
      try {
        serveJson(response, 201, { vehicle: garage.createVehicle(garagePayload(await readJsonBody(request)).name) });
      } catch (error) { serveGarageError(response, error, reportError, "create-garage-vehicle"); }
      return;
    }

    const vehicleMatch = /^\/api\/garage\/vehicles\/([0-9a-f-]{36})(?:\/(items|refresh|groups))?$/.exec(url.pathname);
    if (vehicleMatch) {
      const [, vehicleId, action] = vehicleMatch;
      try {
        if (!action && request.method === "GET") {
          serveJson(response, 200, { vehicle: garage.getVehicle(vehicleId) });
          return;
        }
        if (!action && request.method === "PATCH") {
          const payload = garagePayload(await readJsonBody(request));
          serveJson(response, 200, { vehicle: garage.renameVehicle(vehicleId, payload.revision, payload.name) });
          return;
        }
        if (!action && request.method === "DELETE") {
          const payload = garagePayload(await readJsonBody(request));
          garage.deleteVehicle(vehicleId, payload.revision);
          serveJson(response, 204, null);
          return;
        }
        if (action === "items" && request.method === "POST") {
          const payload = garagePayload(await readJsonBody(request));
          const item = garage.addOffer(vehicleId, payload.vehicleRevision, payload.offerId, payload.markupPercent, payload.requiredQuantity, payload.duplicateStrategy, payload.groupId);
          serveJson(response, "duplicate" in item ? 409 : 201, "duplicate" in item ? { duplicate: item.duplicate } : { item });
          return;
        }
        if (action === "groups" && request.method === "POST") {
          const payload = garagePayload(await readJsonBody(request));
          serveJson(response, 201, { group: garage.createGroup(vehicleId, payload.vehicleRevision, payload.name) });
          return;
        }
        if (action === "refresh" && request.method === "POST") {
          const payload = garagePayload(await readJsonBody(request));
          const controller = new AbortController();
          response.once("close", () => controller.abort(new Error("Client disconnected")));
          const vehicle = await garage.refreshVehicle(vehicleId, payload.revision, controller.signal);
          if (!controller.signal.aborted) serveJson(response, 200, { vehicle });
          return;
        }
      } catch (error) { serveGarageError(response, error, reportError, "garage-vehicle"); return; }
    }

    const groupMatch = /^\/api\/garage\/vehicles\/([0-9a-f-]{36})\/groups\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (groupMatch && request.method === "PATCH") {
      try {
        const payload = garagePayload(await readJsonBody(request));
        serveJson(response, 200, { group: garage.renameGroup(groupMatch[1], groupMatch[2], payload.vehicleRevision, payload.name) });
        return;
      } catch (error) { serveGarageError(response, error, reportError, "garage-group"); return; }
    }
    if (groupMatch && request.method === "DELETE") {
      try {
        const payload = garagePayload(await readJsonBody(request));
        garage.deleteGroup(groupMatch[1], groupMatch[2], payload.vehicleRevision);
        serveJson(response, 204, null);
        return;
      } catch (error) { serveGarageError(response, error, reportError, "garage-group"); return; }
    }

    const itemMatch = /^\/api\/garage\/items\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (itemMatch) {
      try {
        const payload = garagePayload(await readJsonBody(request));
        if (request.method === "PATCH") {
          serveJson(response, 200, { item: garage.updateItem(itemMatch[1], payload.revision, payload.requiredQuantity, payload.comment, payload.groupId) });
          return;
        }
        if (request.method === "DELETE") {
          garage.deleteItem(itemMatch[1], payload.revision);
          serveJson(response, 204, null);
          return;
        }
      } catch (error) { serveGarageError(response, error, reportError, "garage-item"); return; }
    }

    if (request.method === "POST" && url.pathname === "/api/suppliers/sessions/validate") {
      const controller = new AbortController();
      const abortValidation = () => {
        if (!response.writableEnded) {
          controller.abort(new Error("Client disconnected"));
        }
      };
      response.once("close", abortValidation);

      try {
        const { article, suppliers } = parseSessionValidationPayload(await readJsonBody(request));
        serveJson(response, 200, await application.validateSupplierSessions(article, suppliers, controller.signal));
      } catch (error) {
        if (!controller.signal.aborted) {
          if (error instanceof RequestBodyError) {
            serveJson(response, error.statusCode, { message: error.message });
          } else {
            reportError({ operation: "validate-supplier-sessions", category: classifyOperationalError(error) });
            serveJson(response, 500, { message: "Supplier session validation failed" });
          }
        }
      } finally {
        response.removeListener("close", abortValidation);
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/suppliers/rossko/authorize") {
      await serveAuthorization(request, response, application.authorizeRossko.bind(application), "authorize-rossko", reportError, parseRosskoApiCredentials);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/suppliers/rossko/logout") {
      serveJson(response, 200, { session: application.logoutRossko() });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/suppliers/armtek/authorize") {
      await serveAuthorization(request, response, application.authorizeArmtek.bind(application), "authorize-armtek", reportError, parseCredentials);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/suppliers/armtek/logout") {
      serveJson(response, 200, { session: application.logoutArmtek() });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/suppliers/part-kom/authorize") {
      await serveAuthorization(request, response, application.authorizePartKom.bind(application), "authorize-part-kom", reportError, parseCredentials);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/suppliers/part-kom/logout") {
      serveJson(response, 200, { session: application.logoutPartKom() });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/suppliers/stparts/authorize") {
      await serveAuthorization(request, response, application.authorizeStparts.bind(application), "authorize-stparts", reportError, parseCredentials);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/suppliers/stparts/logout") {
      serveJson(response, 200, { session: application.logoutStparts() });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/suppliers/forum-auto/authorize") {
      await serveAuthorization(request, response, application.authorizeForumAuto.bind(application), "authorize-forum-auto", reportError, parseCredentials);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/suppliers/forum-auto/logout") {
      serveJson(response, 200, { session: application.logoutForumAuto() });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/suppliers/motordetal/authorize") {
      await serveAuthorization(request, response, application.authorizeMotorDetal.bind(application), "authorize-motordetal", reportError, parseCredentials);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/suppliers/motordetal/logout") {
      serveJson(response, 200, { session: application.logoutMotorDetal() });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/suppliers/mladov/authorize") {
      await serveAuthorization(request, response, application.authorizeMladov.bind(application), "authorize-mladov", reportError, parseCredentials);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/suppliers/mladov/logout") {
      serveJson(response, 200, { session: application.logoutMladov() });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/search") {
      if (url.searchParams.get("stream") !== "once") {
        response.writeHead(204);
        response.end();
        return;
      }

      const article = url.searchParams.get("article")?.trim();
      const mode = url.searchParams.get("mode");
      const brand = url.searchParams.get("brand")?.trim();
      const supplierValues = url.searchParams.getAll("supplier");
      const suppliers = supplierValues.length ? parseSupplierIds(supplierValues) : undefined;

      if (!article) {
        serveJson(response, 400, { message: "Query parameter article is required" });
        return;
      }
      if (article.length > articleLengthLimit) {
        serveJson(response, 400, { message: `Query parameter article must not exceed ${articleLengthLimit} characters` });
        return;
      }
      if (mode !== null && mode !== "analogs" && mode !== "brands") {
        serveJson(response, 400, { message: "Query parameter mode is invalid" });
        return;
      }
      if (mode === "analogs" && !brand) {
        serveJson(response, 400, { message: "Query parameter brand is required for analog search" });
        return;
      }
      if (brand && brand.length > articleLengthLimit) {
        serveJson(response, 400, { message: `Query parameter brand must not exceed ${articleLengthLimit} characters` });
        return;
      }

      response.writeHead(200, {
        ...securityHeaders,
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });

      const controller = new AbortController();
      request.on("close", () => controller.abort(new Error("Client disconnected")));

      try {
        const query: SupplierSearchQuery = mode === "analogs"
          ? { mode, article, brand: brand!, suppliers }
          : mode === "brands"
            ? { mode, article, suppliers }
            : { article, suppliers };
        await application.streamSearch(query, (event) => {
          if (event.type === "result") {
            const offerId = garage.registerSearchOffer(event.result);
            cart.registerOffer(offerId, event.result);
            writeSseEvent(response, { ...event, offerId });
            return;
          }
          writeSseEvent(response, event);
        }, controller.signal);
      } catch (error) {
        if (!controller.signal.aborted && !response.destroyed) {
          reportError({ operation: "stream-search", category: classifyOperationalError(error) });
          writeSseEvent(response, { type: "fatal_error", message: "Search failed" });
        }
      } finally {
        response.end();
      }
      return;
    }

    if (request.method === "GET") {
      await serveStatic(url.pathname, response, resolvedPublicDir);
      return;
    }

    serveJson(response, 405, { message: "Method not allowed" });
  });
  server.once("close", () => { garage.close(); cart.close(); cancellations.close(); });
  return server;
}
