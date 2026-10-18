import { deliveryCalendarDay } from "./delivery-dates.js";

export function hasSupplierWeekendDelivery(supplier, valueFrom, valueTo = null) {
  if (supplier !== "part-kom" && supplier !== "forum-auto") return false;
  const from = deliveryCalendarDay(valueFrom ?? valueTo);
  const to = deliveryCalendarDay(valueTo ?? valueFrom);
  if (from === null || to === null || to < from) return false;
  const firstWeekday = new Date(from * 86_400_000).getUTCDay();
  const lastWeekday = new Date(to * 86_400_000).getUTCDay();
  // Only this weekend, optionally preceded by Friday; later workdays remove the warning.
  const maximumSpan = firstWeekday === 5 ? 2 : firstWeekday === 6 ? 1 : firstWeekday === 0 ? 0 : -1;
  return [0, 6].includes(lastWeekday) && to - from <= maximumSpan;
}

export function hasOfferDeliveryWarning(supplier, valueFrom, valueTo = null, now = Date.now()) {
  if (hasSupplierWeekendDelivery(supplier, valueFrom, valueTo)) return true;
  if (supplier !== "part-kom") return false;
  const from = deliveryCalendarDay(valueFrom);
  const to = deliveryCalendarDay(valueTo ?? valueFrom);
  const today = new Date(now);
  if (from === null || from !== to || !Number.isFinite(today.getTime())) return false;
  const currentDay = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) / 86_400_000;
  return from - currentDay === 2;
}

export function formatArmtekReturnDays(value) {
  if (!Number.isInteger(value) || value < 0 || value > 9999) return "Срок возврата не указан";
  return value === 0 ? "Возврат недоступен" : `Возврат: ${value} дн.`;
}

export const armtekReturnSource = "Условия предложения при оформлении заказа";
