import { randomUUID } from "node:crypto";
import { Agent, request as httpsRequest } from "node:https";
import type { SupplierSessionManager } from "../../session/session-manager.ts";
import type { NormalizedSearchResult, SearchQuery, SupplierSearchContext, SupplierSessionState } from "../../types.ts";
import { SupplierAuthError } from "../errors.ts";
import type { SupplierAdapter } from "../supplier-adapter.ts";
import { getRosskoAuthorizationSession, hasRosskoStorageState, rosskoBusinessUrl } from "./rossko-site-auth.ts";

interface RosskoDeliverySchema {
  types?: Array<{ value?: string; selected?: boolean }>;
  addresses?: Array<{ pointGuid?: string; selected?: boolean }>;
}

interface RosskoSearchItem {
  id?: string;
  article?: string;
  part?: { price?: number };
}

interface RosskoSearchResponse {
  errorFlag?: boolean;
  results?: Array<{ searchResults?: RosskoSearchItem[] }>;
}

interface RosskoCardStock {
  name?: string;
  basePrice?: number;
  inventory?: number;
  isApproximateDeliveryInterval?: boolean;
  tariffDeliveryTimingWithTimezone?: { start?: string; end?: string };
  cartItemDto?: { stock_name?: string };
}

interface RosskoCardPart {
  guid?: string;
  brandName?: string;
  partNumber?: string;
  goodsName?: string;
  stocks?: RosskoCardStock[];
}

interface RosskoCardResponse {
  isAuthorized?: boolean;
  mainPart?: RosskoCardPart;
}

const requestAttempts = Math.max(1, Number(process.env.ROSSKO_API_REQUEST_ATTEMPTS ?? "3"));
const hedgeDelayMs = Math.max(100, Number(process.env.ROSSKO_API_HEDGE_DELAY_MS ?? "1200"));
const requestTimeoutMs = Math.max(1000, Number(process.env.ROSSKO_API_REQUEST_TIMEOUT_MS ?? "6000"));
const cardRequestConcurrency = 12;
const rosskoHttpsAgent = new Agent({ keepAlive: true, family: 4, maxSockets: 6 });

let cachedDeliverySettings: {
  authorizationSession: string;
  addressGuid: string;
  deliveryType: string;
} | null = null;

function normalizeArticle(value: string): string {
  return value.replace(/[^A-Z0-9А-Я]/gi, "").toUpperCase();
}

export function rosskoExactProductIds(search: RosskoSearchResponse, article: string): string[] {
  const target = normalizeArticle(article);
  return [...new Set(search.results?.flatMap((group) =>
    (group.searchResults || []).flatMap((candidate) => {
      const price = candidate.part?.price;
      return candidate.id &&
        normalizeArticle(candidate.article || "") === target &&
        typeof price === "number" &&
        Number.isFinite(price) &&
        price > 0
        ? [candidate.id]
        : [];
    }),
  ) || [])];
}

function serviceUrl(service: string, path: string): URL {
  const businessUrl = new URL(rosskoBusinessUrl);
  const city = businessUrl.hostname.split(".")[0];
  return new URL(path, `${businessUrl.protocol}//${city}-${service}.rossko.ru/`);
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function rosskoRequest<T>(url: URL, signal: AbortSignal): Promise<T> {
  const authorizationSession = getRosskoAuthorizationSession();
  if (!authorizationSession) {
    throw new SupplierAuthError("Rossko stored session is not available");
  }

  const groupController = new AbortController();
  const abortGroup = () => groupController.abort(signal.reason);
  signal.addEventListener("abort", abortGroup, { once: true });

  const runAttempt = async (attempt: number): Promise<T> => {
    if (attempt > 1) {
      await waitForRetry(hedgeDelayMs * (attempt - 1), groupController.signal);
    }

    const attemptController = new AbortController();
    const abortAttempt = () => attemptController.abort(groupController.signal.reason);
    const timeout = setTimeout(
      () => attemptController.abort(new Error(`Rossko API request timed out after ${requestTimeoutMs}ms`)),
      requestTimeoutMs,
    );
    groupController.signal.addEventListener("abort", abortAttempt, { once: true });

    try {
      const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const request = httpsRequest(url, {
          method: "GET",
          family: 4,
          agent: rosskoHttpsAgent,
          signal: attemptController.signal,
          headers: {
            Accept: "application/json, text/plain, */*",
            "Authorization-Domain": new URL(rosskoBusinessUrl).origin,
            "Authorization-Session": authorizationSession,
            Referer: rosskoBusinessUrl,
            Source: "frontend",
          },
        }, (incoming) => {
          let body = "";
          incoming.setEncoding("utf-8");
          incoming.on("data", (chunk) => { body += chunk; });
          incoming.on("end", () => resolve({ status: incoming.statusCode || 0, body }));
        });
        request.on("error", reject);
        request.end();
      });

      if (response.status === 401 || response.status === 403) {
        throw new SupplierAuthError(`Rossko API returned HTTP ${response.status}`);
      }
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Rossko API returned HTTP ${response.status}`);
      }
      return JSON.parse(response.body) as T;
    } finally {
      clearTimeout(timeout);
      groupController.signal.removeEventListener("abort", abortAttempt);
    }
  };

  try {
    const result = await Promise.any(
      Array.from({ length: requestAttempts }, (_, index) => runAttempt(index + 1)),
    );
    groupController.abort();
    return result;
  } catch (error) {
    if (signal.aborted) {
      throw signal.reason;
    }
    const errors = error instanceof AggregateError ? error.errors : [error];
    const authError = errors.find((candidate) => candidate instanceof SupplierAuthError);
    throw authError || errors.at(-1) || new Error("Rossko API request failed");
  } finally {
    groupController.abort();
    signal.removeEventListener("abort", abortGroup);
  }
}

function selectedValue<T extends { selected?: boolean }>(items: T[] | undefined): T | undefined {
  return items?.find((item) => item.selected);
}

async function getDeliverySettings(signal: AbortSignal): Promise<{ addressGuid: string; deliveryType: string }> {
  const authorizationSession = getRosskoAuthorizationSession();
  if (!authorizationSession) {
    throw new SupplierAuthError("Rossko stored session is not available");
  }
  if (cachedDeliverySettings?.authorizationSession === authorizationSession) {
    return cachedDeliverySettings;
  }

  const deliveryUrl = serviceUrl("productcard", "/api/Delivery/GetDeliverySchema");
  deliveryUrl.searchParams.set("newCart", "true");
  const delivery = await rosskoRequest<RosskoDeliverySchema>(deliveryUrl, signal);
  const addressGuid = selectedValue(delivery.addresses)?.pointGuid;
  const deliveryType = selectedValue(delivery.types)?.value;

  if (!addressGuid || !deliveryType) {
    throw new Error("Rossko API did not return delivery settings");
  }

  cachedDeliverySettings = { authorizationSession, addressGuid, deliveryType };
  return cachedDeliverySettings;
}

function productLink(part: RosskoCardPart, article: string): string {
  const url = new URL("/product", rosskoBusinessUrl);
  if (part.guid) {
    url.searchParams.set("text", part.guid);
  }
  url.searchParams.set("q", article);
  return url.toString();
}

export class RosskoSiteApiAdapter implements SupplierAdapter {
  readonly id = "rossko";
  readonly displayName = "Rossko";
  readonly timeoutMs = Number(process.env.ROSSKO_SEARCH_TIMEOUT_MS ?? "30000");

  async ensureSession(sessionManager: SupplierSessionManager): Promise<SupplierSessionState> {
    if (hasRosskoStorageState() && getRosskoAuthorizationSession()) {
      return sessionManager.markChecked(this.id, "Rossko stored API session is available");
    }

    return sessionManager.markUnauthorized(this.id, "Rossko login is required");
  }

  async search(
    query: SearchQuery,
    context: SupplierSearchContext,
    onResult: (result: NormalizedSearchResult) => void,
    _sessionManager: SupplierSessionManager,
  ): Promise<void> {
    const article = query.article.trim();
    const { addressGuid, deliveryType } = await getDeliverySettings(context.signal);
    const searchUrl = serviceUrl("searchresult", "/api/Search");
    searchUrl.search = new URLSearchParams({
      searchString: article,
      CurrencyCode: "643",
      tariffTimings: "true",
      addressGuid,
      deliveryType,
      newCart: "true",
      isFullTextSearch: "false",
      sid: randomUUID().replaceAll("-", ""),
      oemCatalog: "true",
    }).toString();
    const search = await rosskoRequest<RosskoSearchResponse>(searchUrl, context.signal);
    const target = normalizeArticle(article);
    const productIds = rosskoExactProductIds(search, article);

    if (search.errorFlag || !productIds.length) {
      return;
    }

    const searchProductCard = async (productId: string) => {
      const cardUrl = serviceUrl("productcard", `/api/Product/Card/${encodeURIComponent(productId)}`);
      cardUrl.search = new URLSearchParams({
        CurrencyCode: "643",
        tariffTimings: "true",
        newCart: "true",
        addressGuid,
        deliveryType,
      }).toString();
      const card = await rosskoRequest<RosskoCardResponse>(cardUrl, context.signal);

      if (card.isAuthorized === false) {
        throw new SupplierAuthError("Rossko API session is no longer authorized");
      }

      const part = card.mainPart;
      if (!part || normalizeArticle(part.partNumber || "") !== target) {
        return;
      }
      const brand = part.brandName?.trim();
      const partNumber = part.partNumber?.trim();
      const title = part.goodsName?.trim();
      if (!brand || !partNumber || !title) {
        return;
      }

      for (const stock of part.stocks || []) {
        if (!stock.basePrice || stock.basePrice <= 0 || !stock.inventory || stock.inventory <= 0) {
          continue;
        }

        onResult({
          supplier: this.id,
          brand,
          article: partNumber,
          title,
          price: stock.basePrice,
          warehouse: stock.name || stock.cartItemDto?.stock_name || null,
          warehouseFull: stock.name || stock.cartItemDto?.stock_name || null,
          deliveryDate: stock.tariffDeliveryTimingWithTimezone?.start || stock.tariffDeliveryTimingWithTimezone?.end || null,
          deliveryDateApproximate: Boolean(stock.isApproximateDeliveryInterval),
          link: productLink(part, query.article),
        });
      }
    };

    for (let index = 0; index < productIds.length; index += cardRequestConcurrency) {
      await Promise.all(productIds.slice(index, index + cardRequestConcurrency).map(searchProductCard));
    }

  }
}
