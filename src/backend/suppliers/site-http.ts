import { Agent, request as httpsRequest } from "node:https";

const siteAgent = new Agent({ keepAlive: true, family: 4, maxSockets: 12 });

export interface SiteHttpResponse {
  status: number;
  body: string;
  setCookie: string[];
}

export async function siteHttpRequest(
  url: URL,
  options: { cookie?: string; headers?: Record<string, string>; signal: AbortSignal; timeoutMs?: number; method?: "GET" | "POST"; body?: string },
): Promise<SiteHttpResponse> {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(options.signal.reason);
  const timeout = setTimeout(() => controller.abort(new Error(`Request timed out after ${options.timeoutMs ?? 8000}ms`)), options.timeoutMs ?? 8000);
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
        response.setEncoding("utf-8");
        response.on("data", (chunk) => { body += chunk; });
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
