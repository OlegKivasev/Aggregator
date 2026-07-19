import type { SupplierSessionManager } from "../../session/session-manager.ts";
import type { NormalizedSearchResult, SearchQuery, SupplierSearchContext, SupplierSessionState } from "../../types.ts";
import { SupplierAuthError } from "../errors.ts";
import { siteHttpRequest } from "../site-http.ts";
import type { SupplierAdapter } from "../supplier-adapter.ts";
import { getStpartsCookieHeader, hasStpartsStorageState, stpartsBaseUrl } from "./stparts-site-auth.ts";

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

function parseResults(html: string, requestedArticle: string, pageUrl: string): StpartsApiResult[] {
  const target = normalizeArticle(requestedArticle);
  const results: StpartsApiResult[] = [];

  for (const block of resultBlocks(html)) {
    if (attribute(block, "data-is-request-article") !== "1") {
      continue;
    }
    const article = requestedArticle;
    const price = Number(attribute(block, "data-output-price"));
    if (normalizeArticle(article) !== target || !Number.isFinite(price) || price <= 0 || Number(attribute(block, "data-availability")) === 0) {
      continue;
    }
    const warehouseMatch = block.match(/<td\b[^>]*class=["'][^"']*\bresultWarehouse\b[^"']*["'][^>]*>[\s\S]*?<font\b[^>]*color=["']?(green|blue|red)["']?[^>]*>([\s\S]*?)<\/font>/i);
    const ratingMatch = block.match(/class=["'][^"']*supplier-rating-badge[^"']*["'][^>]*>([^<]+)/i);
    const linkMatch = block.match(/<a\b[^>]*href=["']([^"']+)["'][^>]*class=["'][^"']*searchInfoLink/i);
    const warehouseColor = warehouseMatch?.[1]?.toLowerCase();

    results.push({
      brand: cell(block, "resultBrand") || "STParts",
      article,
      title: cell(block, "resultDescription") || article,
      price,
      warehouse: warehouseMatch ? decodeHtml(warehouseMatch[2]) : null,
      warehouseColor: warehouseColor === "green" || warehouseColor === "blue" || warehouseColor === "red" ? warehouseColor : null,
      warehouseRating: ratingMatch ? decodeHtml(ratingMatch[1]).replace(",", ".") : null,
      deliveryDate: dateFromHours(attribute(block, "data-deadline")),
      deliveryDateTo: dateFromHours(attribute(block, "data-deadline-max")),
      link: linkMatch ? new URL(decodeHtml(linkMatch[1]), stpartsBaseUrl).toString() : pageUrl,
    });
  }
  return results;
}

async function requestPage(url: URL, signal: AbortSignal): Promise<string> {
  const cookie = getStpartsCookieHeader();
  if (!cookie) {
    throw new SupplierAuthError("STParts stored session is not available");
  }
  const response = await siteHttpRequest(url, { cookie, signal, headers: { Referer: stpartsBaseUrl } });
  if (response.status === 401 || response.status === 403) {
    throw new SupplierAuthError("STParts session is not authorized");
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`STParts returned HTTP ${response.status}`);
  }
  return response.body;
}

function exactSearchUrl(html: string, article: string): URL | null {
  const target = normalizeArticle(article);
  let result: URL | null = null;
  for (const match of html.matchAll(/href=["']([^"']*\/search\/([^/"']+)\/([^?"']+))[^"']*["']/gi)) {
    if (normalizeArticle(decodeHtml(match[3])) === target) {
      result = new URL(decodeHtml(match[1]), stpartsBaseUrl);
    }
  }
  return result;
}

export class StpartsApiAdapter implements SupplierAdapter {
  readonly id = "stparts";
  readonly displayName = "STParts";
  readonly timeoutMs = Number(process.env.STPARTS_SEARCH_TIMEOUT_MS ?? "12000");

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
    const initialHtml = await requestPage(initialUrl, context.signal);
    const exactUrl = exactSearchUrl(initialHtml, article);
    if (!exactUrl) {
      return;
    }

    const html = await requestPage(exactUrl, context.signal);
    const results = parseResults(html, article, exactUrl.toString());
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
  }
}
