const hourMs = 3_600_000;
const dayMs = 24 * hourMs;
const samaraOffsetMs = 4 * hourMs;
export interface OrderQuietHours { enabled: boolean; from: string; to: string }
export const defaultOrderQuietHours: Readonly<OrderQuietHours> = Object.freeze({ enabled: true, from: "23:00", to: "07:00" });
export function validOrderQuietHours(value: unknown): value is OrderQuietHours {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const hours = value as Record<string, unknown>;
  const time = (part: unknown): part is string => typeof part === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(part);
  return typeof hours.enabled === "boolean" && time(hours.from) && time(hours.to) && hours.from !== hours.to
    && Object.keys(hours).every((key) => ["enabled", "from", "to"].includes(key));
}
const milliseconds = (time: string): number => (Number(time.slice(0, 2)) * 60 + Number(time.slice(3))) * 60_000;

/** Daily automatic monitoring pause in Samara time (UTC+4). */
export function nextOrderCheckTime(now: number, hours: OrderQuietHours = defaultOrderQuietHours): number {
  if (!hours.enabled) return now;
  const localTime = now + samaraOffsetMs;
  const midnight = Math.floor(localTime / dayMs) * dayMs;
  const timeOfDay = localTime - midnight;
  const from = milliseconds(hours.from); const to = milliseconds(hours.to);
  const overnight = from > to;
  const paused = overnight ? timeOfDay >= from || timeOfDay < to : timeOfDay >= from && timeOfDay < to;
  if (!paused) return now;
  return midnight + to + (overnight && timeOfDay >= from ? dayMs : 0) - samaraOffsetMs;
}
