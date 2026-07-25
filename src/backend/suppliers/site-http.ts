import { Agent, request as httpsRequest } from "node:https";
import { SupplierIntegrationError, SupplierTimeoutError } from "./errors.ts";

const siteAgent = new Agent({ keepAlive: true, family: 4, maxSockets: 12 });
const defaultMaxResponseBytes = 2 * 1024 * 1024;

export function closeSiteHttpAgent(): void {
  siteAgent.destroy();
}

export interface SiteHttpResponse {
  status: number;
  body: string;
  rawBody?: Buffer;
  setCookie: string[];
  contentType: string | null;
}

export async function siteHttpRequest(
  url: URL,
  options: { cookie?: string; headers?: Record<string, string>; signal: AbortSignal; timeoutMs?: number; method?: "GET" | "POST"; body?: string; maxResponseBytes?: number; returnRawBody?: boolean },
): Promise<SiteHttpResponse> {
  if (options.signal.aborted) {
    throw options.signal.reason;
  }
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(options.signal.reason);
  const timeout = setTimeout(
    () => controller.abort(new SupplierTimeoutError("Supplier request timed out")),
    options.timeoutMs ?? 8000,
  );
  options.signal.addEventListener("abort", forwardAbort, { once: true });

  try {
    return await new Promise<SiteHttpResponse>((resolve, reject) => {
      const request = httpsRequest(url, {
        method: options.method || "GET",
        family: 4,
        agent: siteAgent,
        signal: controller.signal,
        headers: {
          Accept: "*/*",
          "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
          ...(options.cookie ? { Cookie: options.cookie } : {}),
          ...options.headers,
        },
      }, (response) => {
        const chunks: Buffer[] = [];
        let bodyBytes = 0;
        response.on("error", reject);
        response.on("aborted", () => reject(new SupplierIntegrationError("Supplier response was interrupted")));
        const declaredLength = Number(response.headers["content-length"]);
        if (Number.isFinite(declaredLength) && declaredLength > (options.maxResponseBytes ?? defaultMaxResponseBytes)) {
          response.destroy(new SupplierIntegrationError("Supplier response is too large"));
          return;
        }
        response.on("data", (chunk: Buffer) => {
          bodyBytes += chunk.byteLength;
          if (bodyBytes > (options.maxResponseBytes ?? defaultMaxResponseBytes)) {
            response.destroy(new SupplierIntegrationError("Supplier response is too large"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          const rawBody = Buffer.concat(chunks);
          resolve({
            status: response.statusCode || 0,
            body: options.returnRawBody ? "" : rawBody.toString("utf-8"),
            rawBody: options.returnRawBody ? rawBody : undefined,
            setCookie: response.headers["set-cookie"] || [],
            contentType: typeof response.headers["content-type"] === "string" ? response.headers["content-type"] : null,
          });
        });
      });
      request.on("error", reject);
      if (options.body) {
        request.write(options.body);
      }
      request.end();
    }).catch((error: unknown) => {
      if (controller.signal.aborted) {
        throw controller.signal.reason;
      }
      throw error;
    });
  } finally {
    clearTimeout(timeout);
    options.signal.removeEventListener("abort", forwardAbort);
  }
}
