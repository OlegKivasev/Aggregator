import { createHash } from "node:crypto";
import { createBoundedAbortSignal } from "../../abort.ts";
import { rosskoConfig, supplierMaxResponseBytes } from "../../config.ts";
import type { SupplierSessionManager } from "../../session/session-manager.ts";
import type {
  AnalogSearchQuery,
  BrandDiscoveryQuery,
  NormalizedSearchResult,
  RosskoApiCredentials,
  SearchQuery,
  SupplierSearchContext,
  SupplierSessionState,
} from "../../types.ts";
import { SupplierAuthError, SupplierIntegrationError } from "../errors.ts";
import type { SupplierAdapter } from "../supplier-adapter.ts";
import { attachPurchaseReference } from "../../purchasing/purchase-offer.ts";
import type { CheckoutDetails, OrderGroupResult, RosskoOrderChoices, RosskoOrderReceipt } from "../../purchasing/order-contract.ts";
import type { PurchaseLine } from "../../purchasing/purchase-offer.ts";
import type { OrderHistory } from "../../purchasing/order-history-contract.ts";
import { finishOrderHistory, historyDate, historyNumber, historyText } from "../../purchasing/order-history-values.ts";

const rosskoApiOrigin = "https://api.rossko.ru";
const rosskoApiVersion = "v2.1";
const rosskoPortalOrigin = "https://samara.rossko.ru";
const orderStatuses: Record<number, string> = {
  0: "Ждёт подтверждения", 1: "Комплектуется", 2: "Отгружено", 3: "Готово к отгрузке",
  5: "Ожидаем поступление", 6: "На складе филиала", 7: "Нет в наличии", 8: "Отменён клиентом", 9: "Просрочен",
  31: "Ожидаем товар на складе", 32: "Возврат на согласовании", 33: "Товар на экспертизе",
  34: "Возврат отклонён", 35: "Возврат частично отклонён", 36: "Товар возвращён",
};

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

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function buildRosskoSoapEnvelope(method: "GetCheckoutDetails" | "GetSearch", fields: Record<string, string | undefined>): string {
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

export function parseRosskoOrderChoices(xml: string): RosskoOrderChoices {
  const result = findDescendant(parseRosskoXml(xml), "CheckoutDetailsResult");
  if (!result) throw new SupplierIntegrationError("Rossko checkout details are missing");
  if (!parseSuccess(result)) throw new SupplierAuthError("Rossko rejected checkout details request");
  const deliveryTypes = children(child(result, "DeliveryType") || { name: "", text: "", children: [] }, "delivery")
    .flatMap((entry) => {
      const id = elementText(entry, "id");
      const label = elementText(entry, "name");
      return id && label ? [{ id, label }] : [];
    });
  const addresses = children(child(result, "DeliveryAddress") || { name: "", text: "", children: [] }, "address")
    .flatMap((entry) => {
      const id = elementText(entry, "id");
      const label = ["city", "street", "house", "office"].map((name) => elementText(entry, name)).filter(Boolean).join(", ");
      const deliveryIds = children(child(child(entry, "Delivery") || { name: "", text: "", children: [] }, "ids")
        || { name: "", text: "", children: [] }, "id").map((node) => node.text.trim());
      return id && label ? [{ id, label, deliveryIds }] : [];
    });
  const deliveries: RosskoOrderChoices["deliveries"] = [];
  for (const delivery of deliveryTypes) {
    if (/самовывоз/i.test(delivery.label)) deliveries.push({ ...delivery, addressId: null });
    for (const address of addresses) {
      if (address.deliveryIds.includes(delivery.id)) deliveries.push({ id: delivery.id, label: `${delivery.label}: ${address.label}`, addressId: address.id });
    }
  }
  const payments = children(child(result, "PaymentType") || { name: "", text: "", children: [] }, "payment")
    .flatMap((entry) => {
      const id = elementText(entry, "id");
      const label = elementText(entry, "name");
      return id && label ? [{ id, label }] : [];
    });
  const companies = children(child(result, "CompanyList") || { name: "", text: "", children: [] }, "company")
    .flatMap((entry) => {
      const id = elementText(entry, "id");
      const label = elementText(entry, "name");
      return id && label ? [{ id, label }] : [];
    });
  if (!deliveries.length || !payments.length) throw new SupplierIntegrationError("Rossko did not return order delivery or payment options");
  return { deliveries, payments, companies };
}

export async function getRosskoOrderChoices(credentials: RosskoApiCredentials, signal: AbortSignal): Promise<RosskoOrderChoices> {
  const xml = await callRosskoApi("GetCheckoutDetails", { KEY1: credentials.key1, KEY2: credentials.key2 }, signal);
  return parseRosskoOrderChoices(xml);
}

export function buildRosskoOrderEnvelope(credentials: RosskoApiCredentials, options: NonNullable<CheckoutDetails["rossko"]>, lines: PurchaseLine[]): string {
  const delivery = `<ros:delivery><ros:delivery_id>${escapeXml(options.deliveryId)}</ros:delivery_id>${options.addressId
    ? `<ros:address_id>${escapeXml(options.addressId)}</ros:address_id>` : ""}</ros:delivery>`;
  const payment = `<ros:payment><ros:payment_id>${escapeXml(options.paymentId)}</ros:payment_id>${options.companyId
    ? `<ros:requisite_id>${escapeXml(options.companyId)}</ros:requisite_id>` : ""}</ros:payment>`;
  const parts = lines.map((line) => {
    if (line.reference.supplier !== "rossko" || !line.reference.stockId) throw new SupplierIntegrationError("Rossko order is missing a stock code");
    return `<ros:Part><ros:partnumber>${escapeXml(line.result.article)}</ros:partnumber><ros:brand>${escapeXml(line.result.brand)}</ros:brand>`
      + `<ros:stock>${escapeXml(line.reference.stockId)}</ros:stock><ros:count>${line.quantity}</ros:count></ros:Part>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ros="${rosskoApiOrigin}/">`
    + `<soapenv:Body><ros:GetCheckout><ros:KEY1>${escapeXml(credentials.key1)}</ros:KEY1><ros:KEY2>${escapeXml(credentials.key2)}</ros:KEY2>`
    + `${delivery}${payment}<ros:contact><ros:name>${escapeXml(options.name)}</ros:name><ros:phone>${escapeXml(options.phone)}</ros:phone></ros:contact>`
    + `<ros:delivery_parts>${options.deliveryParts ? "true" : "false"}</ros:delivery_parts><ros:PARTS>${parts}</ros:PARTS></ros:GetCheckout></soapenv:Body></soapenv:Envelope>`;
}

export function parseRosskoOrderResult(xml: string, lines: PurchaseLine[]): OrderGroupResult {
  const result = findDescendant(parseRosskoXml(xml), "CheckoutResult");
  if (!result) throw new SupplierIntegrationError("Rossko checkout result is missing");
  const success = parseSuccess(result);
  const items = children(child(result, "ItemsList") || { name: "", text: "", children: [] }, "Item");
  const errors = children(child(result, "ItemsErrorList") || { name: "", text: "", children: [] }, "ItemError");
  if (!success && !items.length && !errors.length) {
    return { confirmed: [], rejected: lines.map((line) => ({ id: line.id, message: "Rossko отклонил заказ." })) };
  }
  const confirmed: OrderGroupResult["confirmed"] = [];
  const rejected: OrderGroupResult["rejected"] = [];
  for (const line of lines) {
    if (line.reference.supplier !== "rossko" || !line.reference.stockId) throw new SupplierIntegrationError("Rossko order line is invalid");
    const stockId = line.reference.stockId;
    const matches = (entry: XmlElement) => elementText(entry, "partnumber") === line.result.article
      && elementText(entry, "brand") === line.result.brand && elementText(entry, "stock") === stockId;
    const accepted = items.filter(matches);
    const failed = errors.filter(matches);
    let acceptedQuantity = 0;
    const orderIds: string[] = [];
    const rosskoOrders: RosskoOrderReceipt[] = [];
    for (const item of accepted) {
      const count = parseNonNegativeInteger(elementText(item, "count"));
      const orderId = elementText(item, "order_id");
      if (count === null || count < 1 || !orderId || !/^\d+$/.test(orderId)) throw new SupplierIntegrationError("Rossko order item is incomplete");
      acceptedQuantity += count;
      if (!orderIds.includes(orderId)) orderIds.push(orderId);
      const price = parsePositiveNumber(elementText(item, "price"));
      const total = parsePositiveNumber(elementText(item, "total_price"));
      const optional = (name: string, limit = 200) => {
        const value = elementText(item, name);
        return value && value.length <= limit ? value : undefined;
      };
      rosskoOrders.push({ orderId, quantity: count,
        ...(price !== null ? { price } : {}), ...(total !== null ? { total } : {}),
        ...(optional("deliveryStart", 40) ? { deliveryStart: optional("deliveryStart", 40) } : {}),
        ...(optional("deliveryEnd", 40) ? { deliveryEnd: optional("deliveryEnd", 40) } : {}),
        ...(optional("description") ? { warehouse: optional("description") } : {}) });
    }
    if (acceptedQuantity > line.quantity || acceptedQuantity + failed.reduce((sum, entry) => sum + (parseNonNegativeInteger(elementText(entry, "count")) ?? 0), 0) > line.quantity) {
      throw new SupplierIntegrationError("Rossko order quantities do not match request");
    }
    if (acceptedQuantity > 0) confirmed.push({ id: line.id, acceptedQuantity, orderIds, rosskoOrders,
      ...(acceptedQuantity < line.quantity ? { message: "Rossko подтвердил только часть количества." } : {}) });
    else if (failed.length) rejected.push({ id: line.id, message: "Rossko не принял позицию." });
    else throw new SupplierIntegrationError("Rossko did not report an order line");
  }
  return { confirmed, rejected };
}

function rosskoOrdersEnvelope(credentials: RosskoApiCredentials, ids: string[]): string {
  const orderIds = ids.map((id) => `<ros:id>${escapeXml(id)}</ros:id>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ros="${rosskoApiOrigin}/">`
    + `<soapenv:Body><ros:GetOrders><ros:KEY1>${escapeXml(credentials.key1)}</ros:KEY1><ros:KEY2>${escapeXml(credentials.key2)}</ros:KEY2>`
    + `<ros:order_ids>${orderIds}</ros:order_ids></ros:GetOrders></soapenv:Body></soapenv:Envelope>`;
}

export function parseRosskoOrdersDetails(xml: string, result: OrderGroupResult, lines: PurchaseLine[]): void {
  const root = findDescendant(parseRosskoXml(xml), "OrdersResult");
  if (!root || !parseSuccess(root)) return;
  const lineById = new Map(lines.map((line) => [line.id, line]));
  const orders = children(child(root, "OrdersList") || { name: "", text: "", children: [] }, "Order");
  for (const confirmed of result.confirmed) {
    const line = lineById.get(confirmed.id);
    if (!line || line.reference.supplier !== "rossko") continue;
    const partGuid = line.reference.partGuid;
    for (const receipt of confirmed.rosskoOrders ?? []) {
      const order = orders.find((entry) => elementText(entry, "id") === receipt.orderId);
      if (!order) continue;
      const parts = children(child(order, "parts") || { name: "", text: "", children: [] }, "part");
      const matching = parts.find((part) => elementText(part, "partnumber") === line.result.article
        && elementText(part, "brand") === line.result.brand
        && elementText(part, "guid") === partGuid
        && parseNonNegativeInteger(elementText(part, "count")) === receipt.quantity);
      if (!matching) continue;
      const detail = child(order, "detail");
      const optional = (node: XmlElement | null, name: string, limit = 200) => {
        const value = node ? elementText(node, name) : null;
        return value && value.length <= limit ? value : undefined;
      };
      const statusCode = parseNonNegativeInteger(elementText(matching, "status"));
      const orderTotal = parsePositiveNumber(elementText(order, "total_price"));
      const status = statusCode === null ? undefined : orderStatuses[statusCode];
      Object.assign(receipt, {
        ...(optional(order, "created_date", 40) ? { createdAt: optional(order, "created_date", 40) } : {}),
        ...(optional(order, "delivery_date", 40) ? { deliveryAt: optional(order, "delivery_date", 40) } : {}),
        ...(status ? { status } : {}),
        ...(orderTotal !== null ? { orderTotal } : {}),
        ...(optional(detail, "delivery_type") ? { deliveryType: optional(detail, "delivery_type") } : {}),
        ...(optional(detail, "delivery_address") ? { deliveryAddress: optional(detail, "delivery_address") } : {}),
        ...(optional(detail, "payment_type") ? { paymentType: optional(detail, "payment_type") } : {}),
      });
    }
  }
}

export function parseRosskoOrderHistory(xml: string): OrderHistory {
  const root = findDescendant(parseRosskoXml(xml), "OrdersResult");
  if (!root) throw new SupplierIntegrationError("Rossko order history is missing");
  const list = child(root, "OrdersList");
  const rows = list ? children(list, "Order") : [];
  if (!parseSuccess(root)) {
    if (!rows.length && isRosskoNotFoundMessage(elementText(root, "message"))) return { orders: [], limited: false };
    throw new SupplierIntegrationError("Rossko order history request was unsuccessful");
  }
  const orders = rows.map((row) => {
    const number = elementText(row, "id");
    const parts = child(row, "parts");
    if (!number || !/^[1-9]\d{0,19}$/.test(number) || !parts || !children(parts, "part").length) {
      throw new SupplierIntegrationError("Rossko history order is incomplete");
    }
    return { number, date: historyDate(elementText(row, "created_date"), "russian"), items: children(parts, "part").map((item) => {
      const article = historyText(elementText(item, "partnumber"), 128);
      const quantity = historyNumber(elementText(item, "count"));
      if (!article || quantity === null || quantity <= 0) throw new SupplierIntegrationError("Rossko history item is incomplete");
      const code = parseNonNegativeInteger(elementText(item, "status"));
      return { article, brand: historyText(elementText(item, "brand"), 200), title: historyText(elementText(item, "name")), quantity,
        price: historyNumber(elementText(item, "price")), status: code === null ? null : orderStatuses[code] ?? `Код статуса: ${code}`,
        expectedDate: historyDate(elementText(row, "delivery_date"), "russian"), guaranteedDate: null,
        warehouse: historyText(elementText(row, "stock_address"), 200) };
    }) };
  });
  return finishOrderHistory(orders, rows.length >= 500);
}

export async function listRosskoOrderHistory(credentials: RosskoApiCredentials, signal: AbortSignal): Promise<OrderHistory> {
  const envelope = `<?xml version="1.0" encoding="UTF-8"?>`
    + `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ros="${rosskoApiOrigin}/">`
    + `<soapenv:Body><ros:GetOrders><ros:KEY1>${escapeXml(credentials.key1)}</ros:KEY1><ros:KEY2>${escapeXml(credentials.key2)}</ros:KEY2>`
    + `<ros:limit>500</ros:limit></ros:GetOrders></soapenv:Body></soapenv:Envelope>`;
  return parseRosskoOrderHistory(await callRosskoApi("GetOrders", {}, signal, envelope));
}

export async function placeRosskoOrder(lines: PurchaseLine[], credentials: RosskoApiCredentials, details: CheckoutDetails,
  signal: AbortSignal): Promise<OrderGroupResult> {
  const options = details.rossko;
  if (!options || typeof options.deliveryId !== "string" || typeof options.paymentId !== "string"
    || typeof options.name !== "string" || !options.name.trim() || options.name.length > 100
    || typeof options.phone !== "string" || !/^[+\d()\s-]{6,40}$/.test(options.phone)
    || typeof options.deliveryParts !== "boolean") throw new SupplierIntegrationError("Rossko order details are invalid");
  const xml = await callRosskoApi("GetCheckout", {}, signal, buildRosskoOrderEnvelope(credentials, options, lines));
  const result = parseRosskoOrderResult(xml, lines);
  const ids = [...new Set(result.confirmed.flatMap((line) => line.orderIds))];
  if (ids.length) {
    const detailSignal = createBoundedAbortSignal(signal, 5_000, "Rossko order details timed out");
    try {
      const detailsXml = await callRosskoApi("GetOrders", {}, detailSignal.signal, rosskoOrdersEnvelope(credentials, ids));
      parseRosskoOrdersDetails(detailsXml, result, lines);
    } catch {
      // Checkout has already been confirmed; optional read-only details may be unavailable immediately.
    } finally { detailSignal.dispose(); }
  }
  return result;
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

function isRosskoNotFoundMessage(message: string | null): boolean {
  return message !== null && /^ничего\s+не\s+найдено$/iu.test(message);
}

export function parseRosskoSearchParts(xml: string): RosskoPart[] {
  const result = findDescendant(parseRosskoXml(xml), "SearchResult");
  if (!result) {
    throw new SupplierIntegrationError("Rossko API did not return a search result");
  }
  const partsList = child(result, "PartsList");
  const parts = partsList ? children(partsList, "Part") : [];
  const message = elementText(result, "message");
  if (!parseSuccess(result)) {
    if (parts.length === 0 && (!message || isRosskoNotFoundMessage(message))) {
      return [];
    }
    throw new SupplierIntegrationError("Rossko API reported an unsuccessful search");
  }
  if (!partsList) {
    return [];
  }
  return parts
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
    const result = {
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
      deliveryDateApproximate: Boolean(deliveryStart || deliveryEnd || derivedDelivery),
      link: portalLink(requestedArticle),
      ...(isAnalog ? { isAnalog: true } : {}),
    } satisfies NormalizedSearchResult;
    return attachPurchaseReference(result, { supplier: "rossko", partGuid: part.guid, stockId: stock.id });
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
  method: "GetCheckoutDetails" | "GetSearch" | "GetCheckout" | "GetOrders",
  fields: Record<string, string | undefined>,
  signal: AbortSignal,
  envelope?: string,
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
        body: envelope ?? buildRosskoSoapEnvelope(method as "GetCheckoutDetails" | "GetSearch", fields),
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
  } catch (error) {
    if (bounded.signal.aborted) throw bounded.signal.reason;
    throw error;
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

  async searchBrands(
    query: BrandDiscoveryQuery,
    context: SupplierSearchContext,
    onBrands: (brands: string[]) => void,
    sessionManager: SupplierSessionManager,
  ): Promise<void> {
    const credentials = sessionManager.getRosskoApiCredentials();
    if (!credentials) {
      throw new SupplierAuthError("Rossko API keys are missing");
    }
    const target = normalizedArticle(query.article);
    const parts = await searchRosskoParts(credentials, query.article.trim(), context.signal);
    onBrands([...new Set(parts
      .filter((part) => normalizedArticle(part.article) === target)
      .map((part) => part.brand.trim())
      .filter(Boolean))]);
  }
}
