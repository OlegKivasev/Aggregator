import { createHash } from "node:crypto";
import { createBoundedAbortSignal } from "../../abort.ts";
import { rosskoConfig, supplierMaxResponseBytes } from "../../config.ts";
import type { SupplierSessionManager } from "../../session/session-manager.ts";
import type {
  AnalogSearchQuery,
  NormalizedSearchResult,
  RosskoApiCredentials,
  SearchQuery,
  SupplierSearchContext,
  SupplierSessionState,
} from "../../types.ts";
import { SupplierAuthError, SupplierIntegrationError } from "../errors.ts";
import type { SupplierAdapter } from "../supplier-adapter.ts";

const rosskoApiOrigin = "https://api.rossko.ru";
const rosskoApiVersion = "v2.1";
const rosskoPortalOrigin = "https://samara.rossko.ru";

interface XmlElement {
  name: string;
  text: string;
  children: XmlElement[];
}

interface RosskoDeliverySelection {
  deliveryId: string;
  addressId?: string;
}

export interface RosskoStock {
  id: string | null;
  price: number;
  quantity: number;
  warehouse: string | null;
  deliveryDays: number | null;
  deliveryStart: string | null;
  deliveryEnd: string | null;
}

export interface RosskoPart {
  guid: string | null;
  brand: string;
  article: string;
  title: string;
  stocks: RosskoStock[];
  crosses: RosskoPart[];
}

let cachedDeliverySelection: {
  credentialsHash: string;
  selection: RosskoDeliverySelection;
} | null = null;

function localName(name: string): string {
  return name.split(":").at(-1)?.toLowerCase() || "";
}

function decodeXmlText(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (entity) => {
    switch (entity.toLowerCase()) {
      case "&amp;": return "&";
      case "&lt;": return "<";
      case "&gt;": return ">";
      case "&quot;": return '"';
      case "&apos;": return "'";
      default: {
        const hexadecimal = entity[2]?.toLowerCase() === "x";
        const digits = entity.slice(hexadecimal ? 3 : 2, -1);
        const codePoint = Number.parseInt(digits, hexadecimal ? 16 : 10);
        return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : "";
      }
    }
  });
}

export function parseRosskoXml(xml: string): XmlElement {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new SupplierIntegrationError("Rossko API returned unsupported XML declarations");
  }

  const root: XmlElement = { name: "#document", text: "", children: [] };
  const stack = [root];
  const tokens = xml.match(/<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]+>|[^<]+/g) || [];
  if (tokens.join("") !== xml) {
    throw new SupplierIntegrationError("Rossko API returned malformed XML");
  }

  for (const token of tokens) {
    const current = stack.at(-1);
    if (!current) {
      throw new SupplierIntegrationError("Rossko API returned malformed XML");
    }
    if (token.startsWith("<?") || token.startsWith("<!--")) {
      continue;
    }
    if (token.startsWith("<![CDATA[")) {
      current.text += token.slice(9, -3);
      continue;
    }
    if (!token.startsWith("<")) {
      current.text += decodeXmlText(token);
      continue;
    }
    if (token.startsWith("</")) {
      const match = token.match(/^<\/\s*([A-Za-z_][\w:.-]*)\s*>$/);
      const open = stack.at(-1);
      if (!match || !open || open === root || open.name !== match[1]) {
        throw new SupplierIntegrationError("Rossko API returned malformed XML");
      }
      stack.pop();
      continue;
    }

    const match = token.match(/^<\s*([A-Za-z_][\w:.-]*)(?:\s[^<>]*?)?\s*(\/?)>$/);
    if (!match) {
      throw new SupplierIntegrationError("Rossko API returned malformed XML");
    }
    const element: XmlElement = { name: match[1], text: "", children: [] };
    current.children.push(element);
    if (!match[2]) {
      stack.push(element);
    }
  }

  if (stack.length !== 1 || root.children.length !== 1) {
    throw new SupplierIntegrationError("Rossko API returned malformed XML");
  }
  return root.children[0];
}

function children(element: XmlElement, name: string): XmlElement[] {
  const target = name.toLowerCase();
  return element.children.filter((child) => localName(child.name) === target);
}

function child(element: XmlElement, name: string): XmlElement | null {
  return children(element, name)[0] || null;
}

function elementText(element: XmlElement, name: string): string | null {
  const value = child(element, name)?.text.trim();
  return value || null;
}

function findDescendant(element: XmlElement, name: string): XmlElement | null {
  if (localName(element.name) === name.toLowerCase()) {
    return element;
  }
  for (const nested of element.children) {
    const found = findDescendant(nested, name);
    if (found) {
      return found;
    }
  }
  return null;
}

function parseSuccess(result: XmlElement): boolean {
  const success = elementText(result, "success");
  if (!success || !/^(?:true|false)$/i.test(success)) {
    throw new SupplierIntegrationError("Rossko API response does not contain a valid success flag");
  }
  return success.toLowerCase() === "true";
}

export function buildRosskoSoapEnvelope(method: "GetCheckoutDetails" | "GetSearch", fields: Record<string, string | undefined>): string {
  const escapeXml = (value: string) => value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
  const body = Object.entries(fields)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([name, value]) => `      <ros:${name}>${escapeXml(value)}</ros:${name}>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ros="${rosskoApiOrigin}/">
  <soapenv:Body>
    <ros:${method}>
${body}
    </ros:${method}>
  </soapenv:Body>
</soapenv:Envelope>`;
}

function credentialsHash(credentials: RosskoApiCredentials): string {
  return createHash("sha256").update(credentials.key1).update("\0").update(credentials.key2).digest("hex");
}

function parsePositiveNumber(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number(value.replace(",", "."));
  return Number.isFinite(parsed) && parsed > 0 && parsed <= Number.MAX_SAFE_INTEGER ? parsed : null;
}

function parseNonNegativeInteger(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function parseRosskoCheckoutDetails(xml: string): RosskoDeliverySelection {
  const result = findDescendant(parseRosskoXml(xml), "CheckoutDetailsResult");
  if (!result) {
    throw new SupplierIntegrationError("Rossko API did not return checkout details");
  }
  if (!parseSuccess(result)) {
    throw new SupplierAuthError("Rossko API rejected KEY1 or KEY2");
  }

  const deliveryTypes = children(child(result, "DeliveryType") || { name: "", text: "", children: [] }, "delivery")
    .flatMap((delivery) => {
      const id = elementText(delivery, "id");
      const name = elementText(delivery, "name");
      return id && name ? [{ id, name }] : [];
    });
  if (!deliveryTypes.length) {
    throw new SupplierIntegrationError("Rossko API did not return delivery types");
  }

  const knownDeliveryIds = new Set(deliveryTypes.map((delivery) => delivery.id));
  const addresses = children(child(result, "DeliveryAddress") || { name: "", text: "", children: [] }, "address");
  for (const address of addresses) {
    const addressId = elementText(address, "id");
    const compatibleIds = children(child(child(address, "Delivery") || { name: "", text: "", children: [] }, "ids") || { name: "", text: "", children: [] }, "id")
      .map((id) => id.text.trim())
      .filter((id) => id && knownDeliveryIds.has(id));
    if (addressId && compatibleIds[0]) {
      return { deliveryId: compatibleIds[0], addressId };
    }
  }

  const pickup = deliveryTypes.find((delivery) => /самовывоз/i.test(delivery.name));
  if (pickup) {
    return { deliveryId: pickup.id };
  }
  throw new SupplierIntegrationError("Rossko API did not return a usable delivery address or pickup method");
}

function parseRosskoStock(stock: XmlElement): RosskoStock | null {
  const price = parsePositiveNumber(elementText(stock, "price"));
  const quantity = parseNonNegativeInteger(elementText(stock, "count"));
  if (price === null || quantity === null || quantity === 0) {
    return null;
  }
  return {
    id: elementText(stock, "id"),
    price,
    quantity,
    warehouse: elementText(stock, "description"),
    deliveryDays: parseNonNegativeInteger(elementText(stock, "delivery")),
    deliveryStart: elementText(stock, "deliveryStart"),
    deliveryEnd: elementText(stock, "deliveryEnd"),
  };
}

function parseRosskoPart(part: XmlElement, includeNestedCrosses: boolean): RosskoPart | null {
  const brand = elementText(part, "brand");
  const article = elementText(part, "partnumber");
  const title = elementText(part, "name");
  if (!brand || !article || !title) {
    return null;
  }
  const stocks = children(child(part, "stocks") || { name: "", text: "", children: [] }, "stock")
    .map(parseRosskoStock)
    .filter((stock): stock is RosskoStock => stock !== null);
  const crosses = includeNestedCrosses
    ? children(child(part, "crosses") || { name: "", text: "", children: [] }, "part")
      .map((cross) => parseRosskoPart(cross, false))
      .filter((cross): cross is RosskoPart => cross !== null)
    : [];
  return {
    guid: elementText(part, "guid"),
    brand,
    article,
    title,
    stocks,
    crosses,
  };
}

export function parseRosskoSearchParts(xml: string): RosskoPart[] {
  const result = findDescendant(parseRosskoXml(xml), "SearchResult");
  if (!result) {
    throw new SupplierIntegrationError("Rossko API did not return a search result");
  }
  if (!parseSuccess(result)) {
    throw new SupplierIntegrationError("Rossko API reported an unsuccessful search");
  }
  const partsList = child(result, "PartsList");
  if (!partsList) {
    return [];
  }
  return children(partsList, "Part")
    .map((part) => parseRosskoPart(part, true))
    .filter((part): part is RosskoPart => part !== null);
}

function normalizedArticle(value: string): string {
  return (value.split("@")[0] || value).replace(/[^A-Z0-9А-Я]/gi, "").toUpperCase();
}

function normalizedBrand(value: string): string {
  return value.trim().toUpperCase();
}

function validIsoDate(value: string | null): string | null {
  if (!value || !Number.isFinite(Date.parse(value))) {
    return null;
  }
  return new Date(value).toISOString();
}

function portalLink(article: string): string {
  const url = new URL("/search", rosskoPortalOrigin);
  url.searchParams.set("q", article);
  url.searchParams.set("text", article);
  url.searchParams.set("type", "all");
  return url.toString();
}

function normalizedResults(part: RosskoPart, requestedArticle: string, isAnalog: boolean): NormalizedSearchResult[] {
  const displayArticle = part.article.split("@")[0]?.trim() || part.article.trim();
  return part.stocks.map((stock) => {
    const deliveryStart = validIsoDate(stock.deliveryStart);
    const deliveryEnd = validIsoDate(stock.deliveryEnd);
    const derivedDelivery = !deliveryStart && !deliveryEnd && stock.deliveryDays !== null
      ? new Date(Date.now() + stock.deliveryDays * 86_400_000).toISOString()
      : null;
    return {
      supplier: "rossko",
      brand: part.brand,
      article: displayArticle,
      title: part.title,
      price: stock.price,
      quantity: stock.quantity,
      warehouse: stock.warehouse,
      warehouseFull: stock.warehouse,
      deliveryDate: deliveryStart || deliveryEnd || derivedDelivery,
      ...(deliveryStart && deliveryEnd && deliveryStart !== deliveryEnd ? { deliveryDateTo: deliveryEnd } : {}),
      deliveryDateApproximate: Boolean(derivedDelivery),
      link: portalLink(requestedArticle),
      ...(isAnalog ? { isAnalog: true } : {}),
    } satisfies NormalizedSearchResult;
  });
}

export function normalizeRosskoApiSearchResults(parts: RosskoPart[], requestedArticle: string): NormalizedSearchResult[] {
  const targetArticle = normalizedArticle(requestedArticle);
  return parts.flatMap((part) => normalizedArticle(part.article) === targetArticle
    ? normalizedResults(part, requestedArticle, false)
    : []);
}

export function normalizeRosskoApiAnalogResults(
  parts: RosskoPart[],
  requestedArticle: string,
  requestedBrand: string,
): NormalizedSearchResult[] {
  const targetArticle = normalizedArticle(requestedArticle);
  const targetBrand = normalizedBrand(requestedBrand);
  const seen = new Set<string>();
  const results: NormalizedSearchResult[] = [];
  for (const part of parts) {
    if (normalizedArticle(part.article) !== targetArticle || normalizedBrand(part.brand) !== targetBrand) {
      continue;
    }
    for (const cross of part.crosses) {
      if (normalizedArticle(cross.article) === targetArticle && normalizedBrand(cross.brand) === targetBrand) {
        continue;
      }
      for (const result of normalizedResults(cross, cross.article, true)) {
        const key = `${normalizedBrand(result.brand)}\0${normalizedArticle(result.article)}\0${result.warehouse || ""}\0${result.price}`;
        if (!seen.has(key)) {
          seen.add(key);
          results.push(result);
        }
      }
    }
  }
  return results;
}

function isXmlContentType(value: string | null): boolean {
  const mediaType = value?.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "text/xml" || mediaType === "application/xml" || mediaType === "application/soap+xml" || Boolean(mediaType?.endsWith("+xml"));
}

async function readBoundedXmlResponse(response: Response): Promise<string> {
  if (!isXmlContentType(response.headers.get("content-type"))) {
    await response.body?.cancel().catch(() => undefined);
    throw new SupplierIntegrationError("Rossko API returned an unexpected content type");
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > supplierMaxResponseBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new SupplierIntegrationError("Rossko API response is too large");
  }
  const reader = response.body?.getReader();
  if (!reader) {
    throw new SupplierIntegrationError("Rossko API returned an empty response");
  }
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > supplierMaxResponseBytes) {
        await reader.cancel();
        throw new SupplierIntegrationError("Rossko API response is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf-8");
}

async function callRosskoApi(
  method: "GetCheckoutDetails" | "GetSearch",
  fields: Record<string, string | undefined>,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const bounded = createBoundedAbortSignal(signal, rosskoConfig.requestTimeoutMs, `Rossko ${method} timed out`);
  try {
    let response: Response;
    try {
      response = await fetch(`${rosskoApiOrigin}/service/${rosskoApiVersion}/${method}`, {
        method: "POST",
        signal: bounded.signal,
        headers: {
          "Content-Type": "text/xml; charset=utf-8",
          SOAPAction: `"${rosskoApiOrigin}/service/${rosskoApiVersion}/${method}"`,
        },
        body: buildRosskoSoapEnvelope(method, fields),
      });
    } catch (error) {
      if (bounded.signal.aborted) {
        throw bounded.signal.reason;
      }
      throw new SupplierIntegrationError("Rossko API request failed", { cause: error });
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined);
      throw new SupplierAuthError(`Rossko API returned HTTP ${response.status}`);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new SupplierIntegrationError(`Rossko API returned HTTP ${response.status}`);
    }
    return await readBoundedXmlResponse(response);
  } finally {
    bounded.dispose();
  }
}

async function resolveDeliverySelection(
  credentials: RosskoApiCredentials,
  signal: AbortSignal,
  forceRefresh = false,
): Promise<RosskoDeliverySelection> {
  const hash = credentialsHash(credentials);
  if (!forceRefresh && cachedDeliverySelection?.credentialsHash === hash) {
    signal.throwIfAborted();
    return cachedDeliverySelection.selection;
  }
  const xml = await callRosskoApi("GetCheckoutDetails", {
    KEY1: credentials.key1,
    KEY2: credentials.key2,
  }, signal);
  const selection = parseRosskoCheckoutDetails(xml);
  cachedDeliverySelection = { credentialsHash: hash, selection };
  return selection;
}

export async function verifyRosskoApiCredentials(credentials: RosskoApiCredentials, signal: AbortSignal): Promise<void> {
  await resolveDeliverySelection(credentials, signal, true);
}

export function clearRosskoApiState(): void {
  cachedDeliverySelection = null;
}

async function searchRosskoParts(
  credentials: RosskoApiCredentials,
  searchText: string,
  signal: AbortSignal,
): Promise<RosskoPart[]> {
  const selection = await resolveDeliverySelection(credentials, signal);
  const xml = await callRosskoApi("GetSearch", {
    KEY1: credentials.key1,
    KEY2: credentials.key2,
    text: searchText,
    delivery_id: selection.deliveryId,
    address_id: selection.addressId,
  }, signal);
  return parseRosskoSearchParts(xml);
}

export class RosskoApiAdapter implements SupplierAdapter {
  readonly id = "rossko";
  readonly displayName = "Rossko";
  readonly timeoutMs = rosskoConfig.searchTimeoutMs;

  async ensureSession(sessionManager: SupplierSessionManager): Promise<SupplierSessionState> {
    return sessionManager.getRosskoApiCredentials()
      ? sessionManager.markChecked(this.id, "Rossko API keys are configured")
      : sessionManager.markUnauthorized(this.id, "Rossko API keys are required");
  }

  async validateSession(context: SupplierSearchContext, sessionManager: SupplierSessionManager): Promise<void> {
    const credentials = sessionManager.getRosskoApiCredentials();
    if (!credentials) {
      throw new SupplierAuthError("Rossko API keys are missing");
    }
    await resolveDeliverySelection(credentials, context.signal, true);
  }

  async search(
    query: SearchQuery,
    context: SupplierSearchContext,
    onResult: (result: NormalizedSearchResult) => void,
    sessionManager: SupplierSessionManager,
  ): Promise<void> {
    const credentials = sessionManager.getRosskoApiCredentials();
    if (!credentials) {
      throw new SupplierAuthError("Rossko API keys are missing");
    }
    const parts = await searchRosskoParts(credentials, query.article.trim(), context.signal);
    for (const result of normalizeRosskoApiSearchResults(parts, query.article)) {
      context.signal.throwIfAborted();
      onResult(result);
    }
  }

  async searchAnalogs(
    query: AnalogSearchQuery,
    context: SupplierSearchContext,
    onResult: (result: NormalizedSearchResult) => void,
    sessionManager: SupplierSessionManager,
  ): Promise<void> {
    const credentials = sessionManager.getRosskoApiCredentials();
    if (!credentials) {
      throw new SupplierAuthError("Rossko API keys are missing");
    }
    const parts = await searchRosskoParts(credentials, `${query.article.trim()} ${query.brand.trim()}`, context.signal);
    for (const result of normalizeRosskoApiAnalogResults(parts, query.article, query.brand)) {
      context.signal.throwIfAborted();
      onResult(result);
    }
  }
}
