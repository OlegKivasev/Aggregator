import { createHash } from "node:crypto";
import type { SupplierSessionManager } from "../../session/session-manager.ts";
import { getStpartsApiConfig } from "../../config.ts";
import type { NormalizedSearchResult, SearchQuery, SupplierSearchContext, SupplierSessionState, StpartsCredentials } from "../../types.ts";
import { SupplierAuthError, SupplierIntegrationError, SupplierTimeoutError } from "../errors.ts";
import type { SupplierAdapter } from "../supplier-adapter.ts";
import { siteHttpRequest } from "../site-http.ts";
import { stpartsBaseUrl } from "./stparts-site-auth.ts";

interface AbcpBrand {
  brand?: unknown;
  number?: unknown;
}

interface AbcpArticle {
  availability?: unknown;
  brand?: unknown;
  deliveryPeriod?: unknown;
  deliveryPeriodMax?: unknown;
  description?: unknown;
  distributorCode?: unknown;
  number?: unknown;
  price?: unknown;
  supplierColor?: unknown;
  supplierDescription?: unknown;
}

interface StpartsApiRequestOptions {
  method?: "GET" | "POST";
}

type StpartsApiRequester = (
  path: string,
  params: URLSearchParams,
  signal: AbortSignal,
  timeoutMs: number,
  credentials?: StpartsCredentials,
  options?: StpartsApiRequestOptions,
) => Promise<unknown>;

interface CachedStpartsSearch {
  expiresAt: number;
  results: NormalizedSearchResult[];
}

interface StpartsSearchInProgress {
  controller: AbortController;
  promise: Promise<NormalizedSearchResult[]>;
  waiters: number;
}

const stpartsSearchCacheTtlMs = 60_000;
const stpartsSearchCacheMaxEntries = 100;
const stpartsBatchSize = 100;

function normalizeArticle(value: string): string {
  return value.replace(/[^A-Z0-9]/gi, "").toUpperCase();
}

function dateFromHours(value: unknown): string | null {
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours < 0) {
    return null;
  }
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + Math.ceil(hours / 24)).toISOString();
}

function color(value: unknown): "green" | "blue" | "red" | null {
  if (value === "green" || value === "blue" || value === "red") {
    return value;
  }
  if (typeof value !== "string" || !/^[\da-f]{6}$/i.test(value)) {
    return null;
  }
  const red = Number.parseInt(value.slice(0, 2), 16) / 255;
  const green = Number.parseInt(value.slice(2, 4), 16) / 255;
  const blue = Number.parseInt(value.slice(4, 6), 16) / 255;
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  if (maximum === minimum) {
    return null;
  }
  const hue = 60 * (
    maximum === red ? ((green - blue) / (maximum - minimum)) % 6
      : maximum === green ? (blue - red) / (maximum - minimum) + 2
        : (red - green) / (maximum - minimum) + 4
  );
  const normalizedHue = hue < 0 ? hue + 360 : hue;
  if (normalizedHue >= 75 && normalizedHue < 165) {
    return "green";
  }
  if (normalizedHue >= 165 && normalizedHue < 285) {
    return "blue";
  }
  return "red";
}

function warehouse(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const text = value
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
  return text || null;
}

function abcpItems(payload: unknown, responseName: string): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (payload && typeof payload === "object") {
    return Object.values(payload);
  }
  throw new SupplierIntegrationError(`STParts API returned an invalid ${responseName} response`);
}

export function parseStpartsApiResults(payload: unknown, requestedArticle: string): NormalizedSearchResult[] {
  const target = normalizeArticle(requestedArticle);
  const results: NormalizedSearchResult[] = [];

  for (const value of abcpItems(payload, "search")) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const item = value as AbcpArticle;
    const brand = typeof item.brand === "string" ? item.brand.trim() : "";
    const article = typeof item.number === "string" ? item.number.trim() : "";
    const title = typeof item.description === "string" ? item.description.trim() : "";
    const price = Number(item.price);
    if (!brand || !article || !title || normalizeArticle(article) !== target || !Number.isFinite(price) || price <= 0 || Number(item.availability) === 0) {
      continue;
    }
    results.push({
      supplier: "stparts",
      brand,
      article,
      title,
      price,
      warehouse: warehouse(item.supplierDescription) || warehouse(item.distributorCode),
      warehouseColor: color(item.supplierColor),
      deliveryDate: dateFromHours(item.deliveryPeriod),
      deliveryDateTo: dateFromHours(item.deliveryPeriodMax),
      deliveryDateApproximate: true,
      link: new URL(`/search/${encodeURIComponent(brand)}/${encodeURIComponent(article)}`, stpartsBaseUrl).toString(),
    });
  }
  return results;
}

async function stpartsApiRequest(
  path: string,
  params: URLSearchParams,
  signal: AbortSignal,
  timeoutMs: number,
  credentials?: StpartsCredentials,
  options: StpartsApiRequestOptions = {},
): Promise<unknown> {
  const config = getStpartsApiConfig(credentials);
  if (!config) {
    throw new SupplierAuthError("STParts API credentials are not configured");
  }
  const url = new URL(path, config.url);
  params.set("userlogin", config.login);
  params.set("userpsw", createHash("md5").update(config.password).digest("hex"));
  const method = options.method ?? "GET";
  if (method === "GET") {
    url.search = params.toString();
  }
  const response = await siteHttpRequest(url, {
    headers: {
      Accept: "application/json",
      ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    signal,
    timeoutMs,
    method,
    body: method === "POST" ? params.toString() : undefined,
  });
  let payload: unknown;
  try {
    payload = JSON.parse(response.body);
  } catch {
    throw new SupplierIntegrationError("STParts API returned invalid JSON");
  }
  const errorCodeValue = payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as { errorCode?: unknown }).errorCode
    : null;
  const errorCode = typeof errorCodeValue === "number" || typeof errorCodeValue === "string"
    ? Number(errorCodeValue)
    : null;
  if (response.status === 401 || response.status === 403 || errorCode === 102 || errorCode === 103 || errorCode === 104) {
    throw new SupplierAuthError("STParts API rejected the configured credentials");
  }
  if (response.status < 200 || response.status >= 300) {
    if ((path === "search/articles/" || path === "search/batch") && errorCode === 301) {
      return [];
    }
    throw new SupplierIntegrationError(`STParts API returned HTTP ${response.status}`);
  }
  return payload;
}

export function createStpartsBatchParams(brands: string[], article: string): URLSearchParams[] {
  const batches: URLSearchParams[] = [];
  for (let offset = 0; offset < brands.length; offset += stpartsBatchSize) {
    const params = new URLSearchParams();
    for (const [index, brand] of brands.slice(offset, offset + stpartsBatchSize).entries()) {
      params.set(`search[${index}][brand]`, brand);
      params.set(`search[${index}][number]`, article);
    }
    batches.push(params);
  }
  return batches;
}

async function searchStpartsBrands(
  brands: string[],
  article: string,
  signal: AbortSignal,
  timeoutMs: number,
  credentials: StpartsCredentials | undefined,
  request: StpartsApiRequester,
): Promise<unknown[]> {
  return Promise.all(createStpartsBatchParams(brands, article).map((params) => request(
    "search/batch",
    params,
    signal,
    timeoutMs,
    credentials,
    { method: "POST" },
  )));
}

export async function verifyStpartsApiCredentials(credentials: StpartsCredentials): Promise<void> {
  await stpartsApiRequest(
    "user/info",
    new URLSearchParams(),
    AbortSignal.timeout(10_000),
    10_000,
    credentials,
  );
}

export class StpartsApiAdapter implements SupplierAdapter {
  readonly id = "stparts";
  readonly displayName = "STParts";
  readonly timeoutMs = Number(process.env.STPARTS_SEARCH_TIMEOUT_MS ?? "10000");
  private readonly request: StpartsApiRequester;
  private readonly searchCache = new Map<string, CachedStpartsSearch>();
  private readonly searchesInProgress = new Map<string, StpartsSearchInProgress>();

  constructor(request: StpartsApiRequester = stpartsApiRequest) {
    this.request = request;
  }

  async ensureSession(sessionManager: SupplierSessionManager): Promise<SupplierSessionState> {
    return getStpartsApiConfig(sessionManager.getStpartsCredentials() ?? undefined)
      ? sessionManager.markChecked(this.id, "STParts API credentials are configured")
      : sessionManager.markUnauthorized(this.id, "STParts API credentials are not configured");
  }

  async validateSession(context: SupplierSearchContext, sessionManager: SupplierSessionManager): Promise<void> {
    await this.request(
      "user/info",
      new URLSearchParams(),
      context.signal,
      context.timeoutMs,
      sessionManager.getStpartsCredentials() ?? undefined,
    );
  }

  async search(
    query: SearchQuery,
    context: SupplierSearchContext,
    onResult: (result: NormalizedSearchResult) => void,
    sessionManager: SupplierSessionManager,
  ): Promise<void> {
    const article = query.article.trim();
    const credentials = sessionManager.getStpartsCredentials() ?? undefined;
    const config = getStpartsApiConfig(credentials);
    if (!config) {
      throw new SupplierAuthError("STParts API credentials are not configured");
    }
    const cacheKey = createHash("sha256")
      .update(`${config.login}\0${config.password}\0${normalizeArticle(article)}`)
      .digest("hex");
    const cached = this.searchCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      cached.results.forEach(onResult);
      return;
    }
    if (cached) {
      this.searchCache.delete(cacheKey);
    }

    let search = this.searchesInProgress.get(cacheKey);
    if (!search) {
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(new SupplierTimeoutError(`STParts search timed out after ${context.timeoutMs}ms`)),
        context.timeoutMs,
      );
      const promise = this.searchUncached(article, cacheKey, controller.signal, context.timeoutMs, credentials);
      search = { controller, promise, waiters: 0 };
      this.searchesInProgress.set(cacheKey, search);
      void promise.finally(() => {
        clearTimeout(timeoutId);
        if (this.searchesInProgress.get(cacheKey)?.promise === promise) {
          this.searchesInProgress.delete(cacheKey);
        }
      }).catch(() => undefined);
    }
    search.waiters += 1;
    try {
      const results = await this.waitForSearch(search.promise, context.signal);
      results.forEach(onResult);
    } finally {
      search.waiters -= 1;
      if (search.waiters === 0 && this.searchesInProgress.get(cacheKey) === search) {
        search.controller.abort(context.signal.reason ?? new Error("STParts search has no active clients"));
      }
    }
  }

  private async waitForSearch(searchPromise: Promise<NormalizedSearchResult[]>, signal: AbortSignal): Promise<NormalizedSearchResult[]> {
    if (signal.aborted) {
      throw signal.reason;
    }
    let rejectAbort: (reason: unknown) => void = () => undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const abort = () => rejectAbort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    try {
      return await Promise.race([searchPromise, aborted]);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  private async searchUncached(
    article: string,
    cacheKey: string,
    signal: AbortSignal,
    timeoutMs: number,
    credentials: StpartsCredentials | undefined,
  ): Promise<NormalizedSearchResult[]> {
    const brandsPayload = await this.request("search/brands/", new URLSearchParams({ number: article, useOnlineStocks: "0" }), signal, timeoutMs, credentials);
    const brands = [...new Set(abcpItems(brandsPayload, "brand")
      .filter((value): value is AbcpBrand => Boolean(value) && typeof value === "object" && !Array.isArray(value))
      .map((value) => typeof value.brand === "string" ? value.brand.trim() : "")
      .filter(Boolean))];
    const articlePayloads = await searchStpartsBrands(brands, article, signal, timeoutMs, credentials, this.request);
    const results = articlePayloads.flatMap((payload) => parseStpartsApiResults(payload, article));

    if (this.searchCache.size >= stpartsSearchCacheMaxEntries) {
      const oldestKey = this.searchCache.keys().next().value;
      if (typeof oldestKey === "string") {
        this.searchCache.delete(oldestKey);
      }
    }
    this.searchCache.set(cacheKey, { expiresAt: Date.now() + stpartsSearchCacheTtlMs, results });
    return results;
  }
}
