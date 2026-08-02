import { randomUUID } from "node:crypto";
import { Agent, request as httpsRequest } from "node:https";
import { rosskoConfig, supplierMaxResponseBytes } from "../../config.ts";
import type { SupplierSessionManager } from "../../session/session-manager.ts";
import type { NormalizedSearchResult, SearchQuery, SupplierSearchContext, SupplierSessionState } from "../../types.ts";
import { SupplierAuthError, SupplierIntegrationError, SupplierTimeoutError } from "../errors.ts";
import { isJsonContentType } from "../fetch-json.ts";
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
  inventory?: unknown;
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

const requestAttempts = rosskoConfig.apiRequestAttempts;
const hedgeDelayMs = rosskoConfig.apiHedgeDelayMs;
const requestTimeoutMs = rosskoConfig.apiRequestTimeoutMs;
const cardRequestConcurrency = 12;
const rosskoHttpsAgent = new Agent({ keepAlive: true, family: 4, maxSockets: 6 });

export function closeRosskoHttpAgent(): void {
  rosskoHttpsAgent.destroy();
}

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

export function parseRosskoQuantity(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= Number.MAX_SAFE_INTEGER
    ? value
    : null;
}

function serviceUrl(service: string, path: string): URL {
  const businessUrl = new URL(rosskoBusinessUrl);
  const city = businessUrl.hostname.split(".")[0];
  return new URL(path, `${businessUrl.protocol}//${city}-${service}.rossko.ru/`);
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
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

function hasTimeoutCause(error: unknown): boolean {
  if (error instanceof SupplierTimeoutError) {
    return true;
  }
  return error instanceof Error && hasTimeoutCause(error.cause);
}

async function rosskoRequest<T>(url: URL, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
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
      () => attemptController.abort(new SupplierTimeoutError(`Rossko API request timed out after ${requestTimeoutMs}ms`)),
      requestTimeoutMs,
    );
    groupController.signal.addEventListener("abort", abortAttempt, { once: true });

    try {
      const response = await new Promise<{ status: number; body: string; contentType: string | null }>((resolve, reject) => {
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
          const chunks: Buffer[] = [];
          let bodyBytes = 0;
          incoming.on("error", reject);
          incoming.on("aborted", () => reject(new SupplierIntegrationError("Rossko API response was interrupted")));
          const declaredLength = Number(incoming.headers["content-length"]);
          if (Number.isFinite(declaredLength) && declaredLength > supplierMaxResponseBytes) {
            incoming.destroy(new SupplierIntegrationError("Rossko API response is too large"));
            return;
          }
          incoming.on("data", (chunk: Buffer) => {
            bodyBytes += chunk.byteLength;
            if (bodyBytes > supplierMaxResponseBytes) {
              incoming.destroy(new SupplierIntegrationError("Rossko API response is too large"));
              return;
            }
            chunks.push(chunk);
          });
          incoming.on("end", () => resolve({
            status: incoming.statusCode || 0,
            body: Buffer.concat(chunks).toString("utf-8"),
            contentType: typeof incoming.headers["content-type"] === "string" ? incoming.headers["content-type"] : null,
          }));
        });
        request.on("error", reject);
        request.end();
      });

      if (response.status === 401 || response.status === 403) {
        throw new SupplierAuthError(`Rossko API returned HTTP ${response.status}`);
      }
      if (response.status < 200 || response.status >= 300) {
        throw new SupplierIntegrationError(`Rossko API returned HTTP ${response.status}`);
      }
      if (!isJsonContentType(response.contentType)) {
        throw new SupplierIntegrationError("Rossko API returned an unexpected content type");
      }
      try {
        return JSON.parse(response.body) as T;
      } catch (error) {
        throw new SupplierIntegrationError("Rossko API returned invalid JSON", { cause: error });
      }
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
    if (authError) {
      throw authError;
    }
    const timeoutError = errors.find(hasTimeoutCause);
    if (timeoutError) {
      throw timeoutError instanceof SupplierTimeoutError
        ? timeoutError
        : new SupplierTimeoutError("Rossko API request timed out", { cause: timeoutError });
    }
    const lastError = errors.at(-1);
    throw lastError instanceof SupplierIntegrationError
      ? lastError
      : new SupplierIntegrationError("Rossko API request failed", { cause: lastError });
  } finally {
    groupController.abort();
    signal.removeEventListener("abort", abortGroup);
  }
}

function selectedValue<T extends { selected?: boolean }>(items: T[] | undefined): T | undefined {
  return items?.find((item) => item.selected);
}

async function getDeliverySettings(signal: AbortSignal, forceRefresh = false): Promise<{ addressGuid: string; deliveryType: string }> {
  const authorizationSession = getRosskoAuthorizationSession();
  if (!authorizationSession) {
    throw new SupplierAuthError("Rossko stored session is not available");
  }
  if (!forceRefresh && cachedDeliverySettings?.authorizationSession === authorizationSession) {
    signal.throwIfAborted();
    return cachedDeliverySettings;
  }

  const deliveryUrl = serviceUrl("productcard", "/api/Delivery/GetDeliverySchema");
  deliveryUrl.searchParams.set("newCart", "true");
  const delivery = await rosskoRequest<RosskoDeliverySchema>(deliveryUrl, signal);
  const addressGuid = selectedValue(delivery.addresses)?.pointGuid;
  const deliveryType = selectedValue(delivery.types)?.value;

  if (!addressGuid || !deliveryType) {
    throw new SupplierIntegrationError("Rossko API did not return delivery settings");
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
  readonly timeoutMs = rosskoConfig.searchTimeoutMs;

  async ensureSession(sessionManager: SupplierSessionManager): Promise<SupplierSessionState> {
    if (hasRosskoStorageState() && getRosskoAuthorizationSession()) {
      return sessionManager.markChecked(this.id, "Rossko stored API session is available");
    }

    return sessionManager.markUnauthorized(this.id, "Rossko login is required");
  }

  async validateSession(context: SupplierSearchContext, _sessionManager: SupplierSessionManager): Promise<void> {
    await getDeliverySettings(context.signal, true);
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
    if (search.errorFlag) {
      throw new SupplierIntegrationError("Rossko API reported a search failure");
    }
    if (!Array.isArray(search.results)) {
      throw new SupplierIntegrationError("Rossko API returned an invalid search response");
    }
    if (search.results.some((group) => !group || typeof group !== "object" || !Array.isArray(group.searchResults))) {
      throw new SupplierIntegrationError("Rossko API returned invalid search result groups");
    }
    const target = normalizeArticle(article);
    const productIds = rosskoExactProductIds(search, article);

    if (!productIds.length) {
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
      if (!part) {
        throw new SupplierIntegrationError("Rossko API returned a product card without product data");
      }
      if (normalizeArticle(part.partNumber || "") !== target) {
        return;
      }
      const brand = part.brandName?.trim();
      const partNumber = part.partNumber?.trim();
      const title = part.goodsName?.trim();
      if (!brand || !partNumber || !title) {
        throw new SupplierIntegrationError("Rossko API returned incomplete product data");
      }
      if (!Array.isArray(part.stocks)) {
        throw new SupplierIntegrationError("Rossko API returned invalid product stocks");
      }

      for (const stock of part.stocks) {
        context.signal.throwIfAborted();
        const quantity = parseRosskoQuantity(stock.inventory);
        if (!stock.basePrice || stock.basePrice <= 0 || quantity === null) {
          continue;
        }

        onResult({
          supplier: this.id,
          brand,
          article: partNumber,
          title,
          price: stock.basePrice,
          quantity,
          warehouse: stock.name || stock.cartItemDto?.stock_name || null,
          warehouseFull: stock.name || stock.cartItemDto?.stock_name || null,
          deliveryDate: stock.tariffDeliveryTimingWithTimezone?.start || stock.tariffDeliveryTimingWithTimezone?.end || null,
          deliveryDateApproximate: Boolean(stock.isApproximateDeliveryInterval),
          link: productLink(part, query.article),
        });
      }
    };

    for (let index = 0; index < productIds.length; index += cardRequestConcurrency) {
      context.signal.throwIfAborted();
      await Promise.all(productIds.slice(index, index + cardRequestConcurrency).map(searchProductCard));
    }

  }
}
