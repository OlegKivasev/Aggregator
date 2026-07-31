export const formatWarehouse = (value) => {
  const normalized = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";

  if (!normalized || normalized.length > 80 || /возврат|требован|упаков|установ|поставщик|не подлежат/i.test(normalized)) {
    return "-";
  }

  return normalized;
};

export const formatPartIdentity = (value) => {
  const characters = Array.from(typeof value === "string" ? value : "");
  if (!characters.length) {
    return "-";
  }

  const [firstCharacter, ...remainingCharacters] = characters;
  return `${firstCharacter.toUpperCase()}${remainingCharacters.join("").toLowerCase()}`;
};

const formatWarehouseFull = (value) => {
  const normalized = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return normalized && normalized.length <= 300 ? normalized : "-";
};

export const escapeHtml = (value) => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");

export const getSafeResultLink = (value) => {
  try {
    const url = new URL(String(value));
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : "";
  } catch {
    return "";
  }
};

export const renderWarehouse = (result) => {
  const warehouse = formatWarehouse(result.warehouse);
  const warehouseFull = formatWarehouseFull(result.warehouseFull);
  const tooltip = warehouseFull !== "-" && warehouseFull !== warehouse
    ? ` data-tooltip="${escapeHtml(warehouseFull)}" tabindex="0"`
    : "";

  if (warehouse === "-") {
    return warehouse;
  }

  if (result.supplier !== "stparts") {
    return `<span class="warehouse-code"${tooltip}>${escapeHtml(warehouse)}</span>`;
  }

  const color = ["green", "blue", "red"].includes(result.warehouseColor) ? result.warehouseColor : "";
  const rating = typeof result.warehouseRating === "string" && /^<?\d(?:\.\d)?$/.test(result.warehouseRating)
    ? result.warehouseRating.replace("<", "&lt;")
    : "";
  const ratingMarkup = rating ? `<span class="warehouse-rating">${rating}<span class="warehouse-rating__star" aria-hidden="true">★</span></span>` : "";

  return `<span class="warehouse-code${color ? ` warehouse-code--${color}` : ""}"${tooltip}>${escapeHtml(warehouse)}</span>${ratingMarkup}`;
};

export const formatPrice = (value) => {
  if (!Number.isFinite(value)) {
    return "Не указана";
  }

  const truncated = value < 0 ? Math.ceil(value * 100) / 100 : Math.trunc(value * 100) / 100;
  return `${truncated.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`;
};

const getDeliveryTimestamp = (value) => {
  const timestamp = value ? new Date(value).getTime() : Number.NaN;
  return Number.isNaN(timestamp) ? null : timestamp;
};

const getCalendarDayOffset = (value) => {
  const date = new Date(value);
  const today = new Date();
  const dateDay = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  const todayDay = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return (dateDay - todayDay) / 86_400_000;
};

const isSameCalendarDay = (leftValue, rightValue) => {
  const left = new Date(leftValue);
  const right = new Date(rightValue);
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
};

const getEffectiveDeliveryTo = (from, to) => (to !== null && !isSameCalendarDay(from, to) ? to : null);

const getDeliverySortGroup = (result, from, to) => {
  const dayOffset = getCalendarDayOffset(from);
  if (to === null && dayOffset >= 0 && dayOffset <= 2) {
    return dayOffset * 2 + Number(result.deliveryDateApproximate === true);
  }
  return 6;
};

export const compareDeliveryDates = (left, right) => {
  const leftFrom = getDeliveryTimestamp(left.deliveryDate);
  const rightFrom = getDeliveryTimestamp(right.deliveryDate);

  if (leftFrom === null || rightFrom === null) {
    return leftFrom === rightFrom ? 0 : leftFrom === null ? 1 : -1;
  }

  const leftTo = getDeliveryTimestamp(left.deliveryDateTo);
  const rightTo = getDeliveryTimestamp(right.deliveryDateTo);
  const effectiveLeftTo = getEffectiveDeliveryTo(leftFrom, leftTo);
  const effectiveRightTo = getEffectiveDeliveryTo(rightFrom, rightTo);
  const groupComparison = getDeliverySortGroup(left, leftFrom, effectiveLeftTo)
    - getDeliverySortGroup(right, rightFrom, effectiveRightTo);
  if (groupComparison !== 0) {
    return groupComparison;
  }

  // An interval can be fulfilled on its first day, so rank it by that earliest date.
  const leftEarliest = leftFrom;
  const rightEarliest = rightFrom;
  const resultTypeComparison = Number(effectiveLeftTo !== null) - Number(effectiveRightTo !== null);

  return leftEarliest - rightEarliest
    || resultTypeComparison
    || Number(left.deliveryDateApproximate === true) - Number(right.deliveryDateApproximate === true)
    || (effectiveLeftTo ?? leftFrom) - (effectiveRightTo ?? rightFrom);
};
