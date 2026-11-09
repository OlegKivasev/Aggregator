// The exchange currently sends the vehicle and plate in one name. Split only
// a recognizable plate at the end, removing display separators from the name.
export function splitRepairVehicleName(value) {
  const displayValue = value.replace(/\s*\|\s*/gu, " ").trim();
  const match = /(?:^|[\s,;(])([АВЕКМНОРСТУХABEKMHOPCTYX]\s*\d{3}\s*[АВЕКМНОРСТУХABEKMHOPCTYX]{2}(?:\s*\d{2,3})?(?:\s+(?:RUS|РУС))?)\)?\s*$/iu.exec(displayValue);
  if (!match) return { name: displayValue, plate: "" };
  const name = displayValue.slice(0, match.index).trim().replace(/[,;—–-]+$/u, "").trim();
  return name ? { name, plate: match[1] } : { name: displayValue, plate: "" };
}
