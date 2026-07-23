import type { SupplierSessionManager } from "../../session/session-manager.ts";
import { getStateFilePath } from "../../config.ts";
import type { NormalizedSearchResult, SearchQuery, SupplierSearchContext, SupplierSessionState } from "../../types.ts";
import { SupplierAuthError } from "../errors.ts";
import type { SupplierAdapter } from "../supplier-adapter.ts";
import { getStpartsCookieHeader, getStpartsSharedBrowser, hasStpartsStorageState, stpartsBaseUrl } from "./stparts-site-auth.ts";

interface StpartsApiResult {
  brand: string;
  article: string;
  title: string;
  price: number;
  warehouse: string | null;
  warehouseColor: "green" | "blue" | "red" | null;
  warehouseRating: string | null;
  deliveryDate: string | null;
  deliveryDateTo: string | null;
  link: string;
}

function normalizeArticle(value: string): string {
  return value.replace(/[^A-Z0-9]/gi, "").toUpperCase();
}

function decodeHtml(value: string): string {
  return value
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function attribute(block: string, name: string): string | null {
  return block.match(new RegExp(`${name}=["']([^"']*)["']`, "i"))?.[1] || null;
}

function cell(block: string, className: string): string {
  const match = block.match(new RegExp(`<td\\b[^>]*class=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>([\\s\\S]*?)(?=<td\\b|<\\/tr>)`, "i"));
  return decodeHtml(match?.[1] || "");
}

function dateFromHours(value: string | null): string | null {
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours < 0) {
    return null;
  }
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + Math.ceil(hours / 24)).toISOString();
}

function resultBlocks(html: string): string[] {
  const starts = [...html.matchAll(/<tr\b[^>]*class=["'][^"']*\bresultTr2(?:Group|Route)?\b[^"']*["'][^>]*>/gi)]
    .map((match) => match.index);
  return starts.map((start, index) => html.slice(start, starts[index + 1] ?? html.length));
}

export function parseStpartsResults(html: string, requestedArticle: string, pageUrl: string): StpartsApiResult[] {
  const target = normalizeArticle(requestedArticle);
  const results: StpartsApiResult[] = [];

  for (const block of resultBlocks(html)) {
    if (attribute(block, "data-is-request-article") !== "1") {
      continue;
    }
    const article = requestedArticle;
    const price = Number(attribute(block, "data-output-price"));
    const brand = cell(block, "resultBrand");
    const title = cell(block, "resultDescription");
    if (normalizeArticle(article) !== target || !brand || !title || !Number.isFinite(price) || price <= 0 || Number(attribute(block, "data-availability")) === 0) {
      continue;
    }
    const warehouseMatch = block.match(/<td\b[^>]*class=["'][^"']*\bresultWarehouse\b[^"']*["'][^>]*>[\s\S]*?<font\b[^>]*color=["']?(green|blue|red)["']?[^>]*>([\s\S]*?)<\/font>/i);
    const ratingMatch = block.match(/class=["'][^"']*supplier-rating-badge[^"']*["'][^>]*>([^<]+)/i);
    const linkMatch = block.match(/<a\b[^>]*href=["']([^"']+)["'][^>]*class=["'][^"']*searchInfoLink/i);
    const warehouseColor = warehouseMatch?.[1]?.toLowerCase();

    const link = linkMatch ? new URL(decodeHtml(linkMatch[1]), stpartsBaseUrl) : new URL(pageUrl);
    if (link.protocol !== "https:" || link.origin !== new URL(stpartsBaseUrl).origin) {
      continue;
    }
    results.push({
      brand,
      article,
      title,
      price,
      warehouse: warehouseMatch ? decodeHtml(warehouseMatch[2]) : null,
      warehouseColor: warehouseColor === "green" || warehouseColor === "blue" || warehouseColor === "red" ? warehouseColor : null,
      warehouseRating: ratingMatch ? decodeHtml(ratingMatch[1]).replace(",", ".") : null,
      deliveryDate: dateFromHours(attribute(block, "data-deadline")),
      deliveryDateTo: dateFromHours(attribute(block, "data-deadline-max")),
      link: link.toString(),
    });
  }
  return results;
}

async function requestPage(page: any, url: URL, timeoutMs: number): Promise<string> {
  const response = await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: timeoutMs });
  const html = await page.content();
  if (response?.status() === 401 || response?.status() === 403 || /id=["']lgnform["']|id=["']login["']/i.test(html)) {
    throw new SupplierAuthError("STParts session is not authorized");
  }
  if (!response || !response.ok()) {
    throw new Error(`STParts returned HTTP ${response?.status() ?? 0}`);
  }
  return html;
}

function exactSearchUrl(html: string, article: string): URL | null {
  const target = normalizeArticle(article);
  let result: URL | null = null;
  for (const match of html.matchAll(/href=["']([^"']*\/search\/([^/"']+)\/([^?"']+))[^"']*["']/gi)) {
    if (normalizeArticle(decodeHtml(match[3])) === target) {
      const url = new URL(decodeHtml(match[1]), stpartsBaseUrl);
      if (url.protocol === "https:" && url.origin === new URL(stpartsBaseUrl).origin) {
        result = url;
      }
    }
  }
  return result;
}

interface CachedSearchUrl {
  url: string;
  expiresAt: number;
}

export class StpartsSearchUrlCache {
  private readonly entries = new Map<string, CachedSearchUrl>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(ttlMs = 5 * 60_000, maxEntries = 100) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
  }

  get(article: string, now = Date.now()): URL | null {
    const key = normalizeArticle(article);
    const cached = this.entries.get(key);
    if (!cached || cached.expiresAt <= now) {
      this.entries.delete(key);
      return null;
    }
    this.entries.delete(key);
    this.entries.set(key, cached);
    return new URL(cached.url);
  }

  set(article: string, url: URL, now = Date.now()): void {
    const key = normalizeArticle(article);
    this.entries.delete(key);
    this.entries.set(key, { url: url.toString(), expiresAt: now + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey) {
        this.entries.delete(oldestKey);
      }
    }
  }
}

export class StpartsApiAdapter implements SupplierAdapter {
  readonly id = "stparts";
  readonly displayName = "STParts";
  readonly timeoutMs = Number(process.env.STPARTS_SEARCH_TIMEOUT_MS ?? "30000");
  private readonly searchUrlCache = new StpartsSearchUrlCache();

  async ensureSession(sessionManager: SupplierSessionManager): Promise<SupplierSessionState> {
    return hasStpartsStorageState() && getStpartsCookieHeader()
      ? sessionManager.markChecked(this.id, "STParts stored HTTP session is available")
      : sessionManager.markUnauthorized(this.id, "STParts login is required");
  }

  async search(
    query: SearchQuery,
    context: SupplierSearchContext,
    onResult: (result: NormalizedSearchResult) => void,
    _sessionManager: SupplierSessionManager,
  ): Promise<void> {
    const article = query.article.trim();
    const initialUrl = new URL("/search", stpartsBaseUrl);
    initialUrl.searchParams.set("pcode", article);
    const browser = await getStpartsSharedBrowser();
    let browserContext: any | null = null;
    const closeOnAbort = () => browserContext?.close().catch(() => undefined);
    context.signal.addEventListener("abort", closeOnAbort, { once: true });

    try {
      browserContext = await browser.newContext({ storageState: getStateFilePath("stparts-storage-state.json") });
      const page = await browserContext.newPage();
      let exactUrl = this.searchUrlCache.get(article);
      if (!exactUrl) {
        const initialHtml = await requestPage(page, initialUrl, context.timeoutMs);
        exactUrl = exactSearchUrl(initialHtml, article);
        if (exactUrl) {
          this.searchUrlCache.set(article, exactUrl);
        }
      }
      if (!exactUrl) {
        return;
      }

      const html = await requestPage(page, exactUrl, context.timeoutMs);
      const results = parseStpartsResults(html, article, exactUrl.toString());
      for (const result of results) {
        onResult({
          supplier: this.id,
          brand: result.brand,
          article: result.article,
          title: result.title,
          price: result.price,
          warehouse: result.warehouse,
          warehouseColor: result.warehouseColor,
          warehouseRating: result.warehouseRating,
          deliveryDate: result.deliveryDate,
          deliveryDateTo: result.deliveryDateTo,
          deliveryDateApproximate: false,
          link: result.link,
        });
      }
    } finally {
      context.signal.removeEventListener("abort", closeOnAbort);
      await browserContext?.close().catch(() => undefined);
    }
  }
}
