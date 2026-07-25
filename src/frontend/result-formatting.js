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

export const splitAnalogResults = (results) => ({
  exact: results.filter((result) => result.isAnalog !== true),
  analogs: results.filter((result) => result.isAnalog === true),
});
