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

type RosskoRequestStage = "delivery-settings" | "search" | "product-card";

const rosskoStageLabels: Record<RosskoRequestStage, string> = {
  "delivery-settings": "получение параметров доставки",
  search: "поиск артикула",
  "product-card": "получение карточки товара",
};

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

function findTimeoutError(error: unknown): SupplierTimeoutError | null {
  if (error instanceof SupplierTimeoutError) {
    return error;
  }
  return error instanceof Error ? findTimeoutError(error.cause) : null;
}

function rosskoPublicMessage(stage: RosskoRequestStage, reason: string, diagnosticCode: string): string {
  return `этап «${rosskoStageLabels[stage]}»: ${reason} (код: ${diagnosticCode})`;
}

function rosskoIntegrationError(
  stage: RosskoRequestStage,
  suffix: string,
  reason: string,
  message: string,
  cause?: unknown,
): SupplierIntegrationError {
  const diagnosticCode = `rossko-${stage}-${suffix}`;
  return new SupplierIntegrationError(message, {
    ...(cause === undefined ? {} : { cause }),
    publicMessage: rosskoPublicMessage(stage, reason, diagnosticCode),
    diagnosticCode,
  });
}

function rosskoAuthError(
  stage: RosskoRequestStage,
  status?: number,
  rejectionReason?: "session-rejected",
): SupplierAuthError {
  const suffix = status ? `http-${status}` : rejectionReason || "session-missing";
  const diagnosticCode = `rossko-${stage}-${suffix}`;
  const reason = status
    ? `API отклонил сохранённую сессию, HTTP ${status}`
    : rejectionReason
      ? "API сообщил, что сохранённая сессия больше не авторизована"
      : "сохранённая API-сессия отсутствует";
  return new SupplierAuthError(`Rossko authorization failed during ${stage}`, {
    publicMessage: rosskoPublicMessage(stage, reason, diagnosticCode),
    diagnosticCode,
  });
}

function isRecord(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | null {
  let current = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    const code = "code" in current ? current.code : undefined;
    if (typeof code === "string" && /^[A-Z0-9_]+$/.test(code)) {
      return code;
    }
    current = current.cause;
  }
  return null;
}

function rosskoNetworkError(stage: RosskoRequestStage, cause: unknown): SupplierIntegrationError {
  const code = errorCode(cause);
  const knownFailures: Record<string, { suffix: string; reason: string }> = {
    ENOTFOUND: { suffix: "dns-not-found", reason: "DNS не смог найти адрес API Rossko" },
    EAI_AGAIN: { suffix: "dns-temporary", reason: "DNS временно не смог разрешить адрес API Rossko" },
    ECONNREFUSED: { suffix: "connection-refused", reason: "API Rossko отклонил сетевое соединение" },
    ECONNRESET: { suffix: "connection-reset", reason: "API Rossko сбросил сетевое соединение" },
    ETIMEDOUT: { suffix: "socket-timeout", reason: "истекло время установки сетевого соединения с API Rossko" },
    CERT_HAS_EXPIRED: { suffix: "tls-certificate-expired", reason: "TLS-сертификат API Rossko просрочен" },
    DEPTH_ZERO_SELF_SIGNED_CERT: { suffix: "tls-self-signed-certificate", reason: "TLS-сертификат API Rossko не прошёл проверку доверия" },
    SELF_SIGNED_CERT_IN_CHAIN: { suffix: "tls-self-signed-chain", reason: "цепочка TLS-сертификатов API Rossko не прошла проверку доверия" },
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: { suffix: "tls-unverified-certificate", reason: "TLS-сертификат API Rossko не удалось проверить" },
  };
  const failure = code ? knownFailures[code] : undefined;
  const safeCodeSuffix = code?.toLowerCase().replaceAll("_", "-");
  return rosskoIntegrationError(
    stage,
    failure?.suffix || (safeCodeSuffix ? `network-${safeCodeSuffix}` : "network-failure"),
    failure?.reason || (code
      ? `сетевой запрос к API Rossko завершился ошибкой ${code}`
      : "сетевой запрос к API Rossko завершился ошибкой"),
    `Rossko API request failed during ${stage}${code ? ` (${code})` : ""}`,
    cause,
  );
}

async function rosskoRequest<T>(url: URL, signal: AbortSignal, stage: RosskoRequestStage): Promise<T> {
  signal.throwIfAborted();
  const authorizationSession = getRosskoAuthorizationSession();
  if (!authorizationSession) {
    throw rosskoAuthError(stage);
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
      () => {
        const diagnosticCode = `rossko-${stage}-request-timeout`;
        attemptController.abort(new SupplierTimeoutError(`Rossko API request timed out after ${requestTimeoutMs}ms`, {
          publicMessage: rosskoPublicMessage(stage, `API не ответил за ${requestTimeoutMs} мс`, diagnosticCode),
          diagnosticCode,
        }));
      },
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
          incoming.on("aborted", () => reject(rosskoIntegrationError(
            stage,
            "response-interrupted",
            "API Rossko прервал передачу ответа",
            "Rossko API response was interrupted",
          )));
          const declaredLength = Number(incoming.headers["content-length"]);
          if (Number.isFinite(declaredLength) && declaredLength > supplierMaxResponseBytes) {
            incoming.destroy(rosskoIntegrationError(
              stage,
              "response-too-large",
              "ответ API Rossko превысил допустимый размер",
              "Rossko API response is too large",
            ));
            return;
          }
          incoming.on("data", (chunk: Buffer) => {
            bodyBytes += chunk.byteLength;
            if (bodyBytes > supplierMaxResponseBytes) {
              incoming.destroy(rosskoIntegrationError(
                stage,
                "response-too-large",
                "ответ API Rossko превысил допустимый размер",
                "Rossko API response is too large",
              ));
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
        throw rosskoAuthError(stage, response.status);
      }
      if (response.status < 200 || response.status >= 300) {
        throw rosskoIntegrationError(
          stage,
          `http-${response.status}`,
          `API Rossko вернул HTTP ${response.status}`,
          `Rossko API returned HTTP ${response.status}`,
        );
      }
      if (!isJsonContentType(response.contentType)) {
        throw rosskoIntegrationError(
          stage,
          "unexpected-content-type",
          "API Rossko вернул ответ не в формате JSON (возможна блокировка или страница ошибки)",
          "Rossko API returned an unexpected content type",
        );
      }
      try {
        return JSON.parse(response.body) as T;
      } catch (error) {
        throw rosskoIntegrationError(
          stage,
          "invalid-json",
          "API Rossko вернул повреждённый JSON",
          "Rossko API returned invalid JSON",
          error,
        );
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
    const timeoutError = errors.map(findTimeoutError).find((candidate) => candidate !== null);
    if (timeoutError) {
      throw timeoutError;
    }
    const lastError = errors.at(-1);
    throw lastError instanceof SupplierIntegrationError
      ? lastError
      : rosskoNetworkError(stage, lastError);
  } finally {
    groupController.abort();
    signal.removeEventListener("abort", abortGroup);
  }
}

export function selectRosskoDeliveryValue(
  items: Array<{ selected?: boolean; pointGuid?: string; value?: string }> | undefined,
  field: "pointGuid" | "value",
): string | undefined {
  const candidates = items?.flatMap((item) => {
    const value = item[field]?.trim();
    return value ? [{ selected: item.selected === true, value }] : [];
  }) || [];
  return candidates.find((candidate) => candidate.selected)?.value || candidates[0]?.value;
}

async function getDeliverySettings(signal: AbortSignal, forceRefresh = false): Promise<{ addressGuid: string; deliveryType: string }> {
  const authorizationSession = getRosskoAuthorizationSession();
  if (!authorizationSession) {
    throw rosskoAuthError("delivery-settings");
  }
  if (!forceRefresh && cachedDeliverySettings?.authorizationSession === authorizationSession) {
    signal.throwIfAborted();
    return cachedDeliverySettings;
  }

  const deliveryUrl = serviceUrl("productcard", "/api/Delivery/GetDeliverySchema");
  deliveryUrl.searchParams.set("newCart", "true");
  const delivery = await rosskoRequest<RosskoDeliverySchema>(deliveryUrl, signal, "delivery-settings");
  if (!isRecord(delivery)) {
    throw rosskoIntegrationError(
      "delivery-settings",
      "response-not-object",
      "API Rossko вернул корневой ответ не в виде объекта",
      "Rossko API returned an invalid delivery settings root",
    );
  }
  if (!Array.isArray(delivery.addresses)) {
    throw rosskoIntegrationError(
      "delivery-settings",
      "addresses-not-array",
      "в ответе API отсутствует массив addresses",
      "Rossko API did not return a valid addresses collection",
    );
  }
  if (!Array.isArray(delivery.types)) {
    throw rosskoIntegrationError(
      "delivery-settings",
      "types-not-array",
      "в ответе API отсутствует массив types",
      "Rossko API did not return a valid delivery types collection",
    );
  }
  if (delivery.addresses.some((item) => !isRecord(item))) {
    throw rosskoIntegrationError(
      "delivery-settings",
      "addresses-items-invalid",
      "массив addresses содержит элементы неверного типа",
      "Rossko API returned invalid delivery address entries",
    );
  }
  if (delivery.types.some((item) => !isRecord(item))) {
    throw rosskoIntegrationError(
      "delivery-settings",
      "types-items-invalid",
      "массив types содержит элементы неверного типа",
      "Rossko API returned invalid delivery type entries",
    );
  }
  const addressGuid = selectRosskoDeliveryValue(delivery.addresses, "pointGuid");
  const deliveryType = selectRosskoDeliveryValue(delivery.types, "value");

  if (!addressGuid) {
    throw rosskoIntegrationError(
      "delivery-settings",
      "address-missing",
      "API не вернул ни одного пригодного адреса доставки",
      "Rossko API did not return a usable delivery address",
    );
  }
  if (!deliveryType) {
    throw rosskoIntegrationError(
      "delivery-settings",
      "type-missing",
      "API не вернул ни одного пригодного типа доставки",
      "Rossko API did not return a usable delivery type",
    );
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
    const search = await rosskoRequest<RosskoSearchResponse>(searchUrl, context.signal, "search");
    if (!isRecord(search)) {
      throw rosskoIntegrationError("search", "response-not-object", "API Rossko вернул корневой ответ не в виде объекта", "Rossko API returned an invalid search response root");
    }
    if (search.errorFlag) {
      throw rosskoIntegrationError("search", "error-flag", "API Rossko сообщил об ошибке поиска", "Rossko API reported a search failure");
    }
    if (!Array.isArray(search.results)) {
      throw rosskoIntegrationError("search", "results-not-array", "в ответе API отсутствует массив results", "Rossko API returned an invalid search response");
    }
    if (search.results.some((group) => !group || typeof group !== "object" || !Array.isArray(group.searchResults))) {
      throw rosskoIntegrationError("search", "groups-invalid", "в ответе API повреждена структура групп searchResults", "Rossko API returned invalid search result groups");
    }
    if (search.results.some((group) => group.searchResults?.some((item: unknown) => !isRecord(item)))) {
      throw rosskoIntegrationError("search", "items-invalid", "массив searchResults содержит элементы неверного типа", "Rossko API returned invalid search result items");
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
      const card = await rosskoRequest<RosskoCardResponse>(cardUrl, context.signal, "product-card");

      if (!isRecord(card)) {
        throw rosskoIntegrationError("product-card", "response-not-object", "API Rossko вернул корневой ответ не в виде объекта", "Rossko API returned an invalid product card root");
      }

      if (card.isAuthorized === false) {
        throw rosskoAuthError("product-card", undefined, "session-rejected");
      }

      const part = card.mainPart;
      if (!part || typeof part !== "object" || Array.isArray(part)) {
        throw rosskoIntegrationError("product-card", "main-part-missing", "в карточке товара отсутствует объект mainPart", "Rossko API returned a product card without product data");
      }
      if (normalizeArticle(part.partNumber || "") !== target) {
        return;
      }
      const brand = part.brandName?.trim();
      const partNumber = part.partNumber?.trim();
      const title = part.goodsName?.trim();
      if (!brand || !partNumber || !title) {
        const missingFields = [!brand && "brandName", !partNumber && "partNumber", !title && "goodsName"].filter(Boolean).join(", ");
        throw rosskoIntegrationError(
          "product-card",
          "required-fields-missing",
          `в карточке товара отсутствуют обязательные поля: ${missingFields}`,
          "Rossko API returned incomplete product data",
        );
      }
      if (!Array.isArray(part.stocks)) {
        throw rosskoIntegrationError("product-card", "stocks-not-array", "в карточке товара отсутствует массив stocks", "Rossko API returned invalid product stocks");
      }
      if (part.stocks.some((stock) => !isRecord(stock))) {
        throw rosskoIntegrationError("product-card", "stocks-items-invalid", "массив stocks содержит элементы неверного типа", "Rossko API returned invalid product stock entries");
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
