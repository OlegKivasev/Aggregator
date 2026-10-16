const weekendMessage = "Выходной · уточните доставку";
const weekendExplanation = "В выходные доставки PartKOM нет. Дата поставщика сохранена — уточните фактическую дату доставки.";

function deliveryWeekday(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T]([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.\d{1,3})?)?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?)?$/.exec(value);
  if (!match) return null;
  const [year, month, day] = match.slice(1, 4).map(Number);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  if (calendarDate.getUTCFullYear() !== year || calendarDate.getUTCMonth() !== month - 1 || calendarDate.getUTCDate() !== day) return null;
  // Search dates are instants displayed in browser time; order dates without a zone are supplier calendar dates.
  if (match[7]) {
    const instant = new Date(value);
    return Number.isFinite(instant.getTime()) ? instant.getDay() : null;
  }
  return calendarDate.getUTCDay();
}

export function hasPartKomWeekendDelivery(supplier, ...dates) {
  return supplier === "part-kom" && dates.some((value) => [0, 6].includes(deliveryWeekday(value)));
}

export function renderDeliveryWarning(supplier, ...dates) {
  return hasPartKomWeekendDelivery(supplier, ...dates)
    ? `<span class="delivery-warning" title="${weekendExplanation}"><b aria-hidden="true">!</b>${weekendMessage}</span>` : "";
}

export function deliveryWarningNode(supplier, ...dates) {
  if (!hasPartKomWeekendDelivery(supplier, ...dates)) return null;
  const notice = document.createElement("span");
  notice.className = "delivery-warning";
  notice.title = weekendExplanation;
  const icon = document.createElement("b");
  icon.textContent = "!";
  icon.setAttribute("aria-hidden", "true");
  notice.append(icon, document.createTextNode(weekendMessage));
  return notice;
}

export function formatArmtekReturnDays(value) {
  if (!Number.isInteger(value) || value < 0 || value > 9999) return "Срок возврата не указан";
  return value === 0 ? "Возврат недоступен" : `Возврат: ${value} дн.`;
}

export const armtekReturnSource = "Условия предложения при оформлении заказа";
