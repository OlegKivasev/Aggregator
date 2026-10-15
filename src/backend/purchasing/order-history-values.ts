import type { OrderHistory, OrderHistoryOrder } from "./order-history-contract.ts";

export function historyText(value: unknown, max = 500): string | null {
  return typeof value === "string" && value.trim() && value.trim().length <= max ? value.trim() : null;
}

export function historyNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" && /^\d+(?:[.,]\d+)?$/.test(value.trim())
    ? Number(value.trim().replace(",", ".")) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= Number.MAX_SAFE_INTEGER ? parsed : null;
}

export function historyDate(value: unknown, format: "iso" | "compact" | "russian" = "iso"): string | null {
  const text = historyText(value, 32);
  if (!text) return null;
  const match = format === "compact" ? /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2}))?$/.exec(text)
    : format === "russian" ? /^(\d{2})\.(\d{2})\.(\d{4})(?: (\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(text)
      : /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
  if (!match) return null;
  const [year, month, day] = format === "russian" ? [match[3], match[2], match[1]] : match.slice(1, 4);
  const [hour, minute, second] = [match[4] ?? "00", match[5] ?? "00", match[6] ?? "00"];
  const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() !== Number(year) || date.getUTCMonth() + 1 !== Number(month)
    || date.getUTCDate() !== Number(day) || date.getUTCHours() !== Number(hour) || date.getUTCMinutes() !== Number(minute)
    || date.getUTCSeconds() !== Number(second)) return null;
  return `${year}-${month}-${day}${match[4] ? ` ${hour}:${minute}:${second}` : ""}`;
}

export function finishOrderHistory(orders: OrderHistoryOrder[], limited = false): OrderHistory {
  orders.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  let remaining = 500;
  const selected: OrderHistoryOrder[] = [];
  for (const order of orders) {
    if (order.items.length > remaining) limited = true;
    if (remaining > 0) selected.push({ ...order, items: order.items.slice(0, remaining) });
    remaining -= Math.min(remaining, order.items.length);
  }
  return { orders: selected, limited };
}
