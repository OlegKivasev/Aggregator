import { forumAutoSearchTimeoutMs, supplierMaxResponseBytes } from "../../config.ts";
import type { SupplierSessionManager } from "../../session/session-manager.ts";
import type {
  AnalogSearchQuery,
  ForumAutoCredentials,
  NormalizedSearchResult,
  SearchQuery,
  SupplierSearchContext,
  SupplierSessionState,
} from "../../types.ts";
import { SupplierAuthError, SupplierIntegrationError } from "../errors.ts";
import { siteHttpRequest, type SiteHttpResponse } from "../site-http.ts";
import type { SupplierAdapter } from "../supplier-adapter.ts";

interface ForumAutoOffer {
  brand?: unknown;
  art?: unknown;
  name?: unknown;
  d_deliv?: unknown;
  h_deliv?: unknown;
  num?: unknown;
  price?: unknown;
  whse?: unknown;
  is_returnable?: unknown;
}

interface ForumAutoFault {
  FaultCode?: unknown;
  faultCode?: unknown;
  code?: unknown;
}

export type ForumAutoApiMethod = "clientinfo" | "listgoods";
export type ForumAutoApiRequester = (
  method: ForumAutoApiMethod,
  params: URLSearchParams,
  signal: AbortSignal,
  timeoutMs: number,
  credentials: ForumAutoCredentials,
) => Promise<unknown>;

const forumAutoApiBaseUrl = new URL("https://api.forum-auto.ru/v2/");
const forumAutoSiteUrl = "https://forum-auto.ru/";

function normalizeArticle(value: string): string {
  return value.replace(/[^A-Z0-9]/gi, "").toUpperCase();
}

function normalizeBrand(value: string): string {
  return value.normalize("NFKC").replace(/[^\p{L}\p{N}]/gu, "").toLocaleUpperCase();
}

function parsePositiveNumber(value: unknown): number | null {
  const parsed = typeof value === "string" && value.trim()
    ? Number(value.trim().replace(",", "."))
    : typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseQuantity(value: unknown): number | null {
  const parsed = typeof value === "string" && /^\d+$/.test(value.trim())
    ? Number(value.trim())
    : typeof value === "number" ? value : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function isForumAutoReturnable(value: unknown): boolean | null {
  if (value === 1 || value === "1") {
    return true;
  }
  if (value === 0 || value === "0") {
    return false;
  }
  return null;
}

function deliveryDateFromDuration(days: unknown, hours: unknown): string | null {
  const parsedHours = typeof hours === "number" || typeof hours === "string" && hours.trim() ? Number(hours) : Number.NaN;
  const parsedDays = typeof days === "number" || typeof days === "string" && days.trim() ? Number(days) : Number.NaN;
  const totalHours = Number.isFinite(parsedHours) && parsedHours >= 0
    ? parsedHours
    : Number.isFinite(parsedDays) && parsedDays >= 0 ? parsedDays * 24 : null;
  return totalHours === null ? null : new Date(Date.now() + totalHours * 60 * 60 * 1_000).toISOString();
}

function forumAutoFaultCode(payload: unknown): number | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const fault = payload as ForumAutoFault;
  const rawCode = fault.FaultCode ?? fault.faultCode ?? fault.code;
  const code = typeof rawCode === "string" && rawCode.trim()
    ? Number(rawCode)
    : typeof rawCode === "number" ? rawCode : Number.NaN;
  return Number.isInteger(code) ? code : null;
}

function forumAutoFaultError(code: number): SupplierAuthError | SupplierIntegrationError {
  if ([10, 11, 12].includes(code)) {
    return new SupplierAuthError("Forum-Auto rejected the configured credentials or access");
  }
  if ([5, 6].includes(code)) {
    return new SupplierIntegrationError("Forum-Auto request limit was exceeded", {
      publicMessage: "Forum-Auto request limit was exceeded",
      diagnosticCode: `forum_auto_fault_${code}`,
    });
  }
  return new SupplierIntegrationError("Forum-Auto API returned a fault", {
    publicMessage: "Forum-Auto API rejected the request",
    diagnosticCode: `forum_auto_fault_${code}`,
  });
}

export function parseForumAutoApiResponse(response: SiteHttpResponse, method?: ForumAutoApiMethod): unknown {
  if (response.status === 401 || response.status === 403) {
    throw new SupplierAuthError("Forum-Auto rejected the configured credentials");
  }
  if (response.status < 200 || response.status >= 300) {
    throw new SupplierIntegrationError("Forum-Auto API returned an unsuccessful HTTP status", {
      publicMessage: "Forum-Auto API is temporarily unavailable",
    });
  }
  if (!response.contentType?.toLocaleLowerCase().startsWith("application/json")) {
    throw new SupplierIntegrationError("Forum-Auto API returned an unexpected content type", {
      publicMessage: "Forum-Auto API returned an unsupported response",
    });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(response.body) as unknown;
  } catch {
    throw new SupplierIntegrationError("Forum-Auto API returned invalid JSON", {
      publicMessage: "Forum-Auto API returned an unsupported response",
    });
  }

  const faultCode = forumAutoFaultCode(payload);
  if (faultCode !== null) {
    if ((faultCode === 1 || faultCode === 27) && method === "listgoods") {
      return [];
    }
    throw forumAutoFaultError(faultCode);
  }
  return payload;
}

function apiItems(payload: unknown, responseName: string): unknown[] {
  if (!Array.isArray(payload)) {
    throw new SupplierIntegrationError(`Forum-Auto API returned an invalid ${responseName} response`, {
      publicMessage: "Forum-Auto API returned an unsupported response",
    });
  }
  return payload;
}

function normalizeForumAutoOffer(offer: ForumAutoOffer, isAnalog: boolean): NormalizedSearchResult | null {
  const brand = typeof offer.brand === "string" ? offer.brand.trim() : "";
  const article = typeof offer.art === "string" ? offer.art.trim() : "";
  const title = typeof offer.name === "string" ? offer.name.trim() : "";
  const price = parsePositiveNumber(offer.price);
  if (!brand || !article || !title || price === null) {
    return null;
  }
  const quantity = parseQuantity(offer.num);
  const isReturnable = isForumAutoReturnable(offer.is_returnable);
  return {
    supplier: "forum-auto",
    brand,
    article,
    title,
    price,
    quantity,
    warehouse: typeof offer.whse === "string" && offer.whse.trim() ? offer.whse.trim() : null,
    deliveryDate: deliveryDateFromDuration(offer.d_deliv, offer.h_deliv),
    deliveryDateApproximate: true,
    ...(isReturnable === null ? {} : { isReturnable }),
    link: forumAutoSiteUrl,
    ...(isAnalog ? { isAnalog: true } : {}),
  };
}

export function parseForumAutoApiResults(payload: unknown, requestedArticle: string): NormalizedSearchResult[] {
  const target = normalizeArticle(requestedArticle);
  const results: NormalizedSearchResult[] = [];
  for (const value of apiItems(payload, "listGoods")) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const offer = value as ForumAutoOffer;
    const article = typeof offer.art === "string" ? offer.art : "";
    if (!article || normalizeArticle(article) !== target) {
      continue;
    }
    const result = normalizeForumAutoOffer(offer, false);
    if (result) {
      results.push(result);
    }
  }
  return results;
}

export function parseForumAutoApiAnalogResults(
  payload: unknown,
  requestedArticle: string,
  requestedBrand: string,
): NormalizedSearchResult[] {
  const targetArticle = normalizeArticle(requestedArticle);
  const targetBrand = normalizeBrand(requestedBrand);
  const results: NormalizedSearchResult[] = [];
  for (const value of apiItems(payload, "listGoods")) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const offer = value as ForumAutoOffer;
    const article = typeof offer.art === "string" ? offer.art : "";
    const brand = typeof offer.brand === "string" ? offer.brand : "";
    if (normalizeArticle(article) === targetArticle && normalizeBrand(brand) === targetBrand) {
      continue;
    }
    const result = normalizeForumAutoOffer(offer, true);
    if (result) {
      results.push(result);
    }
  }
  return results;
}

async function forumAutoApiRequest(
  method: ForumAutoApiMethod,
  params: URLSearchParams,
  signal: AbortSignal,
  timeoutMs: number,
  credentials: ForumAutoCredentials,
): Promise<unknown> {
  const url = new URL(method, forumAutoApiBaseUrl);
  url.search = new URLSearchParams({
    login: credentials.login,
    pass: credentials.password,
    ...Object.fromEntries(params),
  }).toString();
  const response = await siteHttpRequest(url, {
    headers: { Accept: "application/json" },
    signal,
    timeoutMs,
    maxResponseBytes: supplierMaxResponseBytes,
  });
  return parseForumAutoApiResponse(response, method);
}

function validateForumAutoClientInfo(payload: unknown): void {
  const items = apiItems(payload, "clientInfo");
  if (!items.length || !items.every((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    const item = value as { name?: unknown; value?: unknown };
    return typeof item.name === "string" && item.name.trim() && typeof item.value === "string";
  })) {
    throw new SupplierIntegrationError("Forum-Auto API returned an invalid clientInfo response", {
      publicMessage: "Forum-Auto API returned an unsupported response",
    });
  }
}

export async function verifyForumAutoCredentials(
  credentials: ForumAutoCredentials,
  request: ForumAutoApiRequester = forumAutoApiRequest,
  signal: AbortSignal = AbortSignal.timeout(10_000),
): Promise<void> {
  validateForumAutoClientInfo(await request("clientinfo", new URLSearchParams(), signal, 10_000, credentials));
}

export class ForumAutoApiAdapter implements SupplierAdapter {
  readonly id = "forum-auto";
  readonly displayName = "Forum-Auto";
  readonly timeoutMs = forumAutoSearchTimeoutMs;
  private readonly request: ForumAutoApiRequester;

  constructor(request: ForumAutoApiRequester = forumAutoApiRequest) {
    this.request = request;
  }

  async ensureSession(sessionManager: SupplierSessionManager): Promise<SupplierSessionState> {
    return sessionManager.getForumAutoCredentials()
      ? sessionManager.markChecked(this.id, "Forum-Auto API credentials are configured")
      : sessionManager.markUnauthorized(this.id, "Forum-Auto API credentials are not configured");
  }

  async validateSession(context: SupplierSearchContext, sessionManager: SupplierSessionManager): Promise<void> {
    const credentials = sessionManager.getForumAutoCredentials();
    if (!credentials) {
      throw new SupplierAuthError("Forum-Auto API credentials are not configured");
    }
    validateForumAutoClientInfo(await this.request("clientinfo", new URLSearchParams(), context.signal, context.timeoutMs, credentials));
  }

  async search(
    query: SearchQuery,
    context: SupplierSearchContext,
    onResult: (result: NormalizedSearchResult) => void,
    sessionManager: SupplierSessionManager,
  ): Promise<void> {
    const credentials = sessionManager.getForumAutoCredentials();
    if (!credentials) {
      throw new SupplierAuthError("Forum-Auto API credentials are not configured");
    }
    const article = query.article.trim();
    const payload = await this.request(
      "listgoods",
      new URLSearchParams({ art: article, cross: "0" }),
      context.signal,
      context.timeoutMs,
      credentials,
    );
    parseForumAutoApiResults(payload, article).forEach(onResult);
  }

  async searchAnalogs(
    query: AnalogSearchQuery,
    context: SupplierSearchContext,
    onResult: (result: NormalizedSearchResult) => void,
    sessionManager: SupplierSessionManager,
  ): Promise<void> {
    const credentials = sessionManager.getForumAutoCredentials();
    if (!credentials) {
      throw new SupplierAuthError("Forum-Auto API credentials are not configured");
    }
    const article = query.article.trim();
    const payload = await this.request(
      "listgoods",
      new URLSearchParams({ art: article, cross: "1", br: query.brand.trim() }),
      context.signal,
      context.timeoutMs,
      credentials,
    );
    parseForumAutoApiAnalogResults(payload, article, query.brand).forEach(onResult);
  }
}
