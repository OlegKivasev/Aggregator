import { Agent, request as httpsRequest } from "node:https";
import { SupplierIntegrationError, SupplierTimeoutError } from "./errors.ts";

const siteAgent = new Agent({ keepAlive: true, family: 4, maxSockets: 12 });
const defaultMaxResponseBytes = 2 * 1024 * 1024;

export interface SiteHttpResponse {
  status: number;
  body: string;
  setCookie: string[];
}

export async function siteHttpRequest(
  url: URL,
  options: { cookie?: string; headers?: Record<string, string>; signal: AbortSignal; timeoutMs?: number; method?: "GET" | "POST"; body?: string; maxResponseBytes?: number },
): Promise<SiteHttpResponse> {
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
        let body = "";
        let bodyBytes = 0;
        response.setEncoding("utf-8");
        response.on("data", (chunk: string) => {
          bodyBytes += Buffer.byteLength(chunk);
          if (bodyBytes > (options.maxResponseBytes ?? defaultMaxResponseBytes)) {
            response.destroy(new SupplierIntegrationError("Supplier response is too large"));
            return;
          }
          body += chunk;
        });
        response.on("error", reject);
        response.on("end", () => resolve({
          status: response.statusCode || 0,
          body,
          setCookie: response.headers["set-cookie"] || [],
        }));
      });
      request.on("error", reject);
      if (options.body) {
        request.write(options.body);
      }
      request.end();
    });
  } finally {
    clearTimeout(timeout);
    options.signal.removeEventListener("abort", forwardAbort);
  }
}
