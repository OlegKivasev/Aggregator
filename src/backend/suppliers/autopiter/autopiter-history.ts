import type { OrderHistoryItem, OrderHistoryOrder } from "../../purchasing/order-history-contract.ts";
import { historyDate, historyNumber, historyText } from "../../purchasing/order-history-values.ts";
import { SupplierIntegrationError } from "../errors.ts";
import type { XmlElement } from "../soap-xml.ts";

const name = (element: XmlElement): string => element.name.split(":").at(-1) || "";
const invalid = (): never => { throw new SupplierIntegrationError("Autopiter returned invalid order history"); };
const child = (element: XmlElement, key: string): XmlElement | undefined => {
  const matches = element.children.filter((item) => name(item) === key);
  if (matches.length > 1) return invalid();
  return matches[0];
};
const text = (element: XmlElement, key: string, max = 500): string | null => {
  const item = child(element, key);
  if (item?.children.length || item && item.text.trim().length > max) return invalid();
  return historyText(item?.text, max);
};
const integer = (element: XmlElement, key: string, minimum = 0, maximum = 1_000_000_000): number => {
  const value = text(element, key);
  const parsed = value && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) return invalid();
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
    if (row.text.trim()) return invalid();
    const number = String(integer(row, "OrderNumber", 1, 2147483647));
    const date = autopiterHistoryDate(text(row, "DateInvoice", 40));
    const quantity = integer(row, "Quantity");
    if (!date) return invalid();
    const previous = invoices.get(number);
    if (previous && (previous.date !== date || previous.quantity !== quantity)) return invalid();
    invoices.set(number, { number, date, quantity });
  }
  return [...invoices.values()].sort((left, right) => right.date.localeCompare(left.date));
}

export function parseAutopiterInvoiceItems(invoice: AutopiterInvoice, rows: XmlElement[]): OrderHistoryOrder {
  if (!rows.length && invoice.quantity > 0) return invalid();
  const positions = new Set<string>();
  const items = rows.map((row): OrderHistoryItem => {
    if (row.text.trim()) return invalid();
    const article = text(row, "Number", 200);
    const quantity = integer(row, "OrderCount", 1);
    const received = integer(row, "GetCount");
    if (!article || received > quantity) return invalid();
    const status = child(row, "Status");
    if (status?.text.trim()) return invalid();
    const statusId = status ? integer(status, "Id", 0, 2147483647) : null;
    const returned = statusId === 128 || statusId === 1859;
    const cancelled = statusId === 9 ? quantity - received : 0;
    const delivered = returned ? 0 : received;
    const rawPositionId = text(row, "Id", 100);
    const positionId = rawPositionId === "0" ? null : rawPositionId;
    // Id is present in WSDL, though omitted from the prose documentation. DetailUid identifies an offer, not a historical position.
    if (positionId && (!/^[1-9]\d{0,9}$/.test(positionId) || Number(positionId) > 2147483647 || positions.has(positionId))) return invalid();
    if (positionId) positions.add(positionId);
    const rawPrice = text(row, "Price");
    const price = rawPrice === null ? null : historyNumber(rawPrice);
    if (rawPrice !== null && price === null) return invalid();
    const fulfillment = returned ? "returned" : cancelled === quantity ? "cancelled" : delivered === quantity ? "delivered"
      : cancelled > 0 && delivered > 0 && cancelled + delivered === quantity ? "partially_cancelled"
        : cancelled > 0 || delivered > 0 ? "partial"
          : statusId !== null && [677, 1309, 1546, 1919].includes(statusId) ? "in_transit"
            : statusId === 11 || statusId === 1858 || statusId === 149 || statusId === null ? "unknown" : "processing";
    return { ...(positionId ? { positionId } : {}), article, brand: text(row, "CatalogName", 200),
      title: text(row, "Name"), quantity, price, status: status ? text(status, "Name") : null, fulfillment,
      ...(cancelled > 0 ? { cancelledQuantity: cancelled } : {}), ...(delivered > 0 ? { deliveredQuantity: delivered } : {}),
      ...(fulfillment === "partially_cancelled" ? { fulfillmentQuantities: { delivered, cancelled } } : {}),
      expectedDate: autopiterHistoryDate(text(row, "DeliveryDate", 40)), guaranteedDate: null, warehouse: text(row, "Region") };
  });
  return { number: invoice.number, date: invoice.date, items };
}
