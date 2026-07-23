import { buildIncompleteSearchWarnings, buildSupplierResultTooltip } from "./supplier-search-summary.js";

const form = document.querySelector("#search-form");
const articleInput = document.querySelector("#article-input");
const submitButton = document.querySelector("#submit-button");
const globalStatus = document.querySelector("#global-status");
const resultsBody = document.querySelector("#results-body");
const resultCount = document.querySelector("#result-count");
const resultsPanel = document.querySelector("#results-panel");
const resultsTable = document.querySelector("#results-table");
const resultsEmpty = document.querySelector("#results-empty");
const searchLoading = document.querySelector("#search-loading");
const searchLoadingTitle = document.querySelector("#search-loading-title");
const searchLoadingDescription = document.querySelector("#search-loading-description");
const searchLoadingNote = document.querySelector("#search-loading-note");
const searchLoadingCancel = document.querySelector("#search-loading-cancel");
const cancelSearchButton = document.querySelector("#cancel-search-button");
const markupPercentInput = document.querySelector("#markup-percent");
const tableSearchInput = document.querySelector("#table-search");
const sortButtons = [...document.querySelectorAll(".table-sort")];
const tableColumnInputs = [...document.querySelectorAll(".table-column-input")];
const tableColumnsReset = document.querySelector("#table-columns-reset");
const searchTabsList = document.querySelector("#search-tabs-list");
const newTabButton = document.querySelector("#new-tab-button");
const settingsToggle = document.querySelector("#settings-toggle");
const supplierEnabledInputs = [...document.querySelectorAll(".supplier-enabled-input")];
const suppliersDropdown = document.querySelector(".suppliers-dropdown");
const filtersDropdown = document.querySelector("#filters-dropdown");
const filterColumns = document.querySelector("#filter-columns");
const filterColumnButtons = [...document.querySelectorAll("[data-filter-column]")];
const filterSubmenu = document.querySelector("#filter-submenu");
const filterSubmenuTitle = document.querySelector("#filter-submenu-title");
const filterValues = document.querySelector("#filter-values");
const filtersReset = document.querySelector("#filters-reset");
const settingsDrawer = document.querySelector("#settings-drawer");
const settingsClose = document.querySelector("#settings-close");
const settingsBackdrop = document.querySelector("#settings-backdrop");
const rosskoAuthForm = document.querySelector("#rossko-auth-form");
const rosskoLoginInput = document.querySelector("#rossko-login");
const rosskoPasswordInput = document.querySelector("#rossko-password");
const rosskoConnectButton = document.querySelector("#rossko-connect-button");
const rosskoLogoutButton = document.querySelector("#rossko-logout-button");
const rosskoSessionPill = document.querySelector("#rossko-session-pill");
const rosskoAuthFeedback = document.querySelector("#rossko-auth-feedback");
const armtekAuthForm = document.querySelector("#armtek-auth-form");
const armtekLoginInput = document.querySelector("#armtek-login");
const armtekPasswordInput = document.querySelector("#armtek-password");
const armtekConnectButton = document.querySelector("#armtek-connect-button");
const armtekLogoutButton = document.querySelector("#armtek-logout-button");
const armtekSessionPill = document.querySelector("#armtek-session-pill");
const armtekAuthFeedback = document.querySelector("#armtek-auth-feedback");
const partKomAuthForm = document.querySelector("#part-kom-auth-form");
const partKomLoginInput = document.querySelector("#part-kom-login");
const partKomPasswordInput = document.querySelector("#part-kom-password");
const partKomConnectButton = document.querySelector("#part-kom-connect-button");
const partKomLogoutButton = document.querySelector("#part-kom-logout-button");
const partKomSessionPill = document.querySelector("#part-kom-session-pill");
const partKomAuthFeedback = document.querySelector("#part-kom-auth-feedback");
const stpartsAuthForm = document.querySelector("#stparts-auth-form");
const stpartsLoginInput = document.querySelector("#stparts-login");
const stpartsPasswordInput = document.querySelector("#stparts-password");
const stpartsConnectButton = document.querySelector("#stparts-connect-button");
const stpartsLogoutButton = document.querySelector("#stparts-logout-button");
const stpartsSessionPill = document.querySelector("#stparts-session-pill");
const stpartsAuthFeedback = document.querySelector("#stparts-auth-feedback");
const motorDetalAuthForm = document.querySelector("#motordetal-auth-form");
const motorDetalLoginInput = document.querySelector("#motordetal-login");
const motorDetalPasswordInput = document.querySelector("#motordetal-password");
const motorDetalConnectButton = document.querySelector("#motordetal-connect-button");
const motorDetalLogoutButton = document.querySelector("#motordetal-logout-button");
const motorDetalSessionPill = document.querySelector("#motordetal-session-pill");
const motorDetalAuthFeedback = document.querySelector("#motordetal-auth-feedback");
const mladovAuthForm = document.querySelector("#mladov-auth-form");
const mladovLoginInput = document.querySelector("#mladov-login");
const mladovPasswordInput = document.querySelector("#mladov-password");
const mladovConnectButton = document.querySelector("#mladov-connect-button");
const mladovLogoutButton = document.querySelector("#mladov-logout-button");
const mladovSessionPill = document.querySelector("#mladov-session-pill");
const mladovAuthFeedback = document.querySelector("#mladov-auth-feedback");
const supplierCheck = document.querySelector("#supplier-check");
const supplierCheckTitle = document.querySelector("#supplier-check-title");
const supplierCheckMessage = document.querySelector("#supplier-check-message");
const supplierCheckList = document.querySelector("#supplier-check-list");
const supplierCheckOk = document.querySelector("#supplier-check-ok");
const supplierNotice = document.querySelector("#supplier-notice");
const supplierNoticeSummary = document.querySelector("#supplier-notice-summary");
const supplierNoticeList = document.querySelector("#supplier-notice-list");
const passwordFields = [...document.querySelectorAll(".password-field")];

let searchTabs = [];
let activeTabId = null;
let tabSequence = 1;
let results = [];
let sortState = { key: "price", direction: "ascending" };
let markupPercent = 35;
let tableSearchTerm = "";
let supplierCheckInProgress = false;
let searchProgressTimer = null;
let activeFilterColumn = "";
const selectedFilterValuesByColumn = new Map();
const filterRangesByColumn = new Map();
const supplierSessionStates = new Map();

const searchStateStorageKey = "autoservice.searchState";
const tableColumnsStorageKey = "autoservice.tableColumns";
const lastSearchStorageKey = "autoservice.lastSearchStartedAt";
const supplierCheckIntervalMs = 2 * 60 * 60 * 1000;
const supplierCheckSuccessDelayMs = 3000;

const supplierNames = {
  rossko: "Rossko",
  armtek: "Armtek",
  "part-kom": "Part-Kom",
  stparts: "STParts",
  motordetal: "MotorDetal",
  mladov: "Механик Ладов",
};
const supplierIds = Object.keys(supplierNames);
const tableColumnIds = tableColumnInputs.map((input) => input.value);
let visibleTableColumns = new Set(tableColumnIds);
const filterColumnNames = Object.fromEntries(filterColumnButtons.map((button) => [
  button.dataset.filterColumn,
  button.firstChild.textContent.trim(),
]));
const rangeFilterColumns = new Set(["price", "markupPrice", "deliveryDate"]);

const supplierSearchToggles = Object.fromEntries(
  supplierEnabledInputs.map((input) => [input.value, input.closest(".supplier-search-toggle")]),
);
const supplierEnabledInputsById = Object.fromEntries(supplierEnabledInputs.map((input) => [input.value, input]));

const getEnabledSuppliers = () => supplierEnabledInputs.filter((input) => input.checked).map((input) => input.value);

const getFilterValue = (result, column) => {
  if (column === "supplier") {
    return supplierNames[result.supplier] ?? result.supplier;
  }
  if (column === "warehouse") {
    return formatWarehouse(result.warehouse);
  }
  if (column === "price") {
    return formatPrice(result.price);
  }
  if (column === "markupPrice") {
    return formatPrice(getMarkupPrice(result));
  }
  if (column === "deliveryDate") {
    return result.supplier === "mladov" && !result.deliveryDate
      ? "-"
      : formatDeliveryDate(result.deliveryDate, result.deliveryDateApproximate, result.deliveryDateTo);
  }
  return String(result[column] ?? "-");
};

const getRangeFilterValue = (result, column) => {
  if (column === "price") {
    return Number(result.price);
  }
  if (column === "markupPrice") {
    return getMarkupPrice(result);
  }
  const timestamp = result.deliveryDate ? new Date(result.deliveryDate).getTime() : Number.NaN;
  return Number.isFinite(timestamp) ? timestamp : null;
};

const getSelectedFilterValues = (column) => selectedFilterValuesByColumn.get(column) ?? new Set();

const getFilterRange = (column) => filterRangesByColumn.get(column) ?? { from: "", to: "" };

const isRangeFilterActive = (column) => {
  const range = getFilterRange(column);
  return Boolean(range.from || range.to);
};

const hasActiveFilter = (column) => (rangeFilterColumns.has(column)
  ? isRangeFilterActive(column)
  : getSelectedFilterValues(column).size > 0);

const hasAnyActiveFilters = () => tableColumnIds.some((column) => hasActiveFilter(column));

const getFilteredResults = () => {
  const normalizedSearchTerm = tableSearchTerm.trim().toLocaleLowerCase();

  return results.filter((result) => {
    if (normalizedSearchTerm) {
      const searchableValues = [
        supplierNames[result.supplier] ?? result.supplier,
        result.brand,
        result.article,
        result.title,
        result.warehouse,
      ];
      if (!searchableValues.some((value) => String(value ?? "").toLocaleLowerCase().includes(normalizedSearchTerm))) {
        return false;
      }
    }

    return tableColumnIds.every((column) => {
      if (!hasActiveFilter(column)) {
        return true;
      }

      if (rangeFilterColumns.has(column)) {
        const range = getFilterRange(column);
        const from = column === "deliveryDate" && range.from
          ? new Date(`${range.from}T00:00:00`).getTime()
          : Number(range.from);
        const to = column === "deliveryDate" && range.to
          ? new Date(`${range.to}T23:59:59.999`).getTime()
          : Number(range.to);
        const value = getRangeFilterValue(result, column);
        return Number.isFinite(value)
          && (!range.from || value >= from)
          && (!range.to || value <= to);
      }

      return getSelectedFilterValues(column).has(getFilterValue(result, column));
    });
  });
};

const renderFilterValues = () => {
  filterValues.replaceChildren();
  if (!activeFilterColumn) {
    filterSubmenu.hidden = true;
    filtersReset.hidden = !hasAnyActiveFilters();
    filterColumnButtons.forEach((button) => button.classList.remove("is-active"));
    return;
  }

  filterSubmenu.hidden = false;
  filterSubmenuTitle.textContent = filterColumnNames[activeFilterColumn];
  filterColumnButtons.forEach((button) => button.classList.toggle("is-active", button.dataset.filterColumn === activeFilterColumn));
  if (rangeFilterColumns.has(activeFilterColumn)) {
    const isDate = activeFilterColumn === "deliveryDate";
    const createRangeInput = (bound, labelText) => {
      const label = document.createElement("label");
      label.className = "filters-dropdown__range";
      const text = document.createElement("span");
      text.textContent = labelText;
      const input = document.createElement("input");
      input.type = isDate ? "date" : "number";
      input.min = isDate ? "" : "0";
      input.step = isDate ? "" : "0.01";
      input.placeholder = isDate ? "дд.мм.гггг" : "0";
      input.value = getFilterRange(activeFilterColumn)[bound];
      input.dataset.filterRange = bound;
      label.append(text, input);
      return label;
    };
    filterValues.replaceChildren(
      createRangeInput("from", "От"),
      createRangeInput("to", "До"),
    );
    filtersReset.hidden = !hasAnyActiveFilters();
    return;
  }

  const values = [...new Set(results.map((result) => getFilterValue(result, activeFilterColumn)))].sort(resultCollator.compare);
  filterValues.replaceChildren(...values.map((value) => {
    const label = document.createElement("label");
    label.className = "filters-dropdown__value";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = getSelectedFilterValues(activeFilterColumn).has(value);
    input.value = value;
    const text = document.createElement("span");
    text.textContent = value;
    label.append(input, text);
    return label;
  }));
  filtersReset.hidden = !hasAnyActiveFilters();
};

const hidePassword = (passwordField) => {
  const input = passwordField.querySelector("input");
  const toggle = passwordField.querySelector(".password-toggle");
  input.type = "password";
  toggle.setAttribute("aria-label", "Показать пароль");
};

const updateSupplierSearchToggle = (supplier, authorized) => {
  const input = supplierEnabledInputsById[supplier];
  const toggle = supplierSearchToggles[supplier];

  if (!input || !toggle) {
    return;
  }

  toggle.hidden = !authorized;

  if (!authorized && input.checked) {
    input.checked = false;
    syncActiveTab();
    saveSearchState();
  }

  suppliersDropdown.hidden = !supplierEnabledInputs.some((candidate) => !supplierSearchToggles[candidate.value]?.hidden);
};

const setSupplierEnabled = (supplier, enabled) => {
  const input = supplierEnabledInputsById[supplier];

  if (!input) {
    return;
  }

  input.checked = enabled;
  syncActiveTab();
  saveSearchState();
};

const normalizeMarkupPercent = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(1000, Math.max(0, parsed)) : 35;
};

const createSearchTab = (data = {}) => ({
  id: data.id ?? `tab-${Date.now()}-${tabSequence++}`,
  article: typeof data.article === "string" ? data.article : "",
  enabledSuppliers: Array.isArray(data.enabledSuppliers) ? data.enabledSuppliers : getEnabledSuppliers(),
  status: typeof data.status === "string" && data.status !== "Ожидание поиска" ? data.status : "",
  results: Array.isArray(data.results) ? data.results : [],
  hasSearched:
    typeof data.hasSearched === "boolean"
      ? data.hasSearched
      : Boolean(data.results?.length) || Boolean(data.status && data.status !== "Ожидание поиска"),
  markupPercent: normalizeMarkupPercent(data.markupPercent),
  supplierStatuses: {},
  supplierSearchStartedAt: {},
  supplierSearchDurations: {},
  source: null,
});

const getActiveTab = () => searchTabs.find((tab) => tab.id === activeTabId);
const getNewSearchTab = () => searchTabs.find((tab) => !tab.hasSearched && !tab.source);

const searchTerminalStatuses = new Set(["completed", "timeout", "auth_error", "error"]);
const searchWaitingNotes = [
  "Отправляем запрос поставщикам и начинаем собирать предложения.",
  "Уточняем, где деталь есть в наличии и когда ее смогут доставить.",
  "Запросы обрабатываются одновременно, поэтому первые предложения появятся сразу после получения.",
  "Некоторым поставщикам требуется немного больше времени. Мы уже добавляем полученные варианты в общий список.",
  "Сравниваем цены, наличие на складах и сроки доставки. Осталось совсем немного.",
];

const getSearchWaitingNote = (elapsedMs) => searchWaitingNotes[
  Math.min(Math.floor(elapsedMs / 5_000), searchWaitingNotes.length - 1)
];

const updateSearchProgress = (tab) => {
  if (!tab?.source) {
    return;
  }

  const pendingSuppliers = tab.enabledSuppliers.filter((supplier) => !searchTerminalStatuses.has(tab.supplierStatuses[supplier]));
  const searchingSuppliers = pendingSuppliers.filter((supplier) => tab.supplierStatuses[supplier] === "searching");
  const foundCount = tab.results.length;
  const elapsedMs = Date.now() - tab.searchStartedAt;
  let title;
  let description;

  if (searchingSuppliers.length < pendingSuppliers.length) {
    const nextSupplier = pendingSuppliers.find((supplier) => !searchingSuppliers.includes(supplier));
    title = `Подключаемся к ${supplierNames[nextSupplier] ?? nextSupplier}`;
    description = "Проверяем сессию и отправляем запрос поставщику.";
  } else if (!pendingSuppliers.length) {
    title = "Собираем итог поиска";
    description = foundCount
      ? `Получено позиций: ${foundCount}. Завершаем обработку ответов.`
      : "Все поставщики ответили. Завершаем обработку ответов.";
  } else if (foundCount) {
    title = `Найдено позиций: ${foundCount}`;
    description = `Идет поиск: ${pendingSuppliers.map((supplier) => supplierNames[supplier] ?? supplier).join(", ")}.`;
  } else {
    title = "Сверяем предложения поставщиков";
    description = `Получаем наличие и цены: ${pendingSuppliers.map((supplier) => supplierNames[supplier] ?? supplier).join(", ")}.`;
  }

  if (elapsedMs >= 15_000 && pendingSuppliers.length) {
    description = `Идет поиск: ${pendingSuppliers.map((supplier) => supplierNames[supplier] ?? supplier).join(", ")}. Это может занять немного больше времени.`;
  }

  tab.status = title;
  if (tab.id === activeTabId) {
    globalStatus.textContent = title;
    searchLoadingTitle.textContent = title;
    searchLoadingDescription.textContent = description;
    searchLoadingNote.textContent = getSearchWaitingNote(elapsedMs);
    searchLoadingCancel.hidden = elapsedMs < 15_000;
  }
};

const updateVisibleSearchProgress = () => {
  searchTabs.forEach(updateSearchProgress);
};

const startSearchProgressTimer = () => {
  if (searchProgressTimer === null) {
    searchProgressTimer = window.setInterval(updateVisibleSearchProgress, 1000);
  }
};

const stopSearchProgressTimerIfIdle = () => {
  if (searchProgressTimer !== null && !searchTabs.some((tab) => tab.source)) {
    window.clearInterval(searchProgressTimer);
    searchProgressTimer = null;
  }
};

const setSearchUiState = (isSearching) => {
  const hasSearched = Boolean(getActiveTab()?.hasSearched);
  submitButton.disabled = isSearching;
  articleInput.disabled = isSearching;
  supplierEnabledInputs.forEach((input) => {
    input.disabled = isSearching;
  });
  resultsPanel.classList.toggle("is-searching", isSearching);
  resultsPanel.setAttribute("aria-busy", String(isSearching));
  searchLoading.hidden = !isSearching;
  resultsEmpty.hidden = isSearching || hasSearched;
  resultsTable.hidden = isSearching || !hasSearched;
  resultCount.hidden = isSearching || !hasSearched;
};

const syncActiveTab = () => {
  const tab = getActiveTab();

  if (!tab) {
    return;
  }

  tab.article = articleInput.value;
  tab.enabledSuppliers = getEnabledSuppliers();
  tab.status = globalStatus.textContent;
  tab.results = results;
  tab.markupPercent = markupPercent;
};

const sessionPillStatus = (authorized) => (authorized ? "completed" : "idle");
const sessionPillText = (authorized) => (authorized ? "Подключен" : "Не подключен");

const updateSupplierNotice = (session) => {
  supplierSessionStates.set(session.supplier, Boolean(session.authorized));
  if (supplierSessionStates.size < supplierIds.length) {
    return;
  }

  const disconnected = supplierIds.filter((supplier) => !supplierSessionStates.get(supplier));
  supplierNotice.hidden = disconnected.length === 0;
  supplierNoticeSummary.textContent = disconnected.length === 1
    ? "Не подключен 1 поставщик"
    : `Не подключены поставщики: ${disconnected.length}`;
  supplierNoticeList.replaceChildren(...disconnected.map((supplier) => {
    const item = document.createElement("li");
    item.textContent = supplierNames[supplier] ?? supplier;
    return item;
  }));

  if (!disconnected.length) {
    supplierNotice.open = false;
  }
};

const formatDeliveryDate = (value, approximate = false, valueTo = null) => {
  if (!value) {
    return "Не указана";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return `${approximate ? "~" : ""}${value}`;
  }

  const formattedFrom = parsed.toLocaleDateString("ru-RU");
  const parsedTo = valueTo ? new Date(valueTo) : null;
  const formattedTo = parsedTo && !Number.isNaN(parsedTo.getTime()) ? ` - ${parsedTo.toLocaleDateString("ru-RU")}` : "";

  return `${approximate ? "~" : ""}${formattedFrom}${formattedTo}`;
};

const formatWarehouse = (value) => {
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

const escapeHtml = (value) => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");

const getSafeResultLink = (value) => {
  try {
    const url = new URL(String(value));
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : "";
  } catch {
    return "";
  }
};

const renderWarehouse = (result) => {
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

const resultCollator = new Intl.Collator("ru", { numeric: true, sensitivity: "base" });

const getMarkupPrice = (result) => {
  const price = Number(result.price);
  return Number.isFinite(price) && price > 0 ? price * (1 + markupPercent / 100) : null;
};

const formatPrice = (value) => {
  if (!Number.isFinite(value)) {
    return "Не указана";
  }

  const truncated = value < 0 ? Math.ceil(value * 100) / 100 : Math.trunc(value * 100) / 100;
  return `${truncated.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`;
};

const getSortValue = (result, key) => {
  if (key === "supplier") {
    return supplierNames[result.supplier] ?? result.supplier;
  }

  if (key === "deliveryDate") {
    const timestamp = result.deliveryDate ? new Date(result.deliveryDate).getTime() : Number.NaN;
    return Number.isNaN(timestamp) ? null : timestamp;
  }

  if (key === "markupPrice") {
    return getMarkupPrice(result);
  }

  return result[key];
};

const compareSortValues = (leftValue, rightValue) => {
  const leftMissing = leftValue === null || leftValue === undefined || leftValue === "";
  const rightMissing = rightValue === null || rightValue === undefined || rightValue === "";

  if (leftMissing || rightMissing) {
    return leftMissing === rightMissing ? 0 : leftMissing ? 1 : -1;
  }

  return typeof leftValue === "number" && typeof rightValue === "number"
    ? leftValue - rightValue
    : resultCollator.compare(String(leftValue), String(rightValue));
};

const compareResults = (left, right) => {
  const leftValue = getSortValue(left, sortState.key);
  const rightValue = getSortValue(right, sortState.key);
  let comparison = compareSortValues(leftValue, rightValue);

  if (comparison === 0 && sortState.key === "deliveryDate") {
    comparison = compareSortValues(
      getSortValue({ deliveryDate: left.deliveryDateTo ?? left.deliveryDate }, "deliveryDate"),
      getSortValue({ deliveryDate: right.deliveryDateTo ?? right.deliveryDate }, "deliveryDate"),
    );
  }

  return sortState.direction === "ascending" ? comparison : -comparison;
};

const updateSortHeaders = () => {
  sortButtons.forEach((button) => {
    const isActive = button.dataset.sortKey === sortState.key;
    const direction = isActive ? sortState.direction : "none";
    button.classList.toggle("is-active", isActive);
    button.closest("th").setAttribute("aria-sort", direction);
    button.title = isActive
      ? `Сортировка ${direction === "ascending" ? "по возрастанию" : "по убыванию"}. Нажмите, чтобы изменить`
      : "Сортировать по столбцу";
  });
};

const updateResultCount = (items) => {
  const supplierCounts = items.reduce((counts, result) => {
    counts[result.supplier] = (counts[result.supplier] ?? 0) + 1;
    return counts;
  }, {});
  const tab = getActiveTab();
  const breakdown = tab
    ? buildSupplierResultTooltip(tab.enabledSuppliers, items, tab.supplierSearchDurations, supplierNames)
    : Object.entries(supplierCounts)
      .map(([supplier, count]) => `${supplierNames[supplier] ?? supplier}: ${count} позиций`)
      .join("\n");

  resultCount.textContent = `${items.length} позиций`;
  resultCount.dataset.tooltip = breakdown;
  resultCount.setAttribute("aria-label", breakdown ? `По поставщикам:\n${breakdown}` : "Нет результатов");
};

const getVisibleTableColumns = () => tableColumnIds.filter((column) => visibleTableColumns.has(column));

const saveTableColumns = () => {
  try {
    localStorage.setItem(tableColumnsStorageKey, JSON.stringify(getVisibleTableColumns()));
  } catch {
    // Column preferences are optional; unavailable storage must not affect search.
  }
};

const applyTableColumns = () => {
  const visibleColumns = getVisibleTableColumns();
  tableColumnsReset.hidden = visibleColumns.length === tableColumnIds.length;
  document.querySelectorAll("[data-column]").forEach((element) => {
    element.hidden = !visibleTableColumns.has(element.dataset.column);
  });
  resultsBody.querySelectorAll(".results-table__empty td").forEach((cell) => {
    cell.colSpan = visibleColumns.length;
  });
  filterColumnButtons.forEach((button) => {
    button.hidden = !visibleTableColumns.has(button.dataset.filterColumn);
  });
  if (activeFilterColumn && !visibleTableColumns.has(activeFilterColumn)) {
    activeFilterColumn = "";
  }
  tableColumnIds.filter((column) => !visibleTableColumns.has(column)).forEach((column) => {
    selectedFilterValuesByColumn.delete(column);
    filterRangesByColumn.delete(column);
  });
};

const restoreTableColumns = () => {
  try {
    const savedColumns = JSON.parse(localStorage.getItem(tableColumnsStorageKey));
    if (!Array.isArray(savedColumns)) {
      return;
    }
    visibleTableColumns = new Set(savedColumns.filter((column) => tableColumnIds.includes(column)));
  } catch {
    localStorage.removeItem(tableColumnsStorageKey);
  }
};

const saveSearchState = () => {
  try {
    syncActiveTab();
    localStorage.setItem(
      searchStateStorageKey,
      JSON.stringify({
        activeTabId,
        tabs: searchTabs.map((tab) => ({
          id: tab.id,
          article: tab.article,
          enabledSuppliers: tab.enabledSuppliers,
          status: tab.status,
          results: tab.results,
          hasSearched: tab.hasSearched,
          markupPercent: tab.markupPercent,
        })),
      }),
    );
  } catch {
    // Search state is a convenience cache; the app should keep working if storage is unavailable.
  }
};

const restoreSearchState = () => {
  try {
    const rawState = localStorage.getItem(searchStateStorageKey);

    if (!rawState) {
      return;
    }

    const state = JSON.parse(rawState);

    if (Array.isArray(state.tabs) && state.tabs.length) {
      searchTabs = state.tabs.map((tab) => createSearchTab(tab));
      activeTabId = searchTabs.some((tab) => tab.id === state.activeTabId) ? state.activeTabId : searchTabs[0].id;
    } else {
      searchTabs = [
        createSearchTab({
          article: state.article,
          enabledSuppliers: state.enabledSuppliers,
          status: state.status,
          results: state.results,
          hasSearched: state.hasSearched,
        }),
      ];
      activeTabId = searchTabs[0].id;
    }
  } catch {
    localStorage.removeItem(searchStateStorageKey);
  }
};

const renderTabs = () => {
  newTabButton.hidden = Boolean(getNewSearchTab());
  searchTabsList.innerHTML = searchTabs
    .map((tab, index) => {
      const statusClass = tab.source ? "is-searching" : tab.results.length ? "is-completed" : "";
      const title = tab.article || `Новый поиск ${index + 1}`;

      return `
       <button type="button" class="search-tab ${tab.id === activeTabId ? "active" : ""}" data-tab-id="${escapeHtml(tab.id)}" role="tab" aria-selected="${tab.id === activeTabId}">
          <span class="search-tab__status ${statusClass}"></span>${escapeHtml(title)}
           <span class="search-tab__close" data-close-tab-id="${escapeHtml(tab.id)}" aria-label="Закрыть вкладку">×</span>
        </button>
      `;
    })
    .join("");
};

const activateTab = (tabId) => {
  const tab = searchTabs.find((item) => item.id === tabId);

  if (!tab || tab.id === activeTabId) {
    return;
  }

  syncActiveTab();
  activeTabId = tab.id;
  results = tab.results;
  markupPercent = tab.markupPercent;
  articleInput.value = tab.article;
  markupPercentInput.value = String(markupPercent);
  globalStatus.textContent = tab.status;
  supplierEnabledInputs.forEach((input) => {
    input.checked = tab.enabledSuppliers.includes(input.value);
  });
  setSearchUiState(Boolean(tab.source));
  updateSearchProgress(tab);
  renderTabs();
  renderResults();
  saveSearchState();
};

const closeTab = (tabId) => {
  const tabIndex = searchTabs.findIndex((tab) => tab.id === tabId);

  if (tabIndex === -1) {
    return;
  }

  syncActiveTab();
  const [tab] = searchTabs.splice(tabIndex, 1);
  if (tab.source) {
    tab.source.close();
    tab.source = null;
    stopSearchProgressTimerIfIdle();
  }

  if (!searchTabs.length) {
    const newTab = createSearchTab();
    searchTabs.push(newTab);
    activeTabId = null;
    renderTabs();
    activateTab(newTab.id);
    articleInput.focus();
    return;
  }

  if (tab.id === activeTabId) {
    const nextTab = searchTabs[Math.min(tabIndex, searchTabs.length - 1)];
    activeTabId = null;
    renderTabs();
    activateTab(nextTab.id);
    return;
  }

  renderTabs();
  saveSearchState();
};

const renderResults = () => {
  updateSortHeaders();

  if (activeFilterColumn && !visibleTableColumns.has(activeFilterColumn)) {
    activeFilterColumn = "";
  }
  tableColumnIds.filter((column) => !visibleTableColumns.has(column)).forEach((column) => {
    selectedFilterValuesByColumn.delete(column);
    filterRangesByColumn.delete(column);
  });

  const filtered = getFilteredResults();
  if (!results.length || !filtered.length) {
    resultsBody.innerHTML = `
      <tr class="results-table__empty">
         <td colspan="8">${results.length ? "Нет позиций с выбранным значением фильтра." : "По вашему запросу ничего не найдено."}</td>
      </tr>
    `;
    applyTableColumns();
    updateResultCount(filtered);
    renderFilterValues();
    return;
  }

  const sorted = [...filtered].sort(compareResults);
  const isSearching = Boolean(getActiveTab()?.source);
  resultsBody.innerHTML = sorted
    .map((result) => {
      const supplierName = supplierNames[result.supplier] ?? result.supplier;
      const link = getSafeResultLink(result.link);
      const deliveryDate = result.supplier === "mladov" && !result.deliveryDate
        ? "-"
        : formatDeliveryDate(result.deliveryDate, result.deliveryDateApproximate, result.deliveryDateTo);

      return `
         <tr class="results-table__row" data-link="${escapeHtml(link)}" tabindex="${isSearching ? "-1" : "0"}" aria-disabled="${isSearching}" aria-label="Открыть ${escapeHtml(result.title)}">
           <td data-column="supplier">${escapeHtml(supplierName)}</td>
           <td data-column="brand">${escapeHtml(result.brand)}</td>
           <td data-column="article">${escapeHtml(result.article)}</td>
            <td data-column="title">${escapeHtml(result.title)}</td>
            <td data-column="warehouse">${renderWarehouse(result)}</td>
            <td data-column="price">${escapeHtml(formatPrice(result.price))}</td>
            <td data-column="markupPrice">${escapeHtml(formatPrice(getMarkupPrice(result)))}</td>
           <td data-column="deliveryDate">${escapeHtml(deliveryDate)}</td>
         </tr>
      `;
    })
    .join("");
  applyTableColumns();
  updateResultCount(sorted);
  renderFilterValues();
};

const setMarkupPercent = (value) => {
  markupPercent = normalizeMarkupPercent(value);
  markupPercentInput.value = String(markupPercent);
  const tab = getActiveTab();
  if (tab) {
    tab.markupPercent = markupPercent;
  }
  renderResults();
  saveSearchState();
};

const resetSearchState = () => {
  results = [];
  activeFilterColumn = "";
  selectedFilterValuesByColumn.clear();
  filterRangesByColumn.clear();
  const tab = getActiveTab();
  if (tab) {
    tab.results = results;
  }
  renderResults();
  saveSearchState();
};

const closeActiveSource = () => {
  const tab = getActiveTab();

  if (tab?.source) {
    tab.source.close();
    tab.source = null;
  }

  if (tab) {
    tab.source = null;
  }
  stopSearchProgressTimerIfIdle();
};

const openSettings = () => {
  settingsDrawer.hidden = false;
};

const closeSettings = () => {
  settingsDrawer.hidden = true;
};

const updateRosskoSessionCard = (session, enableSearch = false) => {
  updateSupplierNotice(session);
  updateSupplierSearchToggle("rossko", session.authorized);
  rosskoSessionPill.dataset.status = sessionPillStatus(session.authorized);
  rosskoSessionPill.textContent = sessionPillText(session.authorized);
  rosskoAuthForm.dataset.authorized = String(session.authorized);
  rosskoConnectButton.hidden = session.authorized;
  rosskoLogoutButton.hidden = !session.authorized;
  rosskoAuthFeedback.textContent = "";

  if (enableSearch && session.authorized) {
    setSupplierEnabled("rossko", true);
  }
};

const updateArmtekSessionCard = (session, enableSearch = false) => {
  updateSupplierNotice(session);
  updateSupplierSearchToggle("armtek", session.authorized);
  armtekSessionPill.dataset.status = sessionPillStatus(session.authorized);
  armtekSessionPill.textContent = sessionPillText(session.authorized);
  armtekAuthForm.dataset.authorized = String(session.authorized);
  armtekConnectButton.hidden = session.authorized;
  armtekLogoutButton.hidden = !session.authorized;
  armtekAuthFeedback.textContent = "";

  if (enableSearch && session.authorized) {
    setSupplierEnabled("armtek", true);
  }
};

const updatePartKomSessionCard = (session) => {
  updateSupplierNotice(session);
  updateSupplierSearchToggle("part-kom", session.authorized);
  partKomSessionPill.dataset.status = sessionPillStatus(session.authorized);
  partKomSessionPill.textContent = sessionPillText(session.authorized);
  partKomAuthForm.dataset.authorized = String(session.authorized);
  partKomConnectButton.hidden = session.authorized;
  partKomLogoutButton.hidden = !session.authorized;
  partKomAuthFeedback.textContent = "";
};

const updateStpartsSessionCard = (session) => {
  updateSupplierNotice(session);
  updateSupplierSearchToggle("stparts", session.authorized);
  stpartsSessionPill.dataset.status = sessionPillStatus(session.authorized);
  stpartsSessionPill.textContent = sessionPillText(session.authorized);
  stpartsAuthForm.dataset.authorized = String(session.authorized);
  stpartsConnectButton.hidden = session.authorized;
  stpartsLogoutButton.hidden = !session.authorized;
  stpartsAuthFeedback.textContent = "";
};

const updateMotorDetalSessionCard = (session) => {
  updateSupplierNotice(session);
  updateSupplierSearchToggle("motordetal", session.authorized);
  motorDetalSessionPill.dataset.status = sessionPillStatus(session.authorized);
  motorDetalSessionPill.textContent = sessionPillText(session.authorized);
  motorDetalAuthForm.dataset.authorized = String(session.authorized);
  motorDetalConnectButton.hidden = session.authorized;
  motorDetalLogoutButton.hidden = !session.authorized;
  motorDetalAuthFeedback.textContent = "";
};

const updateMladovSessionCard = (session) => {
  updateSupplierNotice(session);
  updateSupplierSearchToggle("mladov", session.authorized);
  mladovSessionPill.dataset.status = sessionPillStatus(session.authorized);
  mladovSessionPill.textContent = sessionPillText(session.authorized);
  mladovAuthForm.dataset.authorized = String(session.authorized);
  mladovConnectButton.hidden = session.authorized;
  mladovLogoutButton.hidden = !session.authorized;
  mladovAuthFeedback.textContent = "";
};

const sessionCardUpdaters = {
  rossko: updateRosskoSessionCard,
  armtek: updateArmtekSessionCard,
  "part-kom": updatePartKomSessionCard,
  stparts: updateStpartsSessionCard,
  motordetal: updateMotorDetalSessionCard,
  mladov: updateMladovSessionCard,
};

const updateSessionCards = (sessions) => {
  if (Array.isArray(sessions)) {
    sessions.forEach((session) => sessionCardUpdaters[session?.supplier]?.(session));
  }
};

const loadSessions = async () => {
  const response = await fetch("/api/suppliers/sessions");
  const payload = await response.json();
  const rosskoSession = payload.sessions.find((session) => session.supplier === "rossko");
  const armtekSession = payload.sessions.find((session) => session.supplier === "armtek");
  const partKomSession = payload.sessions.find((session) => session.supplier === "part-kom");
  const stpartsSession = payload.sessions.find((session) => session.supplier === "stparts");
  const motorDetalSession = payload.sessions.find((session) => session.supplier === "motordetal");
  const mladovSession = payload.sessions.find((session) => session.supplier === "mladov");

  if (rosskoSession) {
    updateRosskoSessionCard(rosskoSession, true);
  }

  if (armtekSession) {
    updateArmtekSessionCard(armtekSession, true);
  }

  if (partKomSession) {
    updatePartKomSessionCard(partKomSession);
  }

  if (stpartsSession) {
    updateStpartsSessionCard(stpartsSession);
  }

  if (motorDetalSession) {
    updateMotorDetalSessionCard(motorDetalSession);
  }

  if (mladovSession) {
    updateMladovSessionCard(mladovSession);
  }
};

const postJson = async (url, body) => {
  const response = await fetch(url, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.message ?? "Request failed");
  }

  return payload;
};

const wait = (delayMs) => new Promise((resolve) => window.setTimeout(resolve, delayMs));

const shouldCheckSupplierSessions = () => {
  try {
    const lastSearchStartedAt = Number(localStorage.getItem(lastSearchStorageKey));
    return !Number.isFinite(lastSearchStartedAt) || lastSearchStartedAt <= 0 || Date.now() - lastSearchStartedAt >= supplierCheckIntervalMs;
  } catch {
    return true;
  }
};

const rememberSupplierSessionsChecked = () => {
  try {
    localStorage.setItem(lastSearchStorageKey, String(Date.now()));
  } catch {
    // This timestamp only avoids repeated checks; validation remains safe without storage.
  }
};

const showSupplierCheck = (suppliers) => {
  supplierCheck.dataset.state = "checking";
  supplierCheckTitle.textContent = "Выполняется проверка сессий, пожалуйста подождите.";
  supplierCheckMessage.textContent = "";
  supplierCheckList.replaceChildren();
  supplierCheckOk.hidden = true;
  supplierCheck.hidden = false;
  supplierCheck.focus();
};

const showSupplierCheckError = (expired, unavailable) => {
  supplierCheck.dataset.state = "error";
  supplierCheckTitle.textContent = expired.length ? "Сессия поставщика истекла" : "Не удалось проверить поставщиков";
  supplierCheckMessage.textContent = expired.length
    ? "Необходимо повторно провести авторизацию в настройках."
    : "Проверка временно недоступна. Попробуйте выполнить поиск еще раз.";
  const failures = [
    ...expired.map((supplier) => `${supplierNames[supplier] ?? supplier}: сессия истекла`),
    ...unavailable.map((supplier) => `${supplierNames[supplier] ?? supplier}: проверка недоступна`),
  ];
  supplierCheckList.replaceChildren(...failures.map((message) => {
    const item = document.createElement("li");
    item.textContent = message;
    return item;
  }));
  supplierCheckOk.hidden = false;
  supplierCheckOk.focus();
};

const showIncompleteSearchWarning = (tab) => {
  const warnings = buildIncompleteSearchWarnings(tab.enabledSuppliers, tab.supplierStatuses, supplierNames);
  if (!warnings.length) {
    return;
  }

  supplierCheck.dataset.state = "error";
  supplierCheckTitle.textContent = "Поиск завершен не полностью";
  supplierCheckMessage.textContent = "Не все товары могли попасть в список. Попробуйте запустить поиск заново.";
  supplierCheckList.replaceChildren(...warnings.map((message) => {
    const item = document.createElement("li");
    item.textContent = message;
    return item;
  }));
  supplierCheckOk.hidden = false;
  supplierCheck.hidden = false;
  supplierCheck.focus();
  supplierCheckOk.focus();
};

const checkSupplierSessions = async (article, suppliers) => {
  showSupplierCheck(suppliers);

  try {
    const payload = await postJson("/api/suppliers/sessions/validate", { article, suppliers });
    updateSessionCards(payload.sessions);
    const expired = payload.results.filter((result) => result.status === "expired").map((result) => result.supplier);
    const unavailable = payload.results.filter((result) => result.status === "error").map((result) => result.supplier);

    if (expired.length || unavailable.length) {
      showSupplierCheckError(expired, unavailable);
      return false;
    }

    supplierCheck.dataset.state = "success";
    supplierCheckTitle.textContent = "Все поставщики успешно подключены";
    supplierCheckMessage.textContent = "Проверка завершена. Поиск начнется автоматически.";
    supplierCheckList.replaceChildren();
    await wait(supplierCheckSuccessDelayMs);
    supplierCheck.hidden = true;
    return true;
  } catch {
    showSupplierCheckError([], suppliers);
    return false;
  }
};

const handleAuthorizeResult = (session, supplier, feedbackElement, rejectedMessage, updateSessionCard) => {
  updateSessionCard(session);

  if (session.authorized) {
    feedbackElement.textContent = "";
    setSupplierEnabled(supplier, true);
    return;
  }

  feedbackElement.textContent = session.details ?? rejectedMessage;
};

const showAuthorizeError = (feedbackElement, error) => {
  feedbackElement.textContent = error.message;
};

const showAuthFeedback = (feedbackElement, message = "") => {
  feedbackElement.textContent = message;
};

const setAuthCardLoading = (form, isLoading) => {
  const card = form.closest(".auth-card");

  if (!card) {
    return;
  }

  let loadingElement = card.querySelector(".auth-card__loading");

  if (!loadingElement) {
    loadingElement = document.createElement("div");
    loadingElement.className = "auth-card__loading";
    loadingElement.hidden = true;
    loadingElement.innerHTML = '<div class="auth-card__loading-content"><span class="auth-card__loading-spinner" aria-hidden="true"></span><div><strong>Подключаем</strong></div></div>';
    card.append(loadingElement);
  }

  card.toggleAttribute("data-loading", isLoading);
  loadingElement.hidden = !isLoading;
  form.querySelectorAll("input, button").forEach((element) => {
    element.disabled = isLoading;
  });
};

const clearAuthInputs = (...inputs) => {
  inputs.forEach((input) => {
    input.value = "";
  });
};

const openSearchStream = (url) => {
  const controller = new AbortController();
  const stream = {
    closed: false,
    onmessage: null,
    onerror: null,
    close() {
      this.closed = true;
      controller.abort();
    },
  };

  queueMicrotask(async () => {
    try {
      const response = await fetch(url, {
        headers: { Accept: "text/event-stream" },
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error(`Search stream returned HTTP ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (!stream.closed) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });

        let eventEnd = buffer.indexOf("\n\n");
        while (eventEnd !== -1) {
          const event = buffer.slice(0, eventEnd);
          buffer = buffer.slice(eventEnd + 2);
          const data = event
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");

          if (data) {
            stream.onmessage?.({ data });
          }

          eventEnd = buffer.indexOf("\n\n");
        }

        if (done) {
          break;
        }
      }

      if (!stream.closed) {
        stream.onerror?.(new Error("Search stream closed before completion"));
      }
    } catch (error) {
      if (!stream.closed) {
        stream.onerror?.(error);
      }
    }
  });

  return stream;
};

settingsToggle.addEventListener("click", openSettings);
settingsClose.addEventListener("click", closeSettings);
settingsBackdrop.addEventListener("click", closeSettings);
passwordFields.forEach((passwordField) => {
  const input = passwordField.querySelector("input");
  const toggle = passwordField.querySelector(".password-toggle");

  toggle.addEventListener("click", () => {
    const isHidden = input.type === "password";
    input.type = isHidden ? "text" : "password";
    toggle.setAttribute("aria-label", isHidden ? "Скрыть пароль" : "Показать пароль");
  });

  passwordField.addEventListener("focusout", (event) => {
    if (!passwordField.contains(event.relatedTarget)) {
      hidePassword(passwordField);
    }
  });
});
document.addEventListener("click", (event) => {
  if (suppliersDropdown.open && !suppliersDropdown.contains(event.target)) {
    suppliersDropdown.open = false;
  }
  if (filtersDropdown.open && !filtersDropdown.contains(event.target)) {
    filtersDropdown.open = false;
  }
});

const selectFilterColumn = (column) => {
  if (activeFilterColumn === column) {
    return;
  }
  activeFilterColumn = column;
  renderFilterValues();
};

filterColumns.addEventListener("mouseover", (event) => {
  const button = event.target.closest("[data-filter-column]");
  if (button) {
    selectFilterColumn(button.dataset.filterColumn);
  }
});

filterColumns.addEventListener("focusin", (event) => {
  const button = event.target.closest("[data-filter-column]");
  if (button) {
    selectFilterColumn(button.dataset.filterColumn);
  }
});

filterColumns.addEventListener("click", (event) => {
  const button = event.target.closest("[data-filter-column]");
  if (button) {
    selectFilterColumn(button.dataset.filterColumn);
  }
});

filterValues.addEventListener("change", (event) => {
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) {
    return;
  }

  if (input.dataset.filterRange) {
    filterRangesByColumn.set(activeFilterColumn, {
      ...getFilterRange(activeFilterColumn),
      [input.dataset.filterRange]: input.value,
    });
    renderResults();
    return;
  }

  if (input.type !== "checkbox") {
    return;
  }

  if (input.checked) {
    getSelectedFilterValues(activeFilterColumn).add(input.value);
  } else {
    getSelectedFilterValues(activeFilterColumn).delete(input.value);
  }
  selectedFilterValuesByColumn.set(activeFilterColumn, getSelectedFilterValues(activeFilterColumn));
  renderResults();
});

filtersReset.addEventListener("click", () => {
  selectedFilterValuesByColumn.clear();
  filterRangesByColumn.clear();
  renderResults();
});

searchTabsList.addEventListener("click", (event) => {
  const closeButton = event.target.closest("[data-close-tab-id]");
  if (closeButton) {
    event.preventDefault();
    event.stopPropagation();
    closeTab(closeButton.dataset.closeTabId);
    return;
  }

  const tab = event.target.closest("[data-tab-id]");

  if (tab) {
    activateTab(tab.dataset.tabId);
  }
});

newTabButton.addEventListener("click", () => {
  syncActiveTab();

  const existingNewTab = getNewSearchTab();
  if (existingNewTab) {
    if (existingNewTab.id !== activeTabId) {
      activeTabId = null;
      activateTab(existingNewTab.id);
    }
    articleInput.focus();
    return;
  }

  const tab = createSearchTab();
  searchTabs.push(tab);
  activeTabId = null;
  renderTabs();
  activateTab(tab.id);
  articleInput.focus();
});

articleInput.addEventListener("input", saveSearchState);
supplierEnabledInputs.forEach((input) => input.addEventListener("change", saveSearchState));
tableColumnInputs.forEach((input) => {
  input.addEventListener("change", () => {
    visibleTableColumns = new Set(tableColumnInputs.filter((candidate) => candidate.checked).map((candidate) => candidate.value));
    saveTableColumns();
    renderResults();
  });
});
tableColumnsReset.addEventListener("click", () => {
  tableColumnInputs.forEach((input) => {
    input.checked = true;
  });
  visibleTableColumns = new Set(tableColumnIds);
  saveTableColumns();
  renderResults();
});

sortButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const key = button.dataset.sortKey;
    sortState = {
      key,
      direction: sortState.key === key && sortState.direction === "ascending" ? "descending" : "ascending",
    };
    renderResults();
  });
});

resultsBody.addEventListener("click", (event) => {
  if (getActiveTab()?.source) {
    return;
  }

  const row = event.target.closest(".results-table__row");

  if (row?.dataset.link) {
    window.open(row.dataset.link, "_blank", "noreferrer");
  }
});

resultsBody.addEventListener("keydown", (event) => {
  if (getActiveTab()?.source) {
    return;
  }

  if (event.key !== "Enter" && event.key !== " ") {
    return;
  }

  const row = event.target.closest(".results-table__row");

  if (row?.dataset.link) {
    event.preventDefault();
    window.open(row.dataset.link, "_blank", "noreferrer");
  }
});

rosskoAuthForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setAuthCardLoading(rosskoAuthForm, true);

  try {
    const payload = await postJson("/api/suppliers/rossko/authorize", {
      login: rosskoLoginInput.value.trim(),
      password: rosskoPasswordInput.value,
    });
    handleAuthorizeResult(payload.session, "rossko", rosskoAuthFeedback, "Rossko отклонил авторизацию", updateRosskoSessionCard);
  } catch (error) {
    showAuthorizeError(rosskoAuthFeedback, error);
  } finally {
    setAuthCardLoading(rosskoAuthForm, false);
  }
});

rosskoLogoutButton.addEventListener("click", async () => {
  try {
    const payload = await postJson("/api/suppliers/rossko/logout");
    updateRosskoSessionCard(payload.session);
    clearAuthInputs(rosskoLoginInput, rosskoPasswordInput);
  } catch (error) {
    showAuthFeedback(rosskoAuthFeedback, error.message);
  }
});

armtekAuthForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setAuthCardLoading(armtekAuthForm, true);

  try {
    const payload = await postJson("/api/suppliers/armtek/authorize", {
      login: armtekLoginInput.value.trim(),
      password: armtekPasswordInput.value.trim(),
    });
    handleAuthorizeResult(payload.session, "armtek", armtekAuthFeedback, "Armtek отклонил авторизацию", updateArmtekSessionCard);
  } catch (error) {
    showAuthorizeError(armtekAuthFeedback, error);
  } finally {
    setAuthCardLoading(armtekAuthForm, false);
  }
});

armtekLogoutButton.addEventListener("click", async () => {
  try {
    const payload = await postJson("/api/suppliers/armtek/logout");
    updateArmtekSessionCard(payload.session);
    clearAuthInputs(armtekLoginInput, armtekPasswordInput);
  } catch (error) {
    showAuthFeedback(armtekAuthFeedback, error.message);
  }
});

partKomAuthForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setAuthCardLoading(partKomAuthForm, true);

  try {
    const payload = await postJson("/api/suppliers/part-kom/authorize", {
      login: partKomLoginInput.value.trim(),
      password: partKomPasswordInput.value.trim(),
    });
    handleAuthorizeResult(payload.session, "part-kom", partKomAuthFeedback, "Part-Kom отклонил авторизацию", updatePartKomSessionCard);
  } catch (error) {
    showAuthorizeError(partKomAuthFeedback, error);
  } finally {
    setAuthCardLoading(partKomAuthForm, false);
  }
});

partKomLogoutButton.addEventListener("click", async () => {
  try {
    const payload = await postJson("/api/suppliers/part-kom/logout");
    updatePartKomSessionCard(payload.session);
    clearAuthInputs(partKomLoginInput, partKomPasswordInput);
  } catch (error) {
    showAuthFeedback(partKomAuthFeedback, error.message);
  }
});

stpartsAuthForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setAuthCardLoading(stpartsAuthForm, true);

  try {
    const payload = await postJson("/api/suppliers/stparts/authorize", {
      login: stpartsLoginInput.value.trim(),
      password: stpartsPasswordInput.value,
    });
    handleAuthorizeResult(payload.session, "stparts", stpartsAuthFeedback, "STParts отклонил авторизацию", updateStpartsSessionCard);
  } catch (error) {
    showAuthorizeError(stpartsAuthFeedback, error);
  } finally {
    setAuthCardLoading(stpartsAuthForm, false);
  }
});

stpartsLogoutButton.addEventListener("click", async () => {
  try {
    const payload = await postJson("/api/suppliers/stparts/logout");
    updateStpartsSessionCard(payload.session);
    clearAuthInputs(stpartsLoginInput, stpartsPasswordInput);
  } catch (error) {
    showAuthFeedback(stpartsAuthFeedback, error.message);
  }
});

motorDetalAuthForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setAuthCardLoading(motorDetalAuthForm, true);

  try {
    const payload = await postJson("/api/suppliers/motordetal/authorize", {
      login: motorDetalLoginInput.value.trim(),
      password: motorDetalPasswordInput.value.trim(),
    });
    handleAuthorizeResult(payload.session, "motordetal", motorDetalAuthFeedback, "MotorDetal отклонил авторизацию", updateMotorDetalSessionCard);
  } catch (error) {
    showAuthorizeError(motorDetalAuthFeedback, error);
  } finally {
    setAuthCardLoading(motorDetalAuthForm, false);
  }
});

motorDetalLogoutButton.addEventListener("click", async () => {
  try {
    const payload = await postJson("/api/suppliers/motordetal/logout");
    updateMotorDetalSessionCard(payload.session);
    clearAuthInputs(motorDetalLoginInput, motorDetalPasswordInput);
  } catch (error) {
    showAuthFeedback(motorDetalAuthFeedback, error.message);
  }
});

mladovAuthForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setAuthCardLoading(mladovAuthForm, true);
  try {
    const payload = await postJson("/api/suppliers/mladov/authorize", {
      login: mladovLoginInput.value.trim(),
      password: mladovPasswordInput.value.trim(),
    });
    handleAuthorizeResult(payload.session, "mladov", mladovAuthFeedback, "Механик Ладов отклонил авторизацию", updateMladovSessionCard);
  } catch (error) {
    showAuthorizeError(mladovAuthFeedback, error);
  } finally {
    setAuthCardLoading(mladovAuthForm, false);
  }
});

mladovLogoutButton.addEventListener("click", async () => {
  try {
    const payload = await postJson("/api/suppliers/mladov/logout");
    updateMladovSessionCard(payload.session);
    clearAuthInputs(mladovLoginInput, mladovPasswordInput);
  } catch (error) {
    showAuthFeedback(mladovAuthFeedback, error.message);
  }
});

supplierCheckOk.addEventListener("click", () => {
  supplierCheck.hidden = true;
  submitButton.focus();
});

const startSearch = (article, enabledSuppliers) => {
  closeActiveSource();
  resetSearchState();

  const tab = getActiveTab();
  tab.article = article;
  tab.enabledSuppliers = enabledSuppliers;
  tab.hasSearched = true;
  tab.status = `Ищем по артикулу ${article}`;
  tab.supplierStatuses = {};
  tab.supplierSearchStartedAt = {};
  tab.supplierSearchDurations = {};
  tab.searchStartedAt = Date.now();
  searchLoadingCancel.hidden = true;

  globalStatus.textContent = `Подготавливаем поиск по артикулу ${article}`;

  const searchParams = new URLSearchParams({ article });
  searchParams.set("stream", "once");
  enabledSuppliers.forEach((supplier) => searchParams.append("supplier", supplier));

  const source = openSearchStream(`/api/search?${searchParams.toString()}`);
  tab.source = source;
  updateSearchProgress(tab);
  startSearchProgressTimer();
  setSearchUiState(true);
  renderTabs();
  saveSearchState();

  source.onmessage = (messageEvent) => {
    if (tab.source !== source) {
      return;
    }

    const payload = JSON.parse(messageEvent.data);

    if (payload.type === "supplier_status") {
      tab.supplierStatuses[payload.supplier] = payload.status;
      if (payload.status === "searching") {
        tab.supplierSearchStartedAt[payload.supplier] = Date.now();
      } else if (["completed", "timeout", "auth_error", "error"].includes(payload.status)) {
        const startedAt = tab.supplierSearchStartedAt[payload.supplier];
        if (Number.isFinite(startedAt)) {
          tab.supplierSearchDurations[payload.supplier] = Math.max(0, Date.now() - startedAt);
        }
      }
      updateSearchProgress(tab);
      renderTabs();
      saveSearchState();
      return;
    }

    if (payload.type === "result") {
      tab.results.push(payload.result);
      updateSearchProgress(tab);
      if (tab.id === activeTabId) {
        results = tab.results;
        renderResults();
      }
      renderTabs();
      saveSearchState();
      return;
    }

    if (payload.type === "search_completed") {
      tab.status = "";
      source.close();
      tab.source = null;
      stopSearchProgressTimerIfIdle();
      if (tab.id === activeTabId) {
        globalStatus.textContent = tab.status;
        setSearchUiState(false);
        renderResults();
      }
      showIncompleteSearchWarning(tab);
      renderTabs();
      saveSearchState();
      return;
    }

    if (payload.type === "fatal_error") {
      tab.status = `Ошибка: ${payload.message}`;
      source.close();
      tab.source = null;
      stopSearchProgressTimerIfIdle();
      if (tab.id === activeTabId) {
        globalStatus.textContent = tab.status;
        setSearchUiState(false);
        renderResults();
      }
      renderTabs();
      saveSearchState();
    }
  };

  source.onerror = () => {
    if (tab.source !== source) {
      return;
    }

    tab.status = "Соединение с потоком поиска было закрыто";
    source.close();
    tab.source = null;
    stopSearchProgressTimerIfIdle();
    if (tab.id === activeTabId) {
      globalStatus.textContent = tab.status;
      setSearchUiState(false);
      renderResults();
    }
    renderTabs();
    saveSearchState();
  };
};

cancelSearchButton.addEventListener("click", () => {
  const tab = getActiveTab();

  if (!tab?.source) {
    return;
  }

  tab.source.close();
  tab.source = null;
  tab.status = "";
  globalStatus.textContent = "";
  searchLoadingCancel.hidden = true;
  stopSearchProgressTimerIfIdle();
  setSearchUiState(false);
  renderResults();
  renderTabs();
  saveSearchState();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (supplierCheckInProgress) {
    return;
  }

  const article = articleInput.value.trim();
  if (!article) {
    return;
  }

  const enabledSuppliers = getEnabledSuppliers();
  if (!enabledSuppliers.length) {
    globalStatus.textContent = "Выберите хотя бы одного поставщика";
    saveSearchState();
    return;
  }

  if (shouldCheckSupplierSessions()) {
    supplierCheckInProgress = true;
    const canSearch = await checkSupplierSessions(article, enabledSuppliers);
    supplierCheckInProgress = false;
    if (!canSearch) {
      return;
    }
    rememberSupplierSessionsChecked();
  }

  startSearch(article, enabledSuppliers);
});

restoreSearchState();
restoreTableColumns();
tableColumnInputs.forEach((input) => {
  input.checked = visibleTableColumns.has(input.value);
});
if (!searchTabs.length) {
  const tab = createSearchTab();
  searchTabs.push(tab);
  activeTabId = tab.id;
}
const restoredTab = getActiveTab();
if (restoredTab) {
  results = restoredTab.results;
  markupPercent = restoredTab.markupPercent;
  articleInput.value = restoredTab.article;
  markupPercentInput.value = String(markupPercent);
  globalStatus.textContent = restoredTab.status;
  supplierEnabledInputs.forEach((input) => {
    input.checked = restoredTab.enabledSuppliers.includes(input.value);
  });
}
markupPercentInput.addEventListener("change", () => setMarkupPercent(markupPercentInput.value));

tableSearchInput.addEventListener("input", () => {
  tableSearchTerm = tableSearchInput.value;
  renderResults();
});
setSearchUiState(false);
renderTabs();
renderResults();
loadSessions().catch(() => undefined);
