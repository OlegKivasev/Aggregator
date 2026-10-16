function deliveryCalendarDay(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T]([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.\d{1,3})?)?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?)?$/.exec(value);
  if (!match) return null;
  const [year, month, day] = match.slice(1, 4).map(Number);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  if (calendarDate.getUTCFullYear() !== year || calendarDate.getUTCMonth() !== month - 1 || calendarDate.getUTCDate() !== day) return null;
  // Search dates are instants displayed in browser time; order dates without a zone are supplier calendar dates.
  if (match[7]) {
    const instant = new Date(value);
    return Number.isFinite(instant.getTime())
      ? Date.UTC(instant.getFullYear(), instant.getMonth(), instant.getDate()) / 86_400_000 : null;
  }
  return calendarDate.getTime() / 86_400_000;
}

export function hasPartKomWeekendDelivery(supplier, valueFrom, valueTo = null) {
  if (supplier !== "part-kom") return false;
  const from = deliveryCalendarDay(valueFrom ?? valueTo);
  const to = deliveryCalendarDay(valueTo ?? valueFrom);
  if (from === null || to === null || to < from) return false;
  const firstWeekday = new Date(from * 86_400_000).getUTCDay();
  const lastWeekday = new Date(to * 86_400_000).getUTCDay();
  // Only this weekend, optionally preceded by Friday; later workdays remove the warning.
  const maximumSpan = firstWeekday === 5 ? 2 : firstWeekday === 6 ? 1 : firstWeekday === 0 ? 0 : -1;
  return [0, 6].includes(lastWeekday) && to - from <= maximumSpan;
}

export function formatArmtekReturnDays(value) {
  if (!Number.isInteger(value) || value < 0 || value > 9999) return "Срок возврата не указан";
  return value === 0 ? "Возврат недоступен" : `Возврат: ${value} дн.`;
}

export const armtekReturnSource = "Условия предложения при оформлении заказа";
