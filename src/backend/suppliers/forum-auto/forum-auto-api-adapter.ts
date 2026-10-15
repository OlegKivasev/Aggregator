import { createHash } from "node:crypto";
import { forumAutoSearchTimeoutMs, supplierMaxResponseBytes } from "../../config.ts";
import type { SupplierSessionManager } from "../../session/session-manager.ts";
import type {
  AnalogSearchQuery,
  BrandDiscoveryQuery,
  ForumAutoCredentials,
  NormalizedSearchResult,
  SearchQuery,
  SupplierSearchContext,
  SupplierSessionState,
} from "../../types.ts";
import { SupplierAuthError, SupplierIntegrationError } from "../errors.ts";
import { siteHttpRequest, type SiteHttpResponse } from "../site-http.ts";
import type { SupplierAdapter } from "../supplier-adapter.ts";
import { attachPurchaseReference } from "../../purchasing/purchase-offer.ts";
import type { PurchaseLine } from "../../purchasing/purchase-offer.ts";
import type { ForumAutoOrderReceipt, OrderGroupResult } from "../../purchasing/order-contract.ts";

interface ForumAutoOffer {
  gid?: unknown;
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

class ForumAutoOrderRefusalError extends Error {
  readonly publicMessage: string;

  constructor(publicMessage: string) {
    super("Forum-Auto explicitly rejected the order request");
    this.name = "ForumAutoOrderRefusalError";
    this.publicMessage = publicMessage;
  }
}

const orderRefusalMessages = new Map<number, string>([
  [1, "Forum Auto отклонил параметры заказа."], [2, "Forum Auto не распознал метод оформления заказа."],
  [5, "Forum Auto ограничил число запросов за минуту."], [6, "Forum Auto ограничил число запросов за сутки."],
  [10, "Forum Auto отклонил логин или пароль."], [11, "Forum Auto не разрешает оформлять заказы через API."],
  [12, "Forum Auto заблокировал оформление заказов. Обратитесь к менеджеру."],
  [13, "Forum Auto отклонил заказ: превышен доступный лимит."],
  [20, "Forum Auto не нашёл выбранный товар."], [27, "Forum Auto не нашёл выбранный товар."],
  [28, "Forum Auto отклонил количество: оно меньше кратности упаковки."],
  [29, "Forum Auto отклонил идентификатор товара в заказе."],
  [31, "Предложение Forum Auto устарело. Откройте корзину для обновления."],
]);

export type ForumAutoApiMethod = "clientinfo" | "listgoods" | "listbrands" | "addgoodstoorder" | "listorders";
export type ForumAutoApiRequester = (
  method: ForumAutoApiMethod,
  params: URLSearchParams,
  signal: AbortSignal,
  timeoutMs: number,
  credentials: ForumAutoCredentials,
) => Promise<unknown>;

const forumAutoApiBaseUrl = new URL("https://api.forum-auto.ru/v2/");
const forumAutoSiteUrl = new URL("https://itrade.forum-auto.ru/shop/index.html");

function forumAutoProductUrl(article: string): string {
  const url = new URL(forumAutoSiteUrl);
  url.searchParams.set("article", article);
  return url.toString();
}

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

function forumAutoFaultError(code: number, method?: ForumAutoApiMethod): Error {
  const orderRefusal = method === "addgoodstoorder" ? orderRefusalMessages.get(code) : undefined;
  if (orderRefusal) return new ForumAutoOrderRefusalError(orderRefusal);
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
  if ((method === "listgoods" || method === "listbrands") && (response.status === 400 || response.status === 422)) {
    return [];
  }
  if (method === "addgoodstoorder" && response.status >= 400
    && response.contentType?.toLocaleLowerCase().startsWith("application/json")) {
    let fault: unknown;
    try { fault = JSON.parse(response.body) as unknown; } catch { /* The non-success status remains an integration error. */ }
    const code = forumAutoFaultCode(fault);
    if (code !== null) throw forumAutoFaultError(code, method);
  }
  if (response.status < 200 || response.status >= 300) {
    throw new SupplierIntegrationError("Forum-Auto API returned an unsuccessful HTTP status", {
      publicMessage: "Forum-Auto API is temporarily unavailable",
    });
  }
  if (!response.contentType?.toLocaleLowerCase().startsWith("application/json")) {
    if (method === "listgoods" || method === "listbrands") {
      return [];
    }
    throw new SupplierIntegrationError("Forum-Auto API returned an unexpected content type", {
      publicMessage: "Forum-Auto API returned an unsupported response",
    });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(response.body) as unknown;
  } catch {
    if (method === "listgoods" || method === "listbrands") {
      return [];
    }
    throw new SupplierIntegrationError("Forum-Auto API returned invalid JSON", {
      publicMessage: "Forum-Auto API returned an unsupported response",
    });
  }

  const faultCode = forumAutoFaultCode(payload);
  if (faultCode !== null) {
    if ((method === "listgoods" || method === "listbrands") && ![5, 6, 10, 11, 12].includes(faultCode)) {
      return [];
    }
    throw forumAutoFaultError(faultCode, method);
  }
  if ((method === "listgoods" || method === "listbrands") && !Array.isArray(payload)) {
    return [];
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
  const result: NormalizedSearchResult = {
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
    link: forumAutoProductUrl(article),
    ...(isAnalog ? { isAnalog: true } : {}),
  };
  const gid = typeof offer.gid === "string" ? offer.gid.trim() : "";
  return gid ? attachPurchaseReference(result, { supplier: "forum-auto", warehouse: result.warehouse, gid }) : result;
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

export function parseForumAutoApiBrands(payload: unknown, requestedArticle: string): string[] {
  const target = normalizeArticle(requestedArticle);
  const brands = new Set<string>();
  for (const value of apiItems(payload, "listBrands")) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const item = value as { art?: unknown; brand?: unknown };
    const article = typeof item.art === "string" ? item.art : "";
    const brand = typeof item.brand === "string" ? item.brand.trim() : "";
    if (article && normalizeArticle(article) === target && brand) {
      brands.add(brand);
    }
  }
  return [...brands];
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

export function parseForumAutoOrderResult(payload: unknown, line: PurchaseLine): OrderGroupResult {
  if (line.reference.supplier !== "forum-auto") throw new SupplierIntegrationError("Forum-Auto order line has invalid supplier");
  const gid = line.reference.gid;
  const orders = Array.isArray(payload) ? payload : [payload];
  const matches = orders.filter((value): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value)))
    .flatMap((order) => {
      const id = order.did;
      const items = order.arTovs;
      return (typeof id === "number" && Number.isSafeInteger(id) && id > 0 || typeof id === "string" && /^[1-9]\d*$/.test(id))
        && Array.isArray(items) ? items.map((item) => ({ id: String(id), order, item })) : [];
    }).filter(({ item }) => item && typeof item === "object" && !Array.isArray(item)
      && (item as Record<string, unknown>).gid === gid);
  if (matches.length !== 1) {
    const orderIds = [...new Set(orders.flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const id = (value as Record<string, unknown>).did;
      if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) return [String(id)];
      if (typeof id === "string" && /^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id))) return [id];
      return [];
    }))];
    const publicMessage = orderIds.length === 1
      ? `Forum Auto вернул заказ №${orderIds[0]}, но не подтвердил выбранную позицию. Найдите заказ по номеру в кабинете поставщика.`
      : Array.isArray(payload) && payload.length === 0
        ? "Forum Auto вернул пустой ответ на создание заказа. Проверьте кабинет поставщика перед повторной попыткой."
        : "Ответ Forum Auto не содержит подтверждения выбранной позиции и номера заказа. Проверьте кабинет поставщика перед повторной попыткой.";
    throw new SupplierIntegrationError("Forum-Auto order confirmation is incomplete", { publicMessage });
  }
  const { id, order, item } = matches[0];
  const product = item as Record<string, unknown>;
  const quantity = product.k1;
  const acceptedQuantity = typeof quantity === "number" ? quantity : typeof quantity === "string" && /^\d+$/.test(quantity) ? Number(quantity) : Number.NaN;
  if (!Number.isSafeInteger(acceptedQuantity) || acceptedQuantity < 1 || acceptedQuantity > line.quantity) {
    throw new SupplierIntegrationError("Forum-Auto confirmed an invalid quantity");
  }
  const optionalText = (value: unknown): string | undefined => typeof value === "string" && value.trim() && value.length <= 500
    ? value.trim() : undefined;
  const optionalCount = (value: unknown): number | undefined => {
    const parsed = parseQuantity(value);
    return parsed !== null && parsed <= acceptedQuantity ? parsed : undefined;
  };
  const optionalMoney = (value: unknown): number | undefined => {
    const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value.trim().replace(",", ".")) : Number.NaN;
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  };
  const receipt: ForumAutoOrderReceipt = {
    orderId: id, orderedQuantity: acceptedQuantity,
    ...(optionalText(order.nr) ? { documentNumber: optionalText(order.nr) } : {}),
    ...(optionalText(order.status) ? { status: optionalText(order.status) } : {}),
    ...(optionalText(order.dtc) ? { createdAt: optionalText(order.dtc) } : {}),
    ...(optionalText(order.mdt) ? { deliveryAt: optionalText(order.mdt) } : {}),
    ...(optionalText(product.brand) ? { brand: optionalText(product.brand) } : {}),
    ...(optionalText(product.nr) ? { article: optionalText(product.nr) } : {}),
    ...(optionalText(product.tovname) ? { title: optionalText(product.tovname) } : {}),
    ...(optionalCount(product.k2) !== undefined ? { reservedQuantity: optionalCount(product.k2) } : {}),
    ...(optionalCount(product.k3) !== undefined ? { confirmedQuantity: optionalCount(product.k3) } : {}),
    ...(optionalMoney(product.price) !== undefined ? { price: optionalMoney(product.price) } : {}),
    ...(optionalMoney(product.sum) !== undefined ? { total: optionalMoney(product.sum) } : {}),
  };
  return { confirmed: [{ id: line.id, acceptedQuantity, orderIds: [id], forumAutoOrder: receipt,
    ...(acceptedQuantity < line.quantity ? { message: "Forum Auto подтвердил только часть количества." } : {}) }], rejected: [] };
}

export async function placeForumAutoOrder(line: PurchaseLine, credentials: ForumAutoCredentials, signal: AbortSignal,
  attemptId: string, request: ForumAutoApiRequester = forumAutoApiRequest): Promise<OrderGroupResult> {
  if (line.reference.supplier !== "forum-auto" || !line.reference.gid) throw new SupplierIntegrationError("Forum-Auto order is missing a product identifier");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(attemptId)) {
    throw new SupplierIntegrationError("Forum-Auto order attempt is invalid");
  }
  const externalOrderId = (createHash("sha256").update(attemptId).digest().readUInt32BE(0) & 0x7fffffff) || 1;
  const params = new URLSearchParams({ tid: line.reference.gid, num: String(line.quantity), eoid: String(externalOrderId) });
  let payload: unknown;
  let orderError: unknown;
  try {
    payload = await request("addgoodstoorder", params, signal, forumAutoSearchTimeoutMs, credentials);
    try { return parseForumAutoOrderResult(payload, line); }
    catch (error) { orderError = error; }
  } catch (error) {
    if (error instanceof ForumAutoOrderRefusalError) {
      return { confirmed: [], rejected: [{ id: line.id, message: error.publicMessage }] };
    }
    if (error instanceof SupplierAuthError) {
      return { confirmed: [], rejected: [{ id: line.id, message: "Forum Auto отклонил доступ к API." }] };
    }
    orderError = error;
  }
  if (signal.aborted) throw orderError;
  // A write may succeed even when its response is incomplete or the connection times out.
  // Only read-only lookups follow; an uncertain write is never submitted again.
  const orders = Array.isArray(payload) ? payload : [payload];
  const ids = [...new Set(orders.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const id = (value as Record<string, unknown>).did;
    if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) return [String(id)];
    if (typeof id === "string" && /^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id))) return [id];
    return [];
  }))];
  if (ids.length === 1) {
    try {
      const details = await request("listorders", new URLSearchParams({ did: ids[0] }), signal, forumAutoSearchTimeoutMs, credentials);
      return parseForumAutoOrderResult(details, line);
    } catch {
      // Continue to the external order ID lookup if the known order is not yet readable.
    }
  }
  if (signal.aborted) throw orderError;
  try {
    const details = await request("listorders", new URLSearchParams({ did: "0" }), signal, forumAutoSearchTimeoutMs, credentials);
    const matches = (Array.isArray(details) ? details : [details]).filter((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const id = (value as Record<string, unknown>).eoid;
      return id === externalOrderId || id === String(externalOrderId);
    });
    if (matches.length === 1) return parseForumAutoOrderResult(matches, line);
  } catch {
    // A missing or invalid read-only confirmation leaves the original attempt uncertain.
  }
  throw orderError;
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

  async searchBrands(
    query: BrandDiscoveryQuery,
    context: SupplierSearchContext,
    onBrands: (brands: string[]) => void,
    sessionManager: SupplierSessionManager,
  ): Promise<void> {
    const credentials = sessionManager.getForumAutoCredentials();
    if (!credentials) {
      throw new SupplierAuthError("Forum-Auto API credentials are not configured");
    }
    const article = query.article.trim();
    const payload = await this.request(
      "listbrands",
      new URLSearchParams({ art: article }),
      context.signal,
      context.timeoutMs,
      credentials,
    );
    onBrands(parseForumAutoApiBrands(payload, article));
  }
}
