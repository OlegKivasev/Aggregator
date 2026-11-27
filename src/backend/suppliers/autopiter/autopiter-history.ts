import type { OrderHistoryItem, OrderHistoryOrder } from "../../purchasing/order-history-contract.ts";
import { historyDate, historyNumber, historyText } from "../../purchasing/order-history-values.ts";
import { SupplierIntegrationError } from "../errors.ts";
import type { XmlElement } from "../soap-xml.ts";

const name = (element: XmlElement): string => element.name.split(":").at(-1) || "";
const invalid = (diagnosticCode: string, publicMessage: string): never => {
  throw new SupplierIntegrationError("Autopiter returned invalid order history", { diagnosticCode, publicMessage });
};
const emptyNil = (element: XmlElement, field: string): boolean => {
  if (!element.nil) return false;
  if (element.children.length || element.text.trim()) return invalid("nil_with_content", `элемент ${field} помечен как пустой (xsi:nil), но содержит данные`);
  return true;
};
const child = (element: XmlElement, key: string): XmlElement | undefined => {
  const matches = element.children.filter((item) => name(item) === key);
  if (matches.length > 1) return invalid("duplicate_field", `поле ${key} передано несколько раз`);
  return matches[0];
};
const text = (element: XmlElement, key: string, max = 500): string | null => {
  const item = child(element, key);
  if (item?.children.length) return invalid("nested_field", `поле ${key} содержит вложенные элементы вместо текста`);
  if (item && item.text.trim().length > max) return invalid("field_length", `поле ${key} длиннее ${max} символов`);
  return historyText(item?.text, max);
};
const integerErrors = {
  OrderNumber: ["invalid_order_number", "пустой или некорректный номер счёта (OrderNumber)"],
  Quantity: ["invalid_invoice_quantity", "некорректное количество товаров в счёте (Quantity)"],
  OrderCount: ["invalid_order_count", "некорректное заказанное количество (OrderCount)"],
  GetCount: ["invalid_get_count", "некорректное выданное количество (GetCount)"],
  "Status.Id": ["invalid_status_id", "некорректный код статуса (Status.Id)"],
} as const;
const integer = (value: string | null, field: keyof typeof integerErrors, minimum = 0, maximum = 1_000_000_000): number => {
  const parsed = value && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    const [code, message] = integerErrors[field];
    return invalid(code, message);
  }
  return parsed;
};

// Keep the supplier's wall-clock calendar date; converting to UTC can move a delivery to yesterday.
export function autopiterHistoryDate(value: string | null): string | null {
  if (!value || value.startsWith("0001-")) return null;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?$/.exec(value);
  return match && Number.isFinite(Date.parse(value)) ? historyDate(match[1].replace("T", " ")) : null;
}

export interface AutopiterInvoice { number: string; date: string; quantity: number }

export function parseAutopiterInvoices(rows: XmlElement[]): AutopiterInvoice[] {
  const invoices = new Map<string, AutopiterInvoice>();
  for (const row of rows) {
    if (emptyNil(row, "InvoiceModel")) continue;
    if (row.text.trim()) return invalid("invoice_text", "в элементе счёта (InvoiceModel) обнаружен текст вне полей");
    const orderNumber = child(row, "OrderNumber");
    if (!orderNumber) return invalid("missing_order_number", "у счёта отсутствует поле OrderNumber");
    if (orderNumber.children.length) return invalid("nested_field", "поле OrderNumber содержит вложенные элементы вместо номера счёта");
    // The list schema permits a null OrderNumber. The details method requires a concrete invoice number.
    const number = emptyNil(orderNumber, "OrderNumber") ? null : String(integer(historyText(orderNumber.text), "OrderNumber", 1, 2147483647));
    const date = autopiterHistoryDate(text(row, "DateInvoice", 40));
    const quantity = integer(text(row, "Quantity"), "Quantity");
    if (!date) return invalid("invalid_invoice_date", "пустая или некорректная дата счёта (DateInvoice)");
    if (number === null) continue;
    const previous = invoices.get(number);
    if (previous && (previous.date !== date || previous.quantity !== quantity)) {
      return invalid("conflicting_invoice", "дата или количество различаются у записей с одним номером счёта (OrderNumber)");
    }
    invoices.set(number, { number, date, quantity });
  }
  return [...invoices.values()].sort((left, right) => right.date.localeCompare(left.date));
}

export function parseAutopiterInvoiceItems(invoice: AutopiterInvoice, rows: XmlElement[]): OrderHistoryOrder {
  const positions = new Set<string>();
  const items: OrderHistoryItem[] = [];
  for (const row of rows) {
    if (emptyNil(row, "OrderInformationItemModel")) continue;
    if (row.text.trim()) return invalid("item_text", "в элементе позиции (OrderInformationItemModel) обнаружен текст вне полей");
    const article = text(row, "Number", 200) ?? "";
    const quantity = integer(text(row, "OrderCount"), "OrderCount", 1);
    const received = integer(text(row, "GetCount"), "GetCount");
    if (received > quantity) return invalid("received_exceeds_ordered", "выданное количество (GetCount) превышает заказанное (OrderCount)");
    const status = child(row, "Status");
    if (status?.text.trim()) return invalid("status_text", "в элементе статуса (Status) обнаружен текст вне полей");
    const statusId = status ? integer(text(status, "Id"), "Status.Id", 0, 2147483647) : null;
    const returned = statusId === 128 || statusId === 1859;
    const cancelled = statusId === 9 ? quantity - received : 0;
    const delivered = returned ? 0 : received;
    const rawPositionId = text(row, "Id", 100);
    const positionId = rawPositionId === "0" ? null : rawPositionId;
    // Id is present in WSDL, though omitted from the prose documentation. DetailUid identifies an offer, not a historical position.
    if (positionId) {
      if (!/^[1-9]\d{0,9}$/.test(positionId) || Number(positionId) > 2147483647) return invalid("invalid_position_id", "некорректный идентификатор позиции (Id)");
      if (positions.has(positionId)) return invalid("duplicate_position_id", "в счёте повторяется идентификатор позиции (Id)");
      positions.add(positionId);
    }
    const rawPrice = text(row, "Price");
    const price = rawPrice === null ? null : historyNumber(rawPrice);
    if (rawPrice !== null && price === null) return invalid("invalid_price", "в позиции указана некорректная цена (Price)");
    const fulfillment = returned ? "returned" : cancelled === quantity ? "cancelled" : delivered === quantity ? "delivered"
      : cancelled > 0 && delivered > 0 && cancelled + delivered === quantity ? "partially_cancelled"
        : cancelled > 0 || delivered > 0 ? "partial"
          : statusId !== null && [677, 1309, 1546, 1919].includes(statusId) ? "in_transit"
            : statusId === 11 || statusId === 1858 || statusId === 149 || statusId === null ? "unknown" : "processing";
    items.push({ ...(positionId ? { positionId } : {}), article, brand: text(row, "CatalogName", 200),
      title: text(row, "Name"), quantity, price, status: status ? text(status, "Name") : null, fulfillment,
      ...(cancelled > 0 ? { cancelledQuantity: cancelled } : {}), ...(delivered > 0 ? { deliveredQuantity: delivered } : {}),
      ...(fulfillment === "partially_cancelled" ? { fulfillmentQuantities: { delivered, cancelled } } : {}),
      expectedDate: autopiterHistoryDate(text(row, "DeliveryDate", 40)), guaranteedDate: null, warehouse: text(row, "Region") });
  }
  if (!items.length && invoice.quantity > 0) return invalid("missing_items", "в счёте указано количество товаров, но список позиций пуст");
  return { number: invoice.number, date: invoice.date, items };
}
