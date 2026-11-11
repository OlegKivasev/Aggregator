import type { OrderGroupResult } from "../../purchasing/order-contract.ts";
import { samePurchaseArticle, type PurchaseLine } from "../../purchasing/purchase-offer.ts";
import { SupplierIntegrationError } from "../errors.ts";
import type { XmlElement } from "../soap-xml.ts";
import type { AutopiterSoapFields } from "./autopiter-api-adapter.ts";

const name = (element: XmlElement): string => element.name.split(":").at(-1) || "";
const children = (element: XmlElement, key: string): XmlElement[] => element.children.filter((child) => name(child) === key);
const invalid = (): never => { throw new SupplierIntegrationError("Autopiter order confirmation is inconsistent"); };
const value = (element: XmlElement, key: string): string => {
  const matches = children(element, key);
  if (matches.length > 1 || matches[0]?.children.length) return invalid();
  return matches[0]?.text.trim() ?? "";
};
const refusalMessages: Record<string, string> = {
  "1": "Позиция отсутствует у Автопитера.",
  "2": "У Автопитера недостаточно товара для выбранного количества.",
  "3": "Автопитер требует другое минимальное количество или кратность упаковки.",
  "4": "Цена Автопитера изменилась. Обновите предложение и подтвердите заказ заново.",
  "5": "Автопитер отклонил комментарий к позиции.",
  "7": "Автопитер отклонил количество товара.",
  "8": "Автопитер не принял позицию.",
  "9": "Автопитер предлагает замену артикула. Выберите её и проверьте заказ заново.",
  "11": "Позиция удалена у Автопитера.",
};

export function autopiterOrderFields(lines: PurchaseLine[]): AutopiterSoapFields {
  if (!lines.length || lines.length > 500) return invalid();
  const ids = new Set<string>();
  const details = new Set<string>();
  const items = lines.map((line) => {
    const reference = line.reference;
    if (reference.supplier !== "autopiter" || line.result.supplier !== "autopiter"
      || typeof reference.detailUid !== "string" || !reference.detailUid || reference.detailUid.length > 2000
      || /[\x00-\x1f\x7f]/.test(reference.detailUid) || !/^\d{1,10}$/.test(reference.sellerId)
      || Number(reference.sellerId) > 2147483647 || details.has(reference.detailUid) || ids.has(line.id)
      || !Number.isSafeInteger(line.quantity) || line.quantity < 1 || line.quantity > 1_000_000
      || typeof line.result.quantity !== "number" || line.quantity > line.result.quantity
      || !Number.isFinite(line.result.price) || line.result.price <= 0) return invalid();
    ids.add(line.id);
    details.add(reference.detailUid);
    return { DetailUid: reference.detailUid, Comment: "", SalePrice: String(line.result.price), Quantity: String(line.quantity) };
  });
  return { Items: { ItemAddCartModel: items } };
}

// OrderNumber is the documented success flag. Codes 0/12 alone only describe a cart update.
export function parseAutopiterOrderResult(result: XmlElement, xml: string, lines: PurchaseLine[]): OrderGroupResult {
  autopiterOrderFields(lines);
  if (result.text.trim() || result.children.some((child) => !["Items", "OrderNumber"].includes(name(child)))
    || children(result, "OrderNumber").length !== 1 || children(result, "Items").length > 1) return invalid();
  const number = value(result, "OrderNumber");
  const isNil = /<(?:(?:[\w.-]+):)?OrderNumber\b[^>]*\s(?:[\w.-]+:)?nil\s*=\s*["'](?:true|1)["']/.test(xml);
  if (isNil ? number !== "" : !/^[1-9]\d{0,9}$/.test(number) || Number(number) > 2147483647) return invalid();
  const list = children(result, "Items")[0];
  if (list?.text.trim() || list?.children.some((child) => name(child) !== "ResponseCodeItemCart")) return invalid();
  const byDetail = new Map(lines.map((line) => [line.reference.supplier === "autopiter" ? line.reference.detailUid : "", line]));
  const responses = new Map<string, { quantity: number; price: number; codes: string[]; deliveryAt?: string }>();
  for (const entry of list?.children ?? []) {
    if (entry.text.trim() || children(entry, "Item").length !== 1 || children(entry, "Code").length > 1
      || entry.children.some((child) => !["Code", "Item"].includes(name(child)))) return invalid();
    const item = children(entry, "Item")[0];
    const detailUid = value(item, "DetailUid");
    const line = byDetail.get(detailUid);
    const codesElement = children(entry, "Code")[0];
    if (!line || responses.has(line.id) || item.text.trim() || codesElement?.text.trim()
      || codesElement?.children.some((child) => name(child) !== "ResponseCode" || child.children.length)) return invalid();
    const sellerId = value(item, "SellerId");
    const article = value(item, "Number");
    const brand = value(item, "CatalogName");
    if (line.reference.supplier !== "autopiter" || sellerId && sellerId !== line.reference.sellerId
      || article && !samePurchaseArticle(article, line.result.article)
      || brand && brand.toUpperCase() !== line.result.brand.trim().toUpperCase()) return invalid();
    const codes = codesElement?.children.map((child) => child.text.trim()) ?? [];
    if (codes.some((code) => code !== "0" && code !== "12" && !Object.hasOwn(refusalMessages, code))) return invalid();
    const rawQuantity = value(item, "Quantity");
    const rawPrice = value(item, "SalePrice");
    const quantity = /^\d+$/.test(rawQuantity) ? Number(rawQuantity) : NaN;
    const price = /^\d+(?:\.\d+)?$/.test(rawPrice) ? Number(rawPrice) : NaN;
    if (!Number.isSafeInteger(quantity) || quantity > 1_000_000 || !Number.isFinite(price)) return invalid();
    const deliveryAt = value(item, "DeliveryDate");
    responses.set(line.id, { quantity, price, codes,
      ...(deliveryAt && !deliveryAt.startsWith("0001-") && Number.isFinite(Date.parse(deliveryAt)) ? { deliveryAt } : {}) });
  }
  if (isNil) {
    // One invalid position can reject the entire invoice; untouched positions stay in our cart too.
    if (![...responses.values()].some((item) => item.codes.some((code) => Object.hasOwn(refusalMessages, code)))) return invalid();
    return { confirmed: [], rejected: lines.map((line) => ({ id: line.id,
      message: responses.get(line.id)?.codes.filter((code) => Object.hasOwn(refusalMessages, code)).map((code) => refusalMessages[code]).join(" ")
        || "Автопитер не оформил счёт из-за отклонённых позиций. Проверьте товары и повторите заказ." })) };
  }
  if (responses.size && responses.size !== lines.length) return invalid();
  return { rejected: [], confirmed: lines.map((line) => {
    const item = responses.get(line.id);
    if (item && (item.codes.some((code) => code !== "0" && code !== "12") || item.quantity < 1
      || item.quantity > line.quantity || item.price !== line.result.price)) return invalid();
    const quantity = item?.quantity ?? line.quantity;
    return { id: line.id, acceptedQuantity: quantity, orderIds: [number],
      autopiterOrders: [{ orderId: number, quantity, price: item?.price ?? line.result.price,
        ...(item?.deliveryAt ? { deliveryAt: item.deliveryAt } : {}) }] };
  }) };
}
