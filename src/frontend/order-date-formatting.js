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
