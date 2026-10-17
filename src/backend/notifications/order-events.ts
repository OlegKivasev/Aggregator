import type { OrderHistory } from "../purchasing/order-history-contract.ts";
import type { OrderHistorySupplier } from "../purchasing/order-cancellation-contract.ts";

export const supplierNames: Record<OrderHistorySupplier, string> = { armtek: "Armtek", "part-kom": "PartKOM", "forum-auto": "Forum Auto", rossko: "Rossko" };
export const notificationSuppliers = Object.keys(supplierNames) as OrderHistorySupplier[];
export type EventKind = "new" | "cancelled" | "received";
export interface MonitoredItem { article: string; brand: string | null; title: string | null; quantity: number; cancelled: number; received: number; price: number | null }
export interface MonitoredOrder { number: string; date: string | null; items: Record<string, MonitoredItem> }
export interface OrderEvent { supplier: OrderHistorySupplier; number: string; kind: EventKind; items: MonitoredItem[] }

const text = (value: unknown, maximum: number): string | null => typeof value === "string" && value.trim() && value.length <= maximum ? value.trim() : null;
const quantity = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1_000_000_000;

export function monitoredOrders(history: OrderHistory): MonitoredOrder[] {
  if (!history || !Array.isArray(history.orders) || history.orders.length > 500 || typeof history.limited !== "boolean") throw new Error("Invalid order history");
  const orders = new Map<string, MonitoredOrder>();
  let count = 0;
  for (const order of history.orders) {
    if (!order || !text(order.number, 200) || !Array.isArray(order.items)) throw new Error("Invalid order history");
    let current = orders.get(order.number);
    if (!current) { current = { number: order.number, date: text(order.date, 32), items: {} }; orders.set(order.number, current); }
    for (const item of order.items) {
      if (++count > 5_000 || !item || !text(item.article, 200) || !quantity(item.quantity) || item.quantity === 0) throw new Error("Invalid order history item");
      const cancelled = item.fulfillment === "cancelled" ? item.quantity : item.cancelledQuantity ?? item.fulfillmentQuantities?.cancelled ?? 0;
      const received = item.fulfillment === "delivered" ? item.quantity : item.deliveredQuantity ?? item.fulfillmentQuantities?.delivered ?? 0;
      if (!quantity(cancelled) || !quantity(received) || cancelled + received > item.quantity) throw new Error("Invalid order quantities");
      const key = item.positionId ? JSON.stringify(["position", item.positionId])
        : JSON.stringify(["part", text(item.brand, 200)?.toLocaleUpperCase() ?? null, item.article.toLocaleUpperCase()]);
      const previous = current.items[key];
      const next: MonitoredItem = { article: item.article, brand: text(item.brand, 200), title: text(item.title, 500),
        quantity: item.quantity, cancelled, received, price: typeof item.price === "number" && Number.isFinite(item.price) && item.price >= 0 && item.price <= Number.MAX_SAFE_INTEGER ? item.price : null };
      if (previous) {
        previous.quantity += next.quantity; previous.cancelled += cancelled; previous.received += received;
        if (previous.price !== next.price) previous.price = null;
      }
      else current.items[key] = next;
    }
  }
  return [...orders.values()];
}

export function orderChanges(supplier: OrderHistorySupplier, incoming: MonitoredOrder, previous: MonitoredOrder | null, announceNew: boolean): { snapshot: MonitoredOrder; events: OrderEvent[] } {
  const events: OrderEvent[] = [];
  const snapshot: MonitoredOrder = { ...incoming, items: { ...previous?.items } };
  const changes: Record<"cancelled" | "received", MonitoredItem[]> = { cancelled: [], received: [] };
  for (const [key, item] of Object.entries(incoming.items)) {
    const before = previous?.items[key];
    snapshot.items[key] = { ...item, cancelled: Math.max(item.cancelled, before?.cancelled ?? 0), received: Math.max(item.received, before?.received ?? 0) };
    for (const kind of ["cancelled", "received"] as const) {
      const delta = item[kind] - (before?.[kind] ?? 0);
      if (delta > 0 && (previous || announceNew)) changes[kind].push({ ...item, quantity: delta });
    }
  }
  if (!previous && announceNew) events.push({ supplier, number: incoming.number, kind: "new", items: Object.values(incoming.items) });
  for (const kind of ["cancelled", "received"] as const) if (changes[kind].length) events.push({ supplier, number: incoming.number, kind, items: changes[kind] });
  return { snapshot, events };
}

const clean = (value: string): string => value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim();
const labels: Record<EventKind, string> = { new: "НОВЫЙ ЗАКАЗ", cancelled: "ОТМЕНЕНО", received: "ПОЛУЧЕНО" };
const amount = (value: number): string => value.toLocaleString("ru-RU", { maximumFractionDigits: 2 });

/** Plain text only; shipping is never treated as receipt. */
export function formatOrderEvents(events: OrderEvent[]): string[] {
  const messages: string[] = [];
  let message = "Заказы: обновления";
  for (const event of events) {
    const header = `\n\n${labels[event.kind]} · ${supplierNames[event.supplier]}\nЗаказ № ${clean(event.number)}`;
    let block = header;
    for (const item of event.items) {
      const line = `\n• ${clean([item.brand, item.article].filter(Boolean).join(" "))}${item.title ? ` — ${clean(item.title)}` : ""}\n  ${amount(item.quantity)} шт.${item.price === null ? "" : ` · ${amount(item.price * item.quantity)} ₽`}`;
      if (block.length + line.length > 3_400) {
        if (message.length + block.length > 3_800) { messages.push(message); message = "Заказы: обновления"; }
        message += block; block = `${header}\nПродолжение`;
      }
      block += line;
    }
    if (message.length + block.length > 3_800) { messages.push(message); message = "Заказы: обновления"; }
    message += block;
  }
  if (message !== "Заказы: обновления") messages.push(message);
  return messages;
}
