import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { classifyOperationalError, SupplierIntegrationError, type OperationalErrorCategory } from "../errors.ts";
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
import {
  articleLengthLimit,
  parseCredentials,
  parseRosskoApiCredentials,
  parseSessionValidationPayload,
  parseSupplierIds,
  readJsonBody,
  RequestBodyError,
} from "./request-body.ts";
import { securityHeaders, serveJson, writeSseEvent } from "./responses.ts";
import { serveStatic } from "./static-files.ts";

export interface AggregatorApplication {
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
}

interface CreateAggregatorServerOptions {
  application: AggregatorApplication;
  publicDir: string;
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

export function createAggregatorServer({
  application,
  publicDir,
  reportError = ({ operation, category, diagnosticCode }) => console.error(
    `[aggregator] ${operation} failed (${category})${diagnosticCode ? ` [${diagnosticCode}]` : ""}`,
  ),
}: CreateAggregatorServerOptions): Server {
  const resolvedPublicDir = resolve(publicDir);

  return createServer(async (request, response) => {
    if (!request.url) {
      serveJson(response, 400, { message: "Missing URL" });
      return;
    }

    const url = new URL(request.url, "http://127.0.0.1");

    if (request.method === "GET" && url.pathname === "/api/health") {
      serveJson(response, 200, { status: "ok" });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/suppliers/sessions") {
      serveJson(response, 200, { sessions: application.listSupplierSessions() });
      return;
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
      if (mode !== null && mode !== "analogs") {
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
          : { article, suppliers };
        await application.streamSearch(query, (event) => writeSseEvent(response, event), controller.signal);
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
}
