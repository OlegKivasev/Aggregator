import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  authorizeArmtek,
  authorizeMotorDetal,
  authorizeMladov,
  authorizePartKom,
  authorizeRossko,
  authorizeStparts,
  listSupplierSessions,
  logoutArmtek,
  logoutMotorDetal,
  logoutMladov,
  logoutPartKom,
  logoutRossko,
  logoutStparts,
  shutdownSearchService,
  streamSearch,
} from "./search-service.ts";
import type { ArmtekCredentials, MladovCredentials, MotorDetalCredentials, PartKomCredentials, RosskoSiteCredentials, SearchStreamEvent, StpartsCredentials, SupplierId } from "./types.ts";

const rootDir = fileURLToPath(new URL("../..", import.meta.url));
const publicDir = join(rootDir, "src", "frontend");
const host = "127.0.0.1";
const requestBodyLimitBytes = 16 * 1024;
const articleLengthLimit = 128;

function readPort(): number {
  const value = Number(process.env.PORT ?? "3000");

  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  return value;
}

const port = readPort();

const contentTypes = new Map<string, string>([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "application/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

const supplierIds = new Set<SupplierId>(["rossko", "armtek", "part-kom", "stparts", "motordetal", "mladov"]);
const securityHeaders = {
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

class RequestBodyError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

function parseSupplierIds(values: string[]): SupplierId[] {
  return values.filter((value): value is SupplierId => supplierIds.has(value as SupplierId));
}

function writeSseEvent(response: import("node:http").ServerResponse, event: SearchStreamEvent): void {
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function serveJson(response: import("node:http").ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { ...securityHeaders, "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function serveAuthorizationError(response: import("node:http").ServerResponse, error: unknown): void {
  if (error instanceof RequestBodyError) {
    serveJson(response, error.statusCode, { message: error.message });
    return;
  }

  if (error instanceof Error && error.message.trim()) {
    serveJson(response, 400, { message: error.message.trim() });
    return;
  }

  serveJson(response, 400, { message: "Authorization failed" });
}

async function readJsonBody(request: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  let bodySize = 0;

  for await (const chunk of request) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    bodySize += buffer.byteLength;

    if (bodySize > requestBodyLimitBytes) {
      throw new RequestBodyError(413, "Request body is too large");
    }

    chunks.push(buffer);
  }

  if (!chunks.length) {
    return null;
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  } catch {
    throw new RequestBodyError(400, "Invalid JSON request body");
  }
}

async function serveStatic(pathname: string, response: import("node:http").ServerResponse): Promise<void> {
  const filePath = pathname === "/" ? join(publicDir, "index.html") : resolve(publicDir, `.${pathname}`);

  if (!filePath.startsWith(`${publicDir}${sep}`)) {
    serveJson(response, 404, { message: "Not found" });
    return;
  }

  try {
    const content = await readFile(filePath);
    const contentType = contentTypes.get(extname(filePath)) ?? "application/octet-stream";
    response.writeHead(200, { ...securityHeaders, "Content-Type": contentType });
    response.end(content);
  } catch {
    serveJson(response, 404, { message: "Not found" });
  }
}

const server = createServer(async (request, response) => {
  if (!request.url) {
    serveJson(response, 400, { message: "Missing URL" });
    return;
  }

  const url = new URL(request.url, `http://${host}:${port}`);

  if (request.method === "GET" && url.pathname === "/api/health") {
    serveJson(response, 200, { status: "ok" });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/suppliers/sessions") {
    serveJson(response, 200, { sessions: listSupplierSessions() });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/suppliers/rossko/authorize") {
    try {
      const payload = (await readJsonBody(request)) as Partial<RosskoSiteCredentials> | null;

      if (!payload?.login || !payload.password) {
        serveJson(response, 400, { message: "login and password are required" });
        return;
      }

      const session = await authorizeRossko({
        login: payload.login,
        password: payload.password,
      });
      serveJson(response, 200, { session });
    } catch (error) {
      serveAuthorizationError(response, error);
    }

    return;
  }

  if (request.method === "POST" && url.pathname === "/api/suppliers/rossko/logout") {
    const session = logoutRossko();
    serveJson(response, 200, { session });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/suppliers/armtek/authorize") {
    try {
      const payload = (await readJsonBody(request)) as Partial<ArmtekCredentials> | null;

      if (!payload?.login || !payload.password) {
        serveJson(response, 400, { message: "login and password are required" });
        return;
      }

      const session = await authorizeArmtek({
        login: payload.login,
        password: payload.password,
      });
      serveJson(response, 200, { session });
    } catch (error) {
      serveAuthorizationError(response, error);
    }

    return;
  }

  if (request.method === "POST" && url.pathname === "/api/suppliers/armtek/logout") {
    const session = logoutArmtek();
    serveJson(response, 200, { session });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/suppliers/part-kom/authorize") {
    try {
      const payload = (await readJsonBody(request)) as Partial<PartKomCredentials> | null;

      if (!payload?.login || !payload.password) {
        serveJson(response, 400, { message: "login and password are required" });
        return;
      }

      const session = await authorizePartKom({
        login: payload.login,
        password: payload.password,
      });
      serveJson(response, 200, { session });
    } catch (error) {
      serveAuthorizationError(response, error);
    }

    return;
  }

  if (request.method === "POST" && url.pathname === "/api/suppliers/part-kom/logout") {
    const session = logoutPartKom();
    serveJson(response, 200, { session });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/suppliers/stparts/authorize") {
    try {
      const payload = (await readJsonBody(request)) as Partial<StpartsCredentials> | null;

      if (!payload?.login || !payload.password) {
        serveJson(response, 400, { message: "login and password are required" });
        return;
      }

      const session = await authorizeStparts({
        login: payload.login,
        password: payload.password,
      });
      serveJson(response, 200, { session });
    } catch (error) {
      serveAuthorizationError(response, error);
    }

    return;
  }

  if (request.method === "POST" && url.pathname === "/api/suppliers/stparts/logout") {
    const session = logoutStparts();
    serveJson(response, 200, { session });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/suppliers/motordetal/authorize") {
    try {
      const payload = (await readJsonBody(request)) as Partial<MotorDetalCredentials> | null;

      if (!payload?.login || !payload.password) {
        serveJson(response, 400, { message: "login and password are required" });
        return;
      }

      const session = await authorizeMotorDetal({ login: payload.login, password: payload.password });
      serveJson(response, 200, { session });
    } catch (error) {
      serveAuthorizationError(response, error);
    }

    return;
  }

  if (request.method === "POST" && url.pathname === "/api/suppliers/motordetal/logout") {
    const session = logoutMotorDetal();
    serveJson(response, 200, { session });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/suppliers/mladov/authorize") {
    try {
      const payload = (await readJsonBody(request)) as Partial<MladovCredentials> | null;
      if (!payload?.login || !payload.password) {
        serveJson(response, 400, { message: "login and password are required" });
        return;
      }
      const session = await authorizeMladov({ login: payload.login, password: payload.password });
      serveJson(response, 200, { session });
    } catch (error) {
      serveAuthorizationError(response, error);
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/suppliers/mladov/logout") {
    serveJson(response, 200, { session: logoutMladov() });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/search") {
    if (url.searchParams.get("stream") !== "once") {
      response.writeHead(204);
      response.end();
      return;
    }

    const article = url.searchParams.get("article")?.trim();
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

    response.writeHead(200, {
      ...securityHeaders,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });

    const controller = new AbortController();
    request.on("close", () => controller.abort(new Error("Client disconnected")));

    try {
      await streamSearch({ article, suppliers }, (event) => writeSseEvent(response, event), controller.signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected server error";
      writeSseEvent(response, { type: "fatal_error", message });
    } finally {
      response.end();
    }

    return;
  }

  if (request.method === "GET") {
    await serveStatic(url.pathname, response);
    return;
  }

  serveJson(response, 405, { message: "Method not allowed" });
});

server.listen(port, host, () => {
  console.log(`Aggregator server started at http://${host}:${port}`);
});

function shutdown(): void {
  server.close(() => {
    shutdownSearchService().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
