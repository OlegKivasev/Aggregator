export const formatWarehouse = (value) => {
  const normalized = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";

  if (!normalized || normalized.length > 80 || /возврат|требован|упаков|установ|поставщик|не подлежат/i.test(normalized)) {
    return "-";
  }

  return normalized;
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

const getDeliverySortGroup = (result, from, to) => {
  if (to !== null) {
    return 4;
  }

  const dayOffset = getCalendarDayOffset(from);
  const isNearby = dayOffset >= 0 && dayOffset <= 2;
  if (isNearby) {
    return result.deliveryDateApproximate === true ? 1 : 0;
  }
  return result.deliveryDateApproximate === true ? 3 : 2;
};

export const compareDeliveryDates = (left, right) => {
  const leftFrom = getDeliveryTimestamp(left.deliveryDate);
  const rightFrom = getDeliveryTimestamp(right.deliveryDate);

  if (leftFrom === null || rightFrom === null) {
    return leftFrom === rightFrom ? 0 : leftFrom === null ? 1 : -1;
  }

  const leftTo = getDeliveryTimestamp(left.deliveryDateTo);
  const rightTo = getDeliveryTimestamp(right.deliveryDateTo);
  const groupComparison = getDeliverySortGroup(left, leftFrom, leftTo)
    - getDeliverySortGroup(right, rightFrom, rightTo);
  if (groupComparison !== 0) {
    return groupComparison;
  }

  return leftFrom - rightFrom
    || Number(left.deliveryDateApproximate === true) - Number(right.deliveryDateApproximate === true)
    || (leftTo ?? leftFrom) - (rightTo ?? rightFrom);
};
