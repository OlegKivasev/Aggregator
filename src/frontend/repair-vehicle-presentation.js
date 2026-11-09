// The exchange currently sends the vehicle and plate in one name. Split only
// a recognizable plate at the end; preserve other names and contract text.
export function splitRepairVehicleName(value) {
  const match = /(?:^|[\s,;(])([АВЕКМНОРСТУХABEKMHOPCTYX]\s*\d{3}\s*[АВЕКМНОРСТУХABEKMHOPCTYX]{2}(?:\s*\d{2,3})?(?:\s+(?:RUS|РУС))?)\)?\s*$/iu.exec(value);
  if (!match) return { name: value, plate: "" };
  const name = value.slice(0, match.index).trim().replace(/[,;—–-]+$/u, "").trim();
  return name ? { name, plate: match[1] } : { name: value, plate: "" };
}
