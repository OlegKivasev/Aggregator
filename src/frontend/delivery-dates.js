export function deliveryCalendarDay(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T]([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.\d{1,3})?)?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?)?$/.exec(value);
  if (!match) return null;
  const [year, month, day] = match.slice(1, 4).map(Number);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  if (calendarDate.getUTCFullYear() !== year || calendarDate.getUTCMonth() !== month - 1 || calendarDate.getUTCDate() !== day) return null;
  // Search instants use browser time; unzoned order dates retain the supplier's calendar day.
  if (match[7]) {
    const instant = new Date(value);
    return Number.isFinite(instant.getTime())
      ? Date.UTC(instant.getFullYear(), instant.getMonth(), instant.getDate()) / 86_400_000 : null;
  }
  return calendarDate.getTime() / 86_400_000;
}

export function isOfferDueSoon(result, now = Date.now()) {
  if (!result || typeof result !== "object" || typeof result.supplier !== "string" || result.deliveryDateApproximate) return false;
  const from = deliveryCalendarDay(result.deliveryDate);
  const to = deliveryCalendarDay(result.deliveryDateTo ?? result.deliveryDate);
  const today = new Date(now);
  if (from === null || to === null || to < from || !Number.isFinite(today.getTime())) return false;
  const currentDay = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) / 86_400_000;
  if (result.supplier === "part-kom") {
    const weekday = new Date(from * 86_400_000).getUTCDay();
    return from === currentDay + 1 && to === from && weekday >= 1 && weekday <= 5;
  }
  return from >= currentDay + 1 && to <= currentDay + 2;
}
