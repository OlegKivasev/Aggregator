import { autopiterConfig, supplierMaxResponseBytes } from "../../config.ts";
import type { SupplierSessionManager } from "../../session/session-manager.ts";
import type { AutopiterCredentials, NormalizedSearchResult, SearchQuery, SupplierSearchContext } from "../../types.ts";
import { SupplierAuthError, SupplierIntegrationError } from "../errors.ts";
import { siteHttpRequest, type SiteHttpResponse } from "../site-http.ts";
import { parseSupplierXml, type XmlElement } from "../soap-xml.ts";
import type { SupplierAdapter } from "../supplier-adapter.ts";

type AutopiterMethod = "Authorization" | "IsAuthorization" | "FindCatalog" | "GetPriceId";
type SoapFields = Record<string, string>;
export type AutopiterRequester = (method: AutopiterMethod, fields: SoapFields, signal: AbortSignal, cookie?: string) => Promise<SiteHttpResponse>;

interface AutopiterSessionRecovery {
  authorization?: Promise<string>;
}

type PriceOutcome = { ok: true; offers: XmlElement[] } | { ok: false; error: unknown };

const namespace = "http://www.autopiter.ru/";
const endpoint = new URL("https://service.autopiter.ru/v2/price");
const priceRequestConcurrency = 4;
const localName = (element: XmlElement): string => element.name.split(":").at(-1) || "";
const children = (element: XmlElement, name: string): XmlElement[] => element.children.filter((item) => localName(item) === name);
const text = (element: XmlElement, name: string): string => children(element, name)[0]?.text.trim() || "";
const articleKey = (value: string): string => value.replace(/[^\p{L}\p{N}]/gu, "").toUpperCase();
const escapeXml = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");

export const autopiterSoapRequest: AutopiterRequester = (method, fields, signal, cookie) => siteHttpRequest(endpoint, {
  method: "POST", signal, cookie,
  timeoutMs: autopiterConfig.requestTimeoutMs,
  maxResponseBytes: supplierMaxResponseBytes,
  headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: `"${namespace}${method}"` },
  body: `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><${method} xmlns="${namespace}">${Object.entries(fields).map(([key, value]) => `<${key}>${escapeXml(value)}</${key}>`).join("")}</${method}></soap:Body></soap:Envelope>`,
});

function methodResponse(response: SiteHttpResponse, method: AutopiterMethod): XmlElement {
  if (response.status === 401 || response.status === 403) throw new SupplierAuthError("Autopiter authorization is required");
  const mediaType = response.contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "text/xml" && mediaType !== "application/soap+xml" && mediaType !== "application/xml") {
    throw new SupplierIntegrationError("Autopiter returned an unexpected content type");
  }
  const root = parseSupplierXml(response.body);
  const body = children(root, "Body")[0];
  if (localName(root) !== "Envelope" || !body) throw new SupplierIntegrationError("Autopiter returned an invalid SOAP envelope");
  const fault = children(body, "Fault")[0];
  if (fault) {
    if (/авторизац|authoriz|not authenticated/i.test(text(fault, "faultstring"))) throw new SupplierAuthError("Autopiter authorization is required");
    throw new SupplierIntegrationError("Autopiter returned a SOAP fault");
  }
  if (response.status !== 200) throw new SupplierIntegrationError("Autopiter request failed");
  const wrapper = children(body, `${method}Response`)[0];
  if (!wrapper || body.children.length !== 1 || body.text.trim()) throw new SupplierIntegrationError("Autopiter did not return a method result");
  return wrapper;
}

function resultElement(response: SiteHttpResponse, method: AutopiterMethod): XmlElement {
  const result = children(methodResponse(response, method), `${method}Result`)[0];
  if (!result) throw new SupplierIntegrationError("Autopiter did not return a method result");
  return result;
}

function booleanResult(response: SiteHttpResponse, method: "Authorization" | "IsAuthorization"): boolean {
  const result = resultElement(response, method);
  if (result.children.length || !/^(true|false|0|1)$/.test(result.text.trim())) throw new SupplierIntegrationError("Autopiter returned an invalid authorization flag");
  return result.text.trim() === "true" || result.text.trim() === "1";
}

function mergeCookies(previous: string | null, setCookie: string[]): string {
  const cookies = new Map<string, string>();
  for (const pair of previous?.split("; ") ?? []) {
    const separator = pair.indexOf("=");
    cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
  for (const header of setCookie) {
    const [pair, ...attributes] = header.split(";");
    const match = /^([A-Za-z0-9_.-]+)=([^\s;,\x00-\x1f\x7f]*)$/.exec(pair?.trim() || "");
    if (!match) throw new SupplierIntegrationError("Autopiter returned an invalid cookie");
    const options = new Map(attributes.map((attribute) => {
      const separator = attribute.indexOf("=");
      return [attribute.slice(0, separator < 0 ? undefined : separator).trim().toLowerCase(), separator < 0 ? "" : attribute.slice(separator + 1).trim()];
    }));
    const domain = options.get("domain")?.toLowerCase().replace(/^\./, "");
    if (domain && domain !== endpoint.hostname && domain !== "autopiter.ru") continue;
    const path = options.get("path");
    if (path && endpoint.pathname !== path && !endpoint.pathname.startsWith(path.endsWith("/") ? path : `${path}/`)) continue;
    const maxAge = options.get("max-age");
    const expires = options.get("expires");
    const expired = maxAge !== undefined ? /^-?\d+$/.test(maxAge) && Number(maxAge) <= 0
      : expires !== undefined && Number.isFinite(Date.parse(expires)) && Date.parse(expires) <= Date.now();
    if (!match[2] || expired) cookies.delete(match[1]);
    else cookies.set(match[1], match[2]);
  }
  const cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  if (cookies.size > 32 || cookie.length > 16_384) throw new SupplierIntegrationError("Autopiter returned too many cookies");
  return cookie;
}

function hasAuthCookie(cookie: string): boolean {
  // The service documents this exact cookie name (including its spelling).
  return /(?:^|; )AuthCoocies=[^;]+(?:;|$)/.test(cookie);
}

export async function verifyAutopiterCredentials(credentials: AutopiterCredentials, signal: AbortSignal, request: AutopiterRequester = autopiterSoapRequest): Promise<string> {
  const response = await request("Authorization", { UserID: credentials.login.trim(), Password: credentials.password, Save: "false" }, signal);
  signal.throwIfAborted();
  if (!booleanResult(response, "Authorization")) throw new SupplierAuthError("Autopiter rejected the client number or password");
  const cookie = mergeCookies(null, response.setCookie);
  if (!hasAuthCookie(cookie)) throw new SupplierIntegrationError("Autopiter did not establish an authorization cookie");
  const validation = await request("IsAuthorization", {}, signal, cookie);
  signal.throwIfAborted();
  if (!booleanResult(validation, "IsAuthorization")) throw new SupplierAuthError("Autopiter did not confirm the new session");
  const verifiedCookie = mergeCookies(cookie, validation.setCookie);
  if (!hasAuthCookie(verifiedCookie)) throw new SupplierAuthError("Autopiter invalidated the new session");
  return verifiedCookie;
}

function listResult(response: SiteHttpResponse, method: "FindCatalog" | "GetPriceId", itemName: string): XmlElement[] {
  const wrapper = methodResponse(response, method);
  const nilResult = new RegExp(`<(?:(?:[\\w.-]+):)?${method}(?:Response|Result)\\b[^>]*\\s(?:[\\w.-]+:)?nil\\s*=\\s*["'](?:true|1)["']`).test(response.body);
  if (nilResult || wrapper.text.trim()) throw new SupplierIntegrationError("Autopiter returned an invalid result list");
  // Both list results have minOccurs=0 in the supplier's WSDL: an empty method response is valid.
  if (wrapper.children.length === 0) return [];
  const result = children(wrapper, `${method}Result`)[0];
  if (!result || wrapper.children.length !== 1 || result.text.trim() || result.children.some((item) => localName(item) !== itemName)) {
    throw new SupplierIntegrationError("Autopiter returned an invalid result list");
  }
  return result.children;
}

function deliveryDate(value: string): string | null {
  if (!value || value.startsWith("0001-")) return null;
  const match = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return null;
  const calendarDate = new Date(`${match[1]}T00:00:00.000Z`);
  return calendarDate.toISOString().slice(0, 10) === match[1] ? calendarDate.toISOString() : null;
}

function normalizeOffer(offer: XmlElement, requestedArticle: string): NormalizedSearchResult | null {
  const article = text(offer, "Number");
  if (!article) throw new SupplierIntegrationError("Autopiter offer has no article");
  if (articleKey(article) !== articleKey(requestedArticle) || text(offer, "NumberChange")) return null;
  const brand = text(offer, "CatalogName");
  const title = text(offer, "Name");
  const rawPrice = text(offer, "SalePrice");
  const price = /^\d+(?:\.\d+)?$/.test(rawPrice) ? Number(rawPrice) : NaN;
  const refusal = text(offer, "TypeRefusal");
  const rawQuantity = text(offer, "NumberOfAvailable");
  const quantity = /^\d+$/.test(rawQuantity) ? Number(rawQuantity) : null;
  const currency = text(offer, "CurrencyName");
  if (!brand || !title || !Number.isFinite(price) || price <= 0 || !/^\d+$/.test(refusal)
    || !Number.isSafeInteger(Number(refusal)) || (rawQuantity && (quantity === null || !Number.isSafeInteger(quantity)))
    || (currency && currency !== "RUB")) {
    throw new SupplierIntegrationError("Autopiter returned an invalid offer");
  }
  const date = deliveryDate(text(offer, "DeliveryDate"));
  return {
    supplier: "autopiter", brand, article, title, price,
    quantity: quantity && quantity > 0 ? quantity : null,
    warehouse: text(offer, "Region") || null,
    deliveryDate: date, deliveryDateApproximate: false,
    isReturnable: Number(refusal) !== 3 && Number(refusal) !== 4,
    link: "https://autopiter.ru/",
  };
}

export class AutopiterApiAdapter implements SupplierAdapter {
  readonly id = "autopiter";
  readonly displayName = "Автопитер";
  readonly timeoutMs = autopiterConfig.searchTimeoutMs;
  private readonly request: AutopiterRequester;

  constructor(request: AutopiterRequester = autopiterSoapRequest) { this.request = request; }

  private async requestWithSession<T>(
    method: Exclude<AutopiterMethod, "Authorization">,
    fields: SoapFields,
    context: SupplierSearchContext,
    manager: SupplierSessionManager,
    parse: (response: SiteHttpResponse) => T,
    recovery?: AutopiterSessionRecovery,
  ): Promise<T> {
    const operation = manager.beginOperation(this.id, context.signal);
    try {
      operation.signal.throwIfAborted();
      const credentials = manager.getAutopiterCredentials();
      if (!credentials) throw new SupplierAuthError("Autopiter credentials are not configured");
      let usedRecovery = Boolean(recovery?.authorization);
      if (recovery?.authorization) {
        await recovery.authorization;
        operation.signal.throwIfAborted();
      }
      let cookie = manager.getAutopiterCookie();
      while (true) {
        if (!cookie) {
          if (!recovery) throw new SupplierAuthError("Autopiter authorization is required");
          if (!recovery.authorization) {
            const previous = manager.getAutopiterCookie();
            // One login belongs to the whole search, including concurrent stale requests.
            recovery.authorization = verifyAutopiterCredentials(credentials, context.signal, this.request).then((verifiedCookie) => {
              context.signal.throwIfAborted();
              manager.updateAutopiterCookie(previous, verifiedCookie);
              return verifiedCookie;
            });
          }
          const verifiedCookie = await recovery.authorization;
          operation.signal.throwIfAborted();
          cookie = manager.getAutopiterCookie() ?? verifiedCookie;
          usedRecovery = true;
        }
        try {
          const response = await this.request(method, fields, operation.signal, cookie);
          operation.signal.throwIfAborted();
          const result = parse(response);
          const updatedCookie = mergeCookies(cookie, response.setCookie);
          if (!hasAuthCookie(updatedCookie)) throw new SupplierAuthError("Autopiter invalidated the session");
          manager.updateAutopiterCookie(cookie, updatedCookie);
          return result;
        } catch (error) {
          operation.signal.throwIfAborted();
          if (!(error instanceof SupplierAuthError) || !recovery || usedRecovery) throw error;
          cookie = null;
        }
      }
    } finally { operation.dispose(); }
  }

  async ensureSession(manager: SupplierSessionManager) {
    return manager.getAutopiterCredentials()
      ? manager.markChecked(this.id, "Autopiter credentials are configured")
      : manager.markUnauthorized(this.id, "Autopiter client number and password are not configured");
  }

  async validateSession(context: SupplierSearchContext, manager: SupplierSessionManager): Promise<void> {
    // The session service owns validation's single full authorization attempt.
    await this.requestWithSession("IsAuthorization", {}, context, manager, (response) => {
      if (!booleanResult(response, "IsAuthorization")) throw new SupplierAuthError("Autopiter authorization is required");
    });
  }

  async search(query: SearchQuery, context: SupplierSearchContext, onResult: (result: NormalizedSearchResult) => void, manager: SupplierSessionManager): Promise<void> {
    const operation = manager.beginOperation(this.id, context.signal);
    const controller = new AbortController();
    const searchContext = { ...context, signal: AbortSignal.any([operation.signal, controller.signal]) };
    const pending = new Map<number, Promise<PriceOutcome>>();
    try {
      searchContext.signal.throwIfAborted();
      const recovery: AutopiterSessionRecovery = {};
      const catalogs = await this.requestWithSession("FindCatalog", { Number: query.article }, searchContext, manager, (response) => listResult(response, "FindCatalog", "SearchCatalogModel"), recovery);
      searchContext.signal.throwIfAborted();
      const ids = new Set<string>();
      for (const catalog of catalogs) {
        const article = text(catalog, "Number");
        const id = text(catalog, "ArticleId");
        if (!article || !text(catalog, "CatalogName") || !/^[1-9]\d{0,18}$/.test(id)) throw new SupplierIntegrationError("Autopiter returned an invalid catalog");
        if (articleKey(article) === articleKey(query.article)) ids.add(id);
      }
      if (ids.size > 64) throw new SupplierIntegrationError("Autopiter returned too many catalogs");
      const catalogIds = [...ids];
      const loadPrices = (id: string): Promise<PriceOutcome> => this.requestWithSession(
        "GetPriceId", { ArticleId: id, Currency: "РУБ", SearchCross: "0", MinSalesRating: "0", MinRealTimeInProc: "0" },
        searchContext, manager, (response) => listResult(response, "GetPriceId", "PriceSearchModel"), recovery,
      ).then((offers) => ({ ok: true, offers }), (error: unknown) => ({ ok: false, error }));
      catalogIds.slice(0, priceRequestConcurrency).forEach((id, index) => pending.set(index, loadPrices(id)));
      for (let index = 0; index < catalogIds.length; index++) {
        const outcome = await pending.get(index)!;
        pending.delete(index);
        searchContext.signal.throwIfAborted();
        if (!outcome.ok) throw outcome.error;
        // Consume in catalog order, keeping only a bounded window of responses ahead.
        const next = index + priceRequestConcurrency;
        if (next < catalogIds.length) pending.set(next, loadPrices(catalogIds[next]));
        for (const offer of outcome.offers) {
          searchContext.signal.throwIfAborted();
          const result = normalizeOffer(offer, query.article);
          if (result) onResult(result);
        }
      }
    } finally {
      controller.abort();
      await Promise.allSettled(pending.values());
      operation.dispose();
    }
  }
}
