const hourMs = 3_600_000;
const dayMs = 24 * hourMs;
const samaraOffsetMs = 4 * hourMs;

/** Daily supplier monitoring window: 07:00 <= Samara time (UTC+4) < 23:00. */
export function nextOrderCheckTime(now: number): number {
  const localTime = now + samaraOffsetMs;
  const midnight = Math.floor(localTime / dayMs) * dayMs;
  const timeOfDay = localTime - midnight;
  if (timeOfDay < 7 * hourMs) return midnight + 7 * hourMs - samaraOffsetMs;
  if (timeOfDay >= 23 * hourMs) return midnight + dayMs + 7 * hourMs - samaraOffsetMs;
  return now;
}
