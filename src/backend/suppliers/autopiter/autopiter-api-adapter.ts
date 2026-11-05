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

const namespace = "http://www.autopiter.ru/";
const endpoint = new URL("https://service.autopiter.ru/v2/price");
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

function resultElement(response: SiteHttpResponse, method: AutopiterMethod): XmlElement {
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
  const result = wrapper && children(wrapper, `${method}Result`)[0];
  if (!result) throw new SupplierIntegrationError("Autopiter did not return a method result");
  return result;
}

function booleanResult(response: SiteHttpResponse, method: "Authorization" | "IsAuthorization"): boolean {
  const result = resultElement(response, method);
  if (result.children.length || !/^(true|false|0|1)$/.test(result.text.trim())) throw new SupplierIntegrationError("Autopiter returned an invalid authorization flag");
  return result.text.trim() === "true" || result.text.trim() === "1";
}

export async function verifyAutopiterCredentials(credentials: AutopiterCredentials, signal: AbortSignal, request: AutopiterRequester = autopiterSoapRequest): Promise<string> {
  const response = await request("Authorization", { UserID: credentials.login.trim(), Password: credentials.password, Save: "false" }, signal);
  signal.throwIfAborted();
  if (!booleanResult(response, "Authorization")) throw new SupplierAuthError("Autopiter rejected the client number or password");
  // The service documents this exact cookie name (including its spelling).
  const cookie = response.setCookie.map((value) => value.split(";", 1)[0]?.trim()).find((value) => /^AuthCoocies=[^\s;,]+$/.test(value || ""));
  if (!cookie) throw new SupplierIntegrationError("Autopiter did not establish an authorization cookie");
  return cookie;
}

function listResult(response: SiteHttpResponse, method: "FindCatalog" | "GetPriceId", itemName: string): XmlElement[] {
  const result = resultElement(response, method);
  const nilResult = new RegExp(`<(?:(?:[\\w.-]+):)?${method}Result\\b[^>]*\\s(?:[\\w.-]+:)?nil\\s*=\\s*["'](?:true|1)["']`).test(response.body);
  if (nilResult || result.text.trim() || result.children.some((item) => localName(item) !== itemName)) {
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

  async ensureSession(manager: SupplierSessionManager) {
    return manager.getAutopiterCredentials()
      ? manager.markChecked(this.id, "Autopiter credentials are configured")
      : manager.markUnauthorized(this.id, "Autopiter client number and password are not configured");
  }

  async validateSession(context: SupplierSearchContext, manager: SupplierSessionManager): Promise<void> {
    const cookie = manager.getAutopiterCookie();
    if (!cookie || !booleanResult(await this.request("IsAuthorization", {}, context.signal, cookie), "IsAuthorization")) {
      throw new SupplierAuthError("Autopiter authorization is required");
    }
    context.signal.throwIfAborted();
  }

  async search(query: SearchQuery, context: SupplierSearchContext, onResult: (result: NormalizedSearchResult) => void, manager: SupplierSessionManager): Promise<void> {
    const cookie = manager.getAutopiterCookie();
    if (!cookie) throw new SupplierAuthError("Autopiter authorization is required");
    const catalogs = listResult(await this.request("FindCatalog", { Number: query.article }, context.signal, cookie), "FindCatalog", "SearchCatalogModel");
    context.signal.throwIfAborted();
    const ids = new Set<string>();
    for (const catalog of catalogs) {
      const article = text(catalog, "Number");
      const id = text(catalog, "ArticleId");
      if (!article || !text(catalog, "CatalogName") || !/^[1-9]\d{0,18}$/.test(id)) throw new SupplierIntegrationError("Autopiter returned an invalid catalog");
      if (articleKey(article) === articleKey(query.article)) ids.add(id);
    }
    if (ids.size > 64) throw new SupplierIntegrationError("Autopiter returned too many catalogs");
    for (const id of ids) {
      context.signal.throwIfAborted();
      const offers = listResult(await this.request("GetPriceId", { ArticleId: id, Currency: "РУБ", SearchCross: "0", MinSalesRating: "0", MinRealTimeInProc: "0" }, context.signal, cookie), "GetPriceId", "PriceSearchModel");
      context.signal.throwIfAborted();
      for (const offer of offers) {
        const result = normalizeOffer(offer, query.article);
        if (result) onResult(result);
      }
    }
  }
}
