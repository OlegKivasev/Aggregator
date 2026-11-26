export function formatOrderDate(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
  const match = iso ?? /^(\d{2})\.(\d{2})\.(\d{4})(?: (\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
  if (!match) return text;
  const [year, month, day] = iso ? match.slice(1, 4) : [match[3], match[2], match[1]];
  const timestamp = `${year}-${month}-${day}T${match[4] ?? "00"}:${match[5] ?? "00"}:${match[6] ?? "00"}`;
  const date = new Date(`${timestamp}Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 19) !== timestamp) return text;
  return `${day}.${month}.${year}${match[4] ? ` ${match[4]}:${match[5]}` : ""}`;
}

export function orderCalendarDay(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  const iso = /^(\d{4}-\d{2}-\d{2})(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(text);
  const russian = iso ? null : /^(\d{2})\.(\d{2})\.(\d{4})(?: \d{2}:\d{2}(?::\d{2})?)?$/.exec(text);
  const day = iso?.[1] ?? (russian && `${russian[3]}-${russian[2]}-${russian[1]}`);
  if (!day || day.startsWith("0000-") || day.startsWith("0001-")) return null;
  const date = new Date(`${day}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day ? day : null;
}

export function latestDeliveryDay(...values) {
  let latest = null;
  for (const value of values) {
    if (typeof value !== "string") continue;
    const day = orderCalendarDay(value);
    if (day) {
      if (!latest || day > latest) latest = day;
      continue;
    }
    const range = /^(\d{1,2})\s*[-–—]\s*(\d{1,2})\.(\d{2}\.\d{4})$/.exec(value.trim());
    const dates = range
      ? [`${range[1].padStart(2, "0")}.${range[3]}`, `${range[2].padStart(2, "0")}.${range[3]}`]
      : value.split(/\s*[–—]\s*|\s+-\s+|\s*-\s*(?=\d{4}-\d{2}-\d{2}|\d{2}\.\d{2}\.\d{4})/);
    if (dates.length < 2) continue;
    for (const endpoint of dates) {
      const parsed = orderCalendarDay(endpoint);
      if (parsed && (!latest || parsed > latest)) latest = parsed;
    }
  }
  return latest;
}
