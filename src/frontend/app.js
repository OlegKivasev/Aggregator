import { buildIncompleteSearchWarnings, buildSupplierResultTooltip, formatDeliveryDate } from "./supplier-search-summary.js";
import {
  compareDeliveryDates,
  escapeHtml,
  formatArticle,
  formatBrand,
  formatPrice,
  formatQuantity,
  formatWarehouse,
  getSafeResultLink,
  renderWarehouse,
} from "./result-formatting.js";
import { openSearchStream } from "./search-stream.js";
import {
  isStpartsWarehouseVisible,
  normalizeStpartsWarehouseColors,
} from "./stparts-warehouse-settings.js";
import { isPartKomReturnableVisible } from "./partkom-return-settings.js";
import { isForumAutoReturnableVisible } from "./forum-auto-return-settings.js";
import { isArmtekReturnableVisible } from "./armtek-return-settings.js";

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
const purchasePriceToggle = document.querySelector("#purchase-price-toggle");
const analogsPurchasePriceToggle = document.querySelector("#analogs-purchase-price-toggle");
const tableSearchInput = document.querySelector("#table-search");
const sortButtons = [...resultsTable.querySelectorAll(".table-sort")];
const tableColumnInputs = [...document.querySelectorAll(".table-column-input")];
const tableColumnsReset = document.querySelector("#table-columns-reset");
const searchTabsList = document.querySelector("#search-tabs-list");
const newTabButton = document.querySelector("#new-tab-button");
const settingsToggle = document.querySelector("#settings-toggle");
const supplierEnabledInputs = [...document.querySelectorAll(".supplier-enabled-input")];
const supplierVisibilityInputs = [...document.querySelectorAll(".supplier-visibility-input")];
const supplierSettingsCards = Object.fromEntries(
  [...document.querySelectorAll(".auth-card[data-supplier]")].map((card) => [card.dataset.supplier, card]),
);
const filtersToggle = document.querySelector("#filters-toggle");
const filtersSidebar = document.querySelector("#filters-sidebar");
const filtersResize = document.querySelector("#filters-resize");
const filterValueContainers = Object.fromEntries(
  [...document.querySelectorAll("[data-filter-values]")].map((container) => [container.dataset.filterValues, container]),
);
const filterSections = Object.fromEntries(
  [...document.querySelectorAll("[data-filter-section]")].map((section) => [section.dataset.filterSection, section]),
);
const filtersReset = document.querySelector("#filters-reset");
const analogFilterValueContainers = Object.fromEntries(
  [...document.querySelectorAll("[data-analog-filter-values]")].map((container) => [container.dataset.analogFilterValues, container]),
);
const analogFilterSections = Object.fromEntries(
  [...document.querySelectorAll("[data-analog-filter-section]")].map((section) => [section.dataset.analogFilterSection, section]),
);
const analogFiltersReset = document.querySelector("#analogs-filters-reset");
const analogFiltersToggle = document.querySelector("#analogs-filters-toggle");
const analogFiltersSidebar = document.querySelector("#analogs-filters-sidebar");
const analogFiltersResize = document.querySelector("#analogs-filters-resize");
const settingsDrawer = document.querySelector("#settings-drawer");
const settingsClose = document.querySelector("#settings-close");
const settingsBackdrop = document.querySelector("#settings-backdrop");
const rosskoAuthForm = document.querySelector("#rossko-auth-form");
const rosskoKey1Input = document.querySelector("#rossko-key1");
const rosskoKey2Input = document.querySelector("#rossko-key2");
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
const armtekNonReturnableInput = document.querySelector("#armtek-non-returnable");
const partKomAuthForm = document.querySelector("#part-kom-auth-form");
const partKomLoginInput = document.querySelector("#part-kom-login");
const partKomPasswordInput = document.querySelector("#part-kom-password");
const partKomConnectButton = document.querySelector("#part-kom-connect-button");
const partKomLogoutButton = document.querySelector("#part-kom-logout-button");
const partKomSessionPill = document.querySelector("#part-kom-session-pill");
const partKomAuthFeedback = document.querySelector("#part-kom-auth-feedback");
const partKomNonReturnableInput = document.querySelector("#part-kom-non-returnable");
const stpartsAuthForm = document.querySelector("#stparts-auth-form");
const stpartsLoginInput = document.querySelector("#stparts-login");
const stpartsPasswordInput = document.querySelector("#stparts-password");
const stpartsConnectButton = document.querySelector("#stparts-connect-button");
const stpartsLogoutButton = document.querySelector("#stparts-logout-button");
const stpartsSessionPill = document.querySelector("#stparts-session-pill");
const stpartsAuthFeedback = document.querySelector("#stparts-auth-feedback");
const stpartsWarehouseInputs = [...document.querySelectorAll(".stparts-warehouse-input")];
const forumAutoAuthForm = document.querySelector("#forum-auto-auth-form");
const forumAutoLoginInput = document.querySelector("#forum-auto-login");
const forumAutoPasswordInput = document.querySelector("#forum-auto-password");
const forumAutoConnectButton = document.querySelector("#forum-auto-connect-button");
const forumAutoLogoutButton = document.querySelector("#forum-auto-logout-button");
const forumAutoSessionPill = document.querySelector("#forum-auto-session-pill");
const forumAutoAuthFeedback = document.querySelector("#forum-auto-auth-feedback");
const forumAutoNonReturnableInput = document.querySelector("#forum-auto-non-returnable");
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
const resultContextMenu = document.querySelector("#result-context-menu");
const openResultButton = document.querySelector("#open-result-button");
const tabContextMenu = document.querySelector("#tab-context-menu");
const renameTabButton = document.querySelector("#rename-tab-button");
const warehouseTooltip = document.querySelector("#warehouse-tooltip");
const showAnalogsButton = document.querySelector("#show-analogs-button");
const analogsModal = document.querySelector("#analogs-modal");
const analogsSourceBrand = document.querySelector("#analogs-source-brand");
const analogsSourceArticle = document.querySelector("#analogs-source-article");
const analogsSourceTitle = document.querySelector("#analogs-source-title");
const analogsSourceSupplier = document.querySelector("#analogs-source-supplier");
const analogsSourcePrice = document.querySelector("#analogs-source-price");
const analogsSourceMarkupPrice = document.querySelector("#analogs-source-markup-price");
const analogsSourceDelivery = document.querySelector("#analogs-source-delivery");
const analogsSourceWarehouse = document.querySelector("#analogs-source-warehouse");
const analogsSearchStatus = document.querySelector("#analogs-search-status");
const analogsResultsBody = document.querySelector("#analogs-results-body");
const analogsCount = document.querySelector("#analogs-count");
const analogsTableSearch = document.querySelector("#analogs-table-search");
const analogsMarkupPercent = document.querySelector("#analogs-markup-percent");
const analogsShowMore = document.querySelector("#analogs-show-more");
const analogSortButtons = [...document.querySelectorAll("[data-analog-sort-key]")];
const closeAnalogsModalButtons = [...document.querySelectorAll("[data-close-analogs-modal]")];
const articleAnalogsModal = document.querySelector("#article-analogs-modal");
const articleAnalogsModalDescription = document.querySelector("#article-analogs-modal-description");
const articleAnalogsModalStatus = document.querySelector("#article-analogs-modal-status");
const articleAnalogsModalBrand = document.querySelector("#article-analogs-modal-brand");
const articleAnalogsModalBrands = document.querySelector("#article-analogs-modal-brands");
const articleAnalogsModalContinue = document.querySelector("#article-analogs-modal-continue");
const closeArticleAnalogsModalButtons = [...document.querySelectorAll("[data-close-article-analogs-modal]")];

let searchTabs = [];
let activeTabId = null;
let tabSequence = 1;
let results = [];
let sortState = { key: "markupPrice", direction: "ascending" };
let markupPercent = 35;
let showPurchasePrices = false;
let tableSearchTerm = "";
let contextMenuResult = null;
let contextMenuAnchor = null;
let contextMenuTabId = null;
let contextMenuTabAnchor = null;
let analogSearchSources = new Set();
let analogModalReturnFocus = null;
let analogReturnResult = null;
let analogSourceResult = null;
let analogSearchResults = [];
let analogSearchResultKeys = new Set();
let analogSearchTerm = "";
let analogSortState = { key: "price", direction: "ascending" };
let analogSearchSuppliers = [];
let analogSupplierStatuses = {};
let analogResultCounts = {};
let analogVisibleLimit = 200;
let analogRenderFrame = null;
let analogSearchCompleted = false;
let analogStatusHideTimer = null;
let articleBrandSearchSource = null;
let articleBrandModalReturnFocus = null;
let articleBrandArticle = "";
let articleBrandCandidates = new Set();
let supplierCheckInProgress = false;
let searchProgressTimer = null;
const selectedFilterValuesByColumn = new Map();
const filterRangesByColumn = new Map();
const selectedAnalogFilterValuesByColumn = new Map();
const analogFilterRangesByColumn = new Map();
const supplierSessionStates = new Map();

const searchStateStorageKey = "autoservice.searchState";
const tableColumnsStorageKey = "autoservice.tableColumns";
const stpartsWarehousesStorageKey = "autoservice.stpartsWarehouses";
const armtekNonReturnableStorageKey = "autoservice.armtekNonReturnable";
const partKomNonReturnableStorageKey = "autoservice.partKomNonReturnable";
const forumAutoNonReturnableStorageKey = "autoservice.forumAutoNonReturnable";
const supplierVisibilityStorageKey = "autoservice.supplierVisibility";
const filtersWidthStorageKey = "autoservice.filtersWidth.v2";
const analogFiltersWidthStorageKey = "autoservice.analogFiltersWidth.v1";
const lastSearchStorageKey = "autoservice.lastSearchStartedAt";
const supplierCheckIntervalMs = 2 * 60 * 60 * 1000;

const supplierNames = {
  rossko: "Rossko",
  armtek: "Armtek",
  "part-kom": "PartKOM",
  stparts: "STParts",
  "forum-auto": "Forum-Auto",
  motordetal: "MotorDetal",
  mladov: "Механик Ладов",
};
const supplierIds = Object.keys(supplierNames);
const analogSupplierIds = ["rossko", "armtek", "part-kom", "stparts", "forum-auto"];
const visibleSuppliers = new Set(supplierIds);
let supplierSearchSelectionsRestored = false;
const tableColumnIds = tableColumnInputs.map((input) => input.value);
const tableColumnWidths = {
  supplier: 100,
  brand: 125,
  article: 150,
  title: 325,
  quantity: 120,
  warehouse: 120,
  purchasePrice: 120,
  markupPrice: 120,
  deliveryDate: 120,
};
let visibleTableColumns = new Set(tableColumnIds);
let visibleStpartsWarehouses = new Set(["green"]);
let showArmtekNonReturnable = false;
let showPartKomNonReturnable = false;
let showForumAutoNonReturnable = false;
const mainFilterColumns = ["supplier", "brand", "article", "warehouse", "markupPrice", "deliveryDate"];
const rangeFilterColumns = new Set(["markupPrice", "deliveryDate"]);

const supplierSearchToggles = Object.fromEntries(
  supplierEnabledInputs.map((input) => [input.value, input.closest(".supplier-search-toggle")]),
);
const supplierEnabledInputsById = Object.fromEntries(supplierEnabledInputs.map((input) => [input.value, input]));

const isSupplierVisible = (supplier) => visibleSuppliers.has(supplier);
const getEnabledSuppliers = () => supplierEnabledInputs
  .filter((input) => input.checked && isSupplierVisible(input.value))
  .map((input) => input.value);

const getFilterValue = (result, column) => {
  if (column === "supplier") {
    return supplierNames[result.supplier] ?? result.supplier;
  }
  if (column === "brand") {
    return formatBrand(result.brand);
  }
  if (column === "article") {
    return formatArticle(result.article);
  }
  if (column === "warehouse") {
    return formatWarehouse(result.warehouse);
  }
  if (column === "quantity") {
    return formatQuantity(result.quantity);
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

const getRangeFilterValue = (result, column, percent = markupPercent) => {
  if (column === "quantity") {
    return Number.isFinite(result.quantity) ? result.quantity : null;
  }
  if (column === "markupPrice") {
    return getMarkupPrice(result, percent);
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

const getAveragePrice = (items, getPrice) => {
  const prices = items.map(getPrice).filter((price) => Number.isFinite(price) && price > 0);
  return prices.length ? prices.reduce((total, price) => total + price, 0) / prices.length : null;
};
const analogTableColumnWidths = {
  supplier: 100,
  brand: 125,
  article: 150,
  title: 325,
  quantity: 120,
  warehouse: 120,
  purchasePrice: 120,
  markupPrice: 120,
  deliveryDate: 120,
};
const analogTableColumnIds = Object.keys(analogTableColumnWidths);

const renderAveragePrices = (container, items) => {
  const averages = document.createElement("div");
  averages.className = "filters-sidebar__averages";
  const appendAverage = (label, price) => {
    const line = document.createElement("div");
    const value = document.createElement("strong");
    value.textContent = formatPrice(price);
    line.append(`${label}: `, value);
    averages.append(line);
  };
  appendAverage("Средняя закуп. цена", getAveragePrice(items, (result) => result.price));
  appendAverage("Средняя цена", getAveragePrice(items, (result) => getMarkupPrice(result)));
  container.append(averages);
};

const getFilteredResults = (sourceResults, searchTerm, percent, ignoredFilterColumn = null) => {
  const normalizedSearchTerm = searchTerm.trim().toLocaleLowerCase();

  return sourceResults.filter((result) => {
    if (normalizedSearchTerm) {
      const searchableValues = [
        supplierNames[result.supplier] ?? result.supplier,
        formatBrand(result.brand),
        formatArticle(result.article),
        result.title,
        result.warehouse,
      ];
      if (!searchableValues.some((value) => String(value ?? "").toLocaleLowerCase().includes(normalizedSearchTerm))) {
        return false;
      }
    }

    return tableColumnIds.every((column) => {
      if (column === ignoredFilterColumn) {
        return true;
      }

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
        const value = getRangeFilterValue(result, column, percent);
        return Number.isFinite(value)
          && (!range.from || value >= from)
          && (!range.to || value <= to);
      }

      return getSelectedFilterValues(column).has(getFilterValue(result, column));
    });
  });
};

const renderFilterValues = () => {
  const visibleExactResults = getVisibleMainExactResults(results);

  mainFilterColumns.forEach((column) => {
    const container = filterValueContainers[column];
    const section = filterSections[column];
    const candidateResults = getFilteredResults(visibleExactResults, tableSearchTerm, markupPercent, column);
    container.replaceChildren();

    if (rangeFilterColumns.has(column)) {
      const hasValues = candidateResults.some((result) => Number.isFinite(getRangeFilterValue(result, column, markupPercent)));
      section.hidden = !visibleTableColumns.has(column) || !hasValues;
      if (!hasValues) {
        return;
      }

      const isDate = column === "deliveryDate";
      const createRangeInput = (bound, labelText) => {
        const label = document.createElement("label");
        label.className = "filters-sidebar__range";
        const text = document.createElement("span");
        text.textContent = labelText;
        const input = document.createElement("input");
        input.type = isDate ? "date" : "number";
        input.min = isDate ? "" : "0";
        input.step = isDate ? "" : "0.01";
        input.placeholder = isDate ? "дд.мм.гггг" : "0";
        input.value = getFilterRange(column)[bound];
        input.dataset.filterColumn = column;
        input.dataset.filterRange = bound;
        label.append(text, input);
        return label;
      };
      container.replaceChildren(
        createRangeInput("from", "От"),
        createRangeInput("to", "До"),
      );
      if (column === "markupPrice") {
        renderAveragePrices(container, getMainTableResults(results).filteredResults);
      }
      return;
    }

    const values = [...new Set(candidateResults.map((result) => getFilterValue(result, column)))].sort(resultCollator.compare);
    section.hidden = !visibleTableColumns.has(column) || values.length === 0;
    container.replaceChildren(...values.map((value) => {
      const button = document.createElement("button");
      const selected = getSelectedFilterValues(column).has(value);
      button.type = "button";
      button.className = "filters-sidebar__value";
      button.dataset.filterColumn = column;
      button.dataset.filterValue = value;
      button.setAttribute("aria-pressed", String(selected));
      button.textContent = value;
      return button;
    }));
  });
  filtersReset.hidden = !hasAnyActiveFilters();
};

const getSelectedAnalogFilterValues = (column) => selectedAnalogFilterValuesByColumn.get(column) ?? new Set();

const getAnalogFilterRange = (column) => analogFilterRangesByColumn.get(column) ?? { from: "", to: "" };

const hasActiveAnalogFilter = (column) => (rangeFilterColumns.has(column)
  ? Boolean(getAnalogFilterRange(column).from || getAnalogFilterRange(column).to)
  : getSelectedAnalogFilterValues(column).size > 0);

const getVisibleAnalogResults = (items) => filterVisibleArmtekReturnable(filterVisibleForumAutoReturnable(filterVisiblePartKomReturnable(filterVisibleStpartsWarehouses(
  items.filter((result) => isSupplierVisible(result.supplier)),
))));

const getFilteredAnalogResults = (sourceResults, ignoredFilterColumn = null) => {
  const normalizedSearchTerm = analogSearchTerm.trim().toLocaleLowerCase();
  return sourceResults.filter((result) => {
    if (normalizedSearchTerm && ![
      supplierNames[result.supplier] ?? result.supplier,
      formatBrand(result.brand),
      formatArticle(result.article),
      result.title,
      result.warehouse,
    ].some((value) => String(value ?? "").toLocaleLowerCase().includes(normalizedSearchTerm))) {
      return false;
    }

    return mainFilterColumns.every((column) => {
      if (column === ignoredFilterColumn || !hasActiveAnalogFilter(column)) {
        return true;
      }
      if (rangeFilterColumns.has(column)) {
        const range = getAnalogFilterRange(column);
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
      return getSelectedAnalogFilterValues(column).has(getFilterValue(result, column));
    });
  });
};

const renderAnalogFilterValues = () => {
  const visibleResults = getVisibleAnalogResults(analogSearchResults);
  mainFilterColumns.forEach((column) => {
    const container = analogFilterValueContainers[column];
    const section = analogFilterSections[column];
    const candidateResults = getFilteredAnalogResults(visibleResults, column);
    container.replaceChildren();

    if (rangeFilterColumns.has(column)) {
      const hasValues = candidateResults.some((result) => Number.isFinite(getRangeFilterValue(result, column)));
      section.hidden = !hasValues;
      if (!hasValues) {
        return;
      }
      const isDate = column === "deliveryDate";
      const createRangeInput = (bound, labelText) => {
        const label = document.createElement("label");
        label.className = "filters-sidebar__range";
        const text = document.createElement("span");
        text.textContent = labelText;
        const input = document.createElement("input");
        input.type = isDate ? "date" : "number";
        input.min = isDate ? "" : "0";
        input.step = isDate ? "" : "0.01";
        input.placeholder = isDate ? "дд.мм.гггг" : "0";
        input.value = getAnalogFilterRange(column)[bound];
        input.dataset.analogFilterColumn = column;
        input.dataset.analogFilterRange = bound;
        label.append(text, input);
        return label;
      };
      container.replaceChildren(createRangeInput("from", "От"), createRangeInput("to", "До"));
      if (column === "markupPrice") {
        renderAveragePrices(container, getFilteredAnalogResults(visibleResults));
      }
      return;
    }

    const values = [...new Set(candidateResults.map((result) => getFilterValue(result, column)))].sort(resultCollator.compare);
    section.hidden = values.length === 0;
    container.replaceChildren(...values.map((value) => {
      const button = document.createElement("button");
      const selected = getSelectedAnalogFilterValues(column).has(value);
      button.type = "button";
      button.className = "filters-sidebar__value";
      button.dataset.analogFilterColumn = column;
      button.dataset.analogFilterValue = value;
      button.setAttribute("aria-pressed", String(selected));
      button.textContent = value;
      return button;
    }));
  });
  analogFiltersReset.hidden = !mainFilterColumns.some((column) => hasActiveAnalogFilter(column));
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

  toggle.hidden = !authorized || !isSupplierVisible(supplier);

  if ((!authorized || !isSupplierVisible(supplier)) && input.checked) {
    input.checked = false;
    if (supplierSearchSelectionsRestored) {
      syncActiveTab();
      saveSearchState();
    }
  }

};

const setFiltersSidebarOpen = (open) => {
  filtersSidebar.hidden = !open;
  filtersToggle.setAttribute("aria-expanded", String(open));
  filtersToggle.setAttribute("aria-label", open ? "Скрыть фильтры" : "Открыть фильтры");
  filtersToggle.title = open ? "Скрыть фильтры" : "Открыть фильтры";
};

const setFiltersSidebarWidth = (value) => {
  const width = Number(value);
  if (!Number.isFinite(width)) {
    return;
  }
  const normalizedWidth = Math.min(420, Math.max(180, Math.round(width / 10) * 10));
  filtersSidebar.style.setProperty("--filters-sidebar-width", `${normalizedWidth}px`);
  try {
    localStorage.setItem(filtersWidthStorageKey, String(normalizedWidth));
  } catch {
    // The panel remains resizable for this session when storage is unavailable.
  }
};

const restoreFiltersSidebarWidth = () => {
  try {
    setFiltersSidebarWidth(localStorage.getItem(filtersWidthStorageKey) ?? 200);
  } catch {
    setFiltersSidebarWidth(200);
  }
};

const setSupplierEnabled = (supplier, enabled) => {
  const input = supplierEnabledInputsById[supplier];

  if (!input || !isSupplierVisible(supplier)) {
    return;
  }

  input.checked = enabled;
  syncActiveTab();
  saveSearchState();
};

const saveSupplierVisibility = () => {
  try {
    localStorage.setItem(supplierVisibilityStorageKey, JSON.stringify([...visibleSuppliers]));
  } catch {
    // Supplier visibility is a local preference; searches remain safe without storage.
  }
};

const updateSupplierVisibility = (supplier) => {
  const visible = isSupplierVisible(supplier);
  const card = supplierSettingsCards[supplier];
  const searchInput = supplierEnabledInputsById[supplier];

  if (card) {
    card.hidden = !visible;
  }
  if (!visible && searchInput) {
    searchInput.checked = false;
  }
  updateSupplierSearchToggle(supplier, Boolean(supplierSessionStates.get(supplier)));
};

const restoreSupplierVisibility = () => {
  try {
    const stored = JSON.parse(localStorage.getItem(supplierVisibilityStorageKey));
    if (Array.isArray(stored) && stored.every((supplier) => supplierIds.includes(supplier))) {
      visibleSuppliers.clear();
      stored.forEach((supplier) => visibleSuppliers.add(supplier));
    }
  } catch {
    // Invalid local data falls back to showing all supported suppliers.
  }

  supplierVisibilityInputs.forEach((input) => {
    input.checked = isSupplierVisible(input.value);
  });
  supplierIds.forEach(updateSupplierVisibility);
};

const normalizeMarkupPercent = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(1000, Math.max(0, parsed)) : 35;
};

const normalizeTabName = (value) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 100) : "");

const createSearchTab = (data = {}) => ({
  id: data.id ?? `tab-${Date.now()}-${tabSequence++}`,
  article: typeof data.article === "string" ? data.article : "",
  name: normalizeTabName(data.name),
  enabledSuppliers: Array.isArray(data.enabledSuppliers) ? data.enabledSuppliers : getEnabledSuppliers(),
  status: typeof data.status === "string" && data.status !== "Ожидание поиска" ? data.status : "",
  results: Array.isArray(data.results) ? data.results.filter((result) => result?.isAnalog !== true) : [],
  hasSearched:
    typeof data.hasSearched === "boolean"
      ? data.hasSearched
      : Boolean(data.results?.length) || Boolean(data.status && data.status !== "Ожидание поиска"),
  markupPercent: normalizeMarkupPercent(data.markupPercent),
  supplierStatuses: {},
  supplierStatusDetails: {},
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

  const pendingSuppliers = tab.enabledSuppliers
    .filter(isSupplierVisible)
    .filter((supplier) => !searchTerminalStatuses.has(tab.supplierStatuses[supplier]));
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

  const disconnected = supplierIds.filter((supplier) => isSupplierVisible(supplier) && !supplierSessionStates.get(supplier));
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

const resultCollator = new Intl.Collator("ru", { numeric: true, sensitivity: "base" });

const getMarkupPrice = (result, percent = markupPercent) => {
  const price = Number(result.price);
  return Number.isFinite(price) && price > 0 ? price * (1 + percent / 100) : null;
};

const getSortValue = (result, key, percent = markupPercent) => {
  if (key === "supplier") {
    return supplierNames[result.supplier] ?? result.supplier;
  }

  if (key === "deliveryDate") {
    const timestamp = result.deliveryDate ? new Date(result.deliveryDate).getTime() : Number.NaN;
    return Number.isNaN(timestamp) ? null : timestamp;
  }

  if (key === "markupPrice") {
    return getMarkupPrice(result, percent);
  }

  if (key === "brand") {
    return formatBrand(result.brand);
  }

  if (key === "article") {
    return formatArticle(result.article);
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

const compareResults = (left, right, state = sortState, percent = markupPercent) => {
  const comparison = state.key === "deliveryDate"
    ? compareDeliveryDates(left, right)
    : compareSortValues(getSortValue(left, state.key, percent), getSortValue(right, state.key, percent));

  if (state.key === "markupPrice" && comparison === 0) {
    return compareDeliveryDates(left, right);
  }
  return state.direction === "ascending" ? comparison : -comparison;
};

const updateSortHeaders = (buttons, state) => {
  buttons.forEach((button) => {
    const isActive = button.dataset.sortKey === state.key;
    const direction = isActive ? state.direction : "none";
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

  resultCount.textContent = String(items.length);
  resultCount.dataset.tooltip = breakdown;
  resultCount.title = `Показано предложений: ${items.length}`;
  resultCount.setAttribute("aria-label", breakdown ? `По поставщикам:\n${breakdown}` : "Нет результатов");
};

const getVisibleTableColumns = () => [
  ...(showPurchasePrices ? ["purchasePrice"] : []),
  ...tableColumnIds.filter((column) => visibleTableColumns.has(column)),
];

const saveTableColumns = () => {
  try {
    localStorage.setItem(tableColumnsStorageKey, JSON.stringify(getVisibleTableColumns()));
  } catch {
    // Column preferences are optional; unavailable storage must not affect search.
  }
};

const applyTableColumns = () => {
  const visibleColumns = getVisibleTableColumns();
  const minimumWidth = visibleColumns.reduce((width, column) => width + tableColumnWidths[column], 0);
  resultsTable.style.setProperty("--results-table-min-width", `${minimumWidth}px`);
  resultsTable.querySelectorAll("th[data-column]").forEach((header) => {
    header.style.width = visibleColumns.includes(header.dataset.column)
      ? `${tableColumnWidths[header.dataset.column] / minimumWidth * 100}%`
      : "";
  });
  tableColumnsReset.hidden = visibleTableColumns.size === tableColumnIds.length;
  document.querySelectorAll("[data-column]").forEach((element) => {
    element.hidden = !visibleColumns.includes(element.dataset.column);
  });
  resultsBody.querySelectorAll(".results-table__empty td").forEach((cell) => {
    cell.colSpan = visibleColumns.length;
  });
  Object.entries(filterSections).forEach(([column, section]) => {
    section.hidden = !visibleTableColumns.has(column);
  });
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
    const savedTableColumns = new Set(savedColumns.filter((column) => tableColumnIds.includes(column)));
    if (savedColumns.includes("price")) {
      savedTableColumns.add("markupPrice");
    }
    visibleTableColumns = savedTableColumns;
  } catch {
    localStorage.removeItem(tableColumnsStorageKey);
  }
};

const saveStpartsWarehouses = () => {
  try {
    localStorage.setItem(stpartsWarehousesStorageKey, JSON.stringify([...visibleStpartsWarehouses]));
  } catch {
    // Warehouse preferences are optional; unavailable storage must not affect search.
  }
};

const updateStpartsWarehouseInputs = () => {
  const hasSingleWarehouse = visibleStpartsWarehouses.size === 1;
  stpartsWarehouseInputs.forEach((input) => {
    input.checked = visibleStpartsWarehouses.has(input.value);
    input.disabled = hasSingleWarehouse && input.checked;
  });
};

const restoreStpartsWarehouses = () => {
  try {
    const savedColors = JSON.parse(localStorage.getItem(stpartsWarehousesStorageKey));
    visibleStpartsWarehouses = new Set(normalizeStpartsWarehouseColors(savedColors));
  } catch {
    localStorage.removeItem(stpartsWarehousesStorageKey);
  }
  updateStpartsWarehouseInputs();
};

const filterVisibleStpartsWarehouses = (items) => items.filter(
  (result) => isStpartsWarehouseVisible(result, visibleStpartsWarehouses),
);

const saveArmtekNonReturnable = () => {
  try {
    localStorage.setItem(armtekNonReturnableStorageKey, String(showArmtekNonReturnable));
  } catch {
    // Return preferences are optional; unavailable storage must not affect search.
  }
};

const restoreArmtekNonReturnable = () => {
  try {
    showArmtekNonReturnable = localStorage.getItem(armtekNonReturnableStorageKey) === "true";
  } catch {
    // Return preferences are optional; unavailable storage must not affect search.
  }
  armtekNonReturnableInput.checked = showArmtekNonReturnable;
};

const filterVisibleArmtekReturnable = (items) => items.filter(
  (result) => isArmtekReturnableVisible(result, showArmtekNonReturnable),
);

const savePartKomNonReturnable = () => {
  try {
    localStorage.setItem(partKomNonReturnableStorageKey, String(showPartKomNonReturnable));
  } catch {
    // Return preferences are optional; unavailable storage must not affect search.
  }
};

const restorePartKomNonReturnable = () => {
  try {
    showPartKomNonReturnable = localStorage.getItem(partKomNonReturnableStorageKey) === "true";
  } catch {
    // Return preferences are optional; unavailable storage must not affect search.
  }
  partKomNonReturnableInput.checked = showPartKomNonReturnable;
};

const filterVisiblePartKomReturnable = (items) => items.filter(
  (result) => isPartKomReturnableVisible(result, showPartKomNonReturnable),
);

const saveForumAutoNonReturnable = () => {
  try {
    localStorage.setItem(forumAutoNonReturnableStorageKey, String(showForumAutoNonReturnable));
  } catch {
    // Return preferences are optional; unavailable storage must not affect search.
  }
};

const restoreForumAutoNonReturnable = () => {
  try {
    showForumAutoNonReturnable = localStorage.getItem(forumAutoNonReturnableStorageKey) === "true";
  } catch {
    // Return preferences are optional; unavailable storage must not affect search.
  }
  forumAutoNonReturnableInput.checked = showForumAutoNonReturnable;
};

const filterVisibleForumAutoReturnable = (items) => items.filter(
  (result) => isForumAutoReturnableVisible(result, showForumAutoNonReturnable),
);

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
          name: tab.name,
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
      const title = tab.name || tab.article || `Новый поиск ${index + 1}`;

      return `
       <button type="button" class="search-tab ${tab.id === activeTabId ? "active" : ""}" data-tab-id="${escapeHtml(tab.id)}" role="tab" aria-selected="${tab.id === activeTabId}" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}">
          <span class="search-tab__status ${statusClass}"></span><span class="search-tab__title">${escapeHtml(title)}</span>
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
  markupPercentInput.value = String(markupPercent);
  articleInput.value = tab.article;
  globalStatus.textContent = tab.status;
  supplierEnabledInputs.forEach((input) => {
    input.checked = isSupplierVisible(input.value) && tab.enabledSuppliers.includes(input.value);
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

const getVisibleMainExactResults = (items) => {
  // Older persisted tabs can still contain automatically fetched analogs.
  const exactResults = items.filter((result) => result.isAnalog !== true);
  return filterVisibleArmtekReturnable(filterVisibleForumAutoReturnable(filterVisiblePartKomReturnable(filterVisibleStpartsWarehouses(
    exactResults.filter((result) => isSupplierVisible(result.supplier)),
  ))));
};

const getMainTableResults = (items) => {
  // Kept separately so the empty-state message considers all exact results.
  const exactResults = items.filter((result) => result.isAnalog !== true);
  const visibleExactResults = getVisibleMainExactResults(items);

  return {
    exactResults,
    filteredResults: getFilteredResults(visibleExactResults, tableSearchTerm, markupPercent),
  };
};

const renderResults = () => {
  tableColumnIds.filter((column) => !visibleTableColumns.has(column)).forEach((column) => {
    selectedFilterValuesByColumn.delete(column);
    filterRangesByColumn.delete(column);
  });

  const { exactResults, filteredResults } = getMainTableResults(results);
  const sortedResults = [...filteredResults].sort((left, right) =>
    compareResults(left, right, sortState, markupPercent));
  const bestPrice = filteredResults
    .filter((result) => getMarkupPrice(result, markupPercent) !== null)
    .reduce((best, result) => !best || getMarkupPrice(result, markupPercent) < getMarkupPrice(best, markupPercent) ? result : best, null);
  const isSearching = Boolean(getActiveTab()?.source);
  updateSortHeaders(sortButtons, sortState);
  const renderResult = (result, percent) => {
    const supplierName = supplierNames[result.supplier] ?? result.supplier;
    const deliveryDate = result.supplier === "mladov" && !result.deliveryDate
      ? "-"
      : formatDeliveryDate(result.deliveryDate, result.deliveryDateApproximate, result.deliveryDateTo);
    const isBestPrice = result === bestPrice;

    return `
      <tr class="results-table__row main-result-row${isBestPrice ? " is-best-price" : ""}" data-result-index="${results.indexOf(result)}" tabindex="${isSearching ? "-1" : "0"}" aria-disabled="${isSearching}" aria-label="Действия для ${escapeHtml(result.title)}">
        <td data-column="supplier">${escapeHtml(supplierName)}</td>
        <td data-column="brand">${escapeHtml(formatBrand(result.brand))}</td>
        <td data-column="article">${escapeHtml(formatArticle(result.article))}</td>
        <td data-column="title"><div class="result-title-cell"><span title="${escapeHtml(result.title)}">${escapeHtml(result.title)}</span></div></td>
        <td data-column="quantity">${escapeHtml(formatQuantity(result.quantity))}</td>
        <td data-column="warehouse">${renderWarehouse(result)}</td>
        <td data-column="purchasePrice">${escapeHtml(formatPrice(result.price))}</td>
        <td data-column="markupPrice"><span class="main-result-price">${escapeHtml(formatPrice(getMarkupPrice(result, percent)))}</span>${isBestPrice ? '<span class="main-best-price">Лучшая цена</span>' : ""}</td>
        <td data-column="deliveryDate">${escapeHtml(deliveryDate)}</td>
      </tr>
    `;
  };
  const renderEmptyRow = (message) => `
    <tr class="results-table__empty"><td colspan="${Math.max(getVisibleTableColumns().length, 1)}">${message}</td></tr>
  `;

  const emptyMessage = exactResults.length ? "Нет позиций с выбранными условиями." : "По вашему запросу ничего не найдено.";
  hideWarehouseTooltip();
  resultsBody.innerHTML = sortedResults.length
    ? sortedResults.map((result) => renderResult(result, markupPercent)).join("")
    : renderEmptyRow(emptyMessage);
  applyTableColumns();
  updateResultCount(sortedResults);
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

const setPurchasePricesVisible = (visible) => {
  showPurchasePrices = visible;
  [purchasePriceToggle, analogsPurchasePriceToggle].forEach((toggle) => {
    toggle.setAttribute("aria-pressed", String(visible));
    toggle.setAttribute("aria-label", visible ? "Скрыть закупочные цены" : "Показать закупочные цены");
    toggle.title = visible ? "Скрыть закупочные цены" : "Показать закупочные цены";
  });
  renderResults();
  if (!analogsModal.hidden) {
    renderAnalogRowsNow();
  }
};

const setAnalogFiltersSidebarWidth = (value) => {
  const width = Number(value);
  if (!Number.isFinite(width)) {
    return;
  }
  const normalizedWidth = Math.min(420, Math.max(180, Math.round(width / 10) * 10));
  analogFiltersSidebar.style.setProperty("--filters-sidebar-width", `${normalizedWidth}px`);
  try {
    localStorage.setItem(analogFiltersWidthStorageKey, String(normalizedWidth));
  } catch {
    // The panel remains resizable for this session when storage is unavailable.
  }
};

const restoreAnalogFiltersSidebarWidth = () => {
  try {
    setAnalogFiltersSidebarWidth(localStorage.getItem(analogFiltersWidthStorageKey) ?? 200);
  } catch {
    setAnalogFiltersSidebarWidth(200);
  }
};

const setAnalogFiltersSidebarOpen = (open) => {
  analogFiltersSidebar.hidden = !open;
  analogFiltersToggle.setAttribute("aria-expanded", String(open));
  analogFiltersToggle.setAttribute("aria-label", open ? "Скрыть фильтры" : "Открыть фильтры");
  analogFiltersToggle.title = open ? "Скрыть фильтры" : "Открыть фильтры";
};

const resetSearchState = () => {
  results = [];
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

const updateRosskoSessionCard = (session) => {
  updateSupplierNotice(session);
  updateSupplierSearchToggle("rossko", session.authorized);
  rosskoSessionPill.dataset.status = sessionPillStatus(session.authorized);
  rosskoSessionPill.textContent = sessionPillText(session.authorized);
  rosskoAuthForm.dataset.authorized = String(session.authorized);
  rosskoConnectButton.hidden = session.authorized;
  rosskoLogoutButton.hidden = !session.authorized;
  rosskoAuthFeedback.textContent = "";
};

const updateArmtekSessionCard = (session) => {
  updateSupplierNotice(session);
  updateSupplierSearchToggle("armtek", session.authorized);
  armtekSessionPill.dataset.status = sessionPillStatus(session.authorized);
  armtekSessionPill.textContent = sessionPillText(session.authorized);
  armtekAuthForm.dataset.authorized = String(session.authorized);
  armtekConnectButton.hidden = session.authorized;
  armtekLogoutButton.hidden = !session.authorized;
  armtekAuthFeedback.textContent = "";
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

const updateForumAutoSessionCard = (session) => {
  updateSupplierNotice(session);
  updateSupplierSearchToggle("forum-auto", session.authorized);
  forumAutoSessionPill.dataset.status = sessionPillStatus(session.authorized);
  forumAutoSessionPill.textContent = sessionPillText(session.authorized);
  forumAutoAuthForm.dataset.authorized = String(session.authorized);
  forumAutoConnectButton.hidden = session.authorized;
  forumAutoLogoutButton.hidden = !session.authorized;
  forumAutoAuthFeedback.textContent = "";
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
  "forum-auto": updateForumAutoSessionCard,
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
  const forumAutoSession = payload.sessions.find((session) => session.supplier === "forum-auto");
  const motorDetalSession = payload.sessions.find((session) => session.supplier === "motordetal");
  const mladovSession = payload.sessions.find((session) => session.supplier === "mladov");

  if (rosskoSession) {
    updateRosskoSessionCard(rosskoSession);
  }

  if (armtekSession) {
    updateArmtekSessionCard(armtekSession);
  }

  if (partKomSession) {
    updatePartKomSessionCard(partKomSession);
  }

  if (stpartsSession) {
    updateStpartsSessionCard(stpartsSession);
  }

  if (forumAutoSession) {
    updateForumAutoSessionCard(forumAutoSession);
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
  supplierCheck.hidden = false;
  supplierCheck.focus();
  supplierCheckOk.focus();
};

const showIncompleteSearchWarning = (tab) => {
  const warnings = buildIncompleteSearchWarnings(
    tab.enabledSuppliers.filter(isSupplierVisible),
    tab.supplierStatuses,
    supplierNames,
    tab.supplierStatusDetails,
  );
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
  try {
    const payload = await postJson("/api/suppliers/sessions/validate", { article, suppliers });
    updateSessionCards(payload.sessions);
    const expired = payload.results.filter((result) => result.status === "expired").map((result) => result.supplier);
    const unavailable = payload.results.filter((result) => result.status === "error").map((result) => result.supplier);

    if (expired.length || unavailable.length) {
      showSupplierCheckError(expired, unavailable);
      return false;
    }

    return true;
  } catch {
    showSupplierCheckError([], suppliers);
    return false;
  }
};

const showSupplierSessionCheckProgress = (article) => {
  globalStatus.textContent = "Проверяем авторизацию поставщиков";
  searchLoadingTitle.textContent = "Проверяем авторизацию поставщиков";
  searchLoadingDescription.textContent = "При необходимости выполняем повторную авторизацию перед поиском.";
  searchLoadingNote.textContent = `Поиск по артикулу ${article} начнется автоматически.`;
  searchLoadingCancel.hidden = true;
  setSearchUiState(true);
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

settingsToggle.addEventListener("click", openSettings);
settingsClose.addEventListener("click", closeSettings);
settingsBackdrop.addEventListener("click", closeSettings);
filtersToggle.addEventListener("click", () => setFiltersSidebarOpen(filtersSidebar.hidden));
analogFiltersToggle.addEventListener("click", () => setAnalogFiltersSidebarOpen(analogFiltersSidebar.hidden));
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
  if (!resultContextMenu.hidden && !resultContextMenu.contains(event.target)) {
    hideResultContextMenu();
  }
  if (!tabContextMenu.hidden && !tabContextMenu.contains(event.target)) {
    hideTabContextMenu();
  }
});

const hideWarehouseTooltip = () => {
  const owner = document.querySelector('[aria-describedby="warehouse-tooltip"]');
  owner?.removeAttribute("aria-describedby");
  warehouseTooltip.hidden = true;
};

const showWarehouseTooltip = (owner) => {
  const text = owner.dataset.tooltip;
  if (!text) {
    return;
  }
  warehouseTooltip.textContent = text;
  warehouseTooltip.hidden = false;
  owner.setAttribute("aria-describedby", "warehouse-tooltip");
  const ownerBounds = owner.getBoundingClientRect();
  const tooltipBounds = warehouseTooltip.getBoundingClientRect();
  const left = Math.max(8, Math.min(ownerBounds.left, window.innerWidth - tooltipBounds.width - 8));
  const below = ownerBounds.bottom + 8;
  const top = below + tooltipBounds.height <= window.innerHeight - 8
    ? below
    : Math.max(8, ownerBounds.top - tooltipBounds.height - 8);
  warehouseTooltip.style.left = `${left}px`;
  warehouseTooltip.style.top = `${top}px`;
};

document.addEventListener("mouseover", (event) => {
  const owner = event.target.closest?.(".warehouse-code[data-tooltip]");
  if (owner) {
    showWarehouseTooltip(owner);
  }
});
document.addEventListener("mouseout", (event) => {
  if (event.target.closest?.(".warehouse-code[data-tooltip]")) {
    hideWarehouseTooltip();
  }
});
document.addEventListener("focusin", (event) => {
  const owner = event.target.closest?.(".warehouse-code[data-tooltip]");
  if (owner) {
    showWarehouseTooltip(owner);
  }
});
document.addEventListener("focusout", (event) => {
  if (event.target.closest?.(".warehouse-code[data-tooltip]")) {
    hideWarehouseTooltip();
  }
});
document.addEventListener("keydown", (event) => {
  const openModal = !articleAnalogsModal.hidden ? articleAnalogsModal : !analogsModal.hidden ? analogsModal : null;
  if (event.key === "Tab" && openModal) {
    const focusable = [...openModal.querySelectorAll("button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex='0']")]
      .filter((element) => element.offsetParent !== null);
    if (!focusable.length) {
      event.preventDefault();
      openModal.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement === openModal)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
    return;
  }
  if (event.key !== "Escape") {
    return;
  }
  if (!tabContextMenu.hidden) {
    hideTabContextMenu(true);
  } else if (!resultContextMenu.hidden) {
    hideResultContextMenu(true);
  } else if (!articleAnalogsModal.hidden) {
    closeArticleAnalogsModal();
  } else if (!analogsModal.hidden) {
    closeAnalogsModal();
  }
});

filtersSidebar.addEventListener("click", (event) => {
  const button = event.target.closest("[data-filter-value]");
  if (!(button instanceof HTMLButtonElement)) {
    return;
  }
  const column = button.dataset.filterColumn;
  const value = button.dataset.filterValue;
  if (!column || value === undefined) {
    return;
  }
  const selectedValues = getSelectedFilterValues(column);
  if (selectedValues.has(value)) {
    selectedValues.delete(value);
  } else {
    selectedValues.add(value);
  }
  selectedFilterValuesByColumn.set(column, selectedValues);
  renderResults();
});

filtersSidebar.addEventListener("change", (event) => {
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) {
    return;
  }

  if (input.dataset.filterRange && input.dataset.filterColumn) {
    filterRangesByColumn.set(input.dataset.filterColumn, {
      ...getFilterRange(input.dataset.filterColumn),
      [input.dataset.filterRange]: input.value,
    });
    renderResults();
  }
});

let filtersResizeStart = null;
const filtersCloseThresholdRatio = 0.02;

const getFiltersCloseWidth = (sidebar) => {
  const workspace = sidebar.closest(".workspace, .analogs-workspace");
  return (workspace?.getBoundingClientRect().width ?? 0) * filtersCloseThresholdRatio;
};

filtersResize.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  filtersResizeStart = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startWidth: filtersSidebar.getBoundingClientRect().width,
  };
  filtersResize.setPointerCapture(event.pointerId);
});

filtersResize.addEventListener("pointermove", (event) => {
  if (!filtersResizeStart || event.pointerId !== filtersResizeStart.pointerId) {
    return;
  }
  const width = filtersResizeStart.startWidth + event.clientX - filtersResizeStart.startX;
  if (width <= getFiltersCloseWidth(filtersSidebar)) {
    filtersResizeStart = null;
    filtersResize.releasePointerCapture(event.pointerId);
    setFiltersSidebarOpen(false);
    return;
  }
  setFiltersSidebarWidth(width);
});

filtersResize.addEventListener("pointerup", (event) => {
  if (filtersResizeStart && event.pointerId === filtersResizeStart.pointerId) {
    filtersResizeStart = null;
  }
});

filtersResize.addEventListener("keydown", (event) => {
  if (!["ArrowLeft", "ArrowRight"].includes(event.key)) {
    return;
  }
  event.preventDefault();
  const width = filtersSidebar.getBoundingClientRect().width;
  if (event.key === "ArrowLeft" && width <= 180) {
    setFiltersSidebarOpen(false);
    return;
  }
  setFiltersSidebarWidth(width + (event.key === "ArrowRight" ? 10 : -10));
});

filtersReset.addEventListener("click", () => {
  selectedFilterValuesByColumn.clear();
  filterRangesByColumn.clear();
  renderResults();
});

let analogFiltersResizeStart = null;

analogFiltersResize.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  analogFiltersResizeStart = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startWidth: analogFiltersSidebar.getBoundingClientRect().width,
  };
  analogFiltersResize.setPointerCapture(event.pointerId);
});

analogFiltersResize.addEventListener("pointermove", (event) => {
  if (!analogFiltersResizeStart || event.pointerId !== analogFiltersResizeStart.pointerId) {
    return;
  }
  const width = analogFiltersResizeStart.startWidth + event.clientX - analogFiltersResizeStart.startX;
  if (width <= getFiltersCloseWidth(analogFiltersSidebar)) {
    analogFiltersResizeStart = null;
    analogFiltersResize.releasePointerCapture(event.pointerId);
    setAnalogFiltersSidebarOpen(false);
    return;
  }
  setAnalogFiltersSidebarWidth(width);
});

analogFiltersResize.addEventListener("pointerup", (event) => {
  if (analogFiltersResizeStart && event.pointerId === analogFiltersResizeStart.pointerId) {
    analogFiltersResizeStart = null;
  }
});

analogFiltersResize.addEventListener("keydown", (event) => {
  if (!["ArrowLeft", "ArrowRight"].includes(event.key)) {
    return;
  }
  event.preventDefault();
  const width = analogFiltersSidebar.getBoundingClientRect().width;
  if (event.key === "ArrowLeft" && width <= 180) {
    setAnalogFiltersSidebarOpen(false);
    return;
  }
  setAnalogFiltersSidebarWidth(width + (event.key === "ArrowRight" ? 10 : -10));
});

analogsModal.addEventListener("click", (event) => {
  const button = event.target.closest("[data-analog-filter-column][data-analog-filter-value]");
  if (!button) {
    return;
  }
  const column = button.dataset.analogFilterColumn;
  const value = button.dataset.analogFilterValue;
  if (!column || value === undefined) {
    return;
  }
  const selectedValues = getSelectedAnalogFilterValues(column);
  if (selectedValues.has(value)) {
    selectedValues.delete(value);
  } else {
    selectedValues.add(value);
  }
  selectedAnalogFilterValuesByColumn.set(column, selectedValues);
  analogVisibleLimit = 200;
  renderAnalogRowsNow();
});

analogsModal.addEventListener("change", (event) => {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || !input.dataset.analogFilterRange || !input.dataset.analogFilterColumn) {
    return;
  }
  analogFilterRangesByColumn.set(input.dataset.analogFilterColumn, {
    ...getAnalogFilterRange(input.dataset.analogFilterColumn),
    [input.dataset.analogFilterRange]: input.value,
  });
  analogVisibleLimit = 200;
  renderAnalogRowsNow();
});

analogFiltersReset.addEventListener("click", () => {
  selectedAnalogFilterValuesByColumn.clear();
  analogFilterRangesByColumn.clear();
  analogVisibleLimit = 200;
  renderAnalogRowsNow();
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

const hideTabContextMenu = (restoreFocus = false) => {
  tabContextMenu.hidden = true;
  contextMenuTabId = null;
  if (restoreFocus && contextMenuTabAnchor?.isConnected) {
    contextMenuTabAnchor.focus();
  }
  contextMenuTabAnchor = null;
};

const showTabContextMenu = (tabId, clientX, clientY, anchor) => {
  contextMenuTabId = tabId;
  contextMenuTabAnchor = anchor;
  tabContextMenu.hidden = false;
  const bounds = tabContextMenu.getBoundingClientRect();
  tabContextMenu.style.left = `${Math.max(8, Math.min(clientX, window.innerWidth - bounds.width - 8))}px`;
  tabContextMenu.style.top = `${Math.max(8, Math.min(clientY, window.innerHeight - bounds.height - 8))}px`;
  renameTabButton.focus();
};

const renameTab = (tabId) => {
  const tab = searchTabs.find((item) => item.id === tabId);
  if (!tab) {
    return;
  }
  const index = searchTabs.indexOf(tab);
  const defaultName = tab.article || `Новый поиск ${index + 1}`;
  const name = window.prompt("Введите название вкладки", tab.name || defaultName);
  if (name === null) {
    return;
  }
  tab.name = normalizeTabName(name);
  renderTabs();
  saveSearchState();
};

searchTabsList.addEventListener("contextmenu", (event) => {
  const tab = event.target.closest("[data-tab-id]");
  if (!tab) {
    return;
  }
  event.preventDefault();
  showTabContextMenu(tab.dataset.tabId, event.clientX, event.clientY, tab);
});

searchTabsList.addEventListener("keydown", (event) => {
  if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) {
    return;
  }
  const tab = event.target.closest("[data-tab-id]");
  if (!tab) {
    return;
  }
  event.preventDefault();
  const bounds = tab.getBoundingClientRect();
  showTabContextMenu(tab.dataset.tabId, bounds.left + 16, bounds.top + 16, tab);
});

renameTabButton.addEventListener("click", () => {
  const tabId = contextMenuTabId;
  hideTabContextMenu();
  if (tabId) {
    renameTab(tabId);
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
supplierVisibilityInputs.forEach((input) => {
  input.addEventListener("change", () => {
    if (input.checked) {
      visibleSuppliers.add(input.value);
    } else {
      visibleSuppliers.delete(input.value);
      analogSearchSuppliers = analogSearchSuppliers.filter(isSupplierVisible);
    }
    updateSupplierVisibility(input.value);
    updateSupplierNotice({ supplier: input.value, authorized: Boolean(supplierSessionStates.get(input.value)) });
    saveSupplierVisibility();
    syncActiveTab();
    saveSearchState();
    renderResults();
    if (!analogsModal.hidden) {
      renderAnalogRowsNow();
      if (!analogSearchSuppliers.length && analogSearchSources.size) {
        analogSearchSources.forEach((source) => source.close());
        analogSearchSources = new Set();
        analogSearchCompleted = true;
        setAnalogSearchStatus("Поиск аналогов остановлен", "Включите хотя бы одного поставщика, поддерживающего поиск аналогов, в настройках.", "empty");
      } else {
        updateAnalogSearchProgress();
      }
    }
  });
});
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

stpartsWarehouseInputs.forEach((input) => {
  input.addEventListener("change", () => {
    const selectedColors = stpartsWarehouseInputs
      .filter((candidate) => candidate.checked)
      .map((candidate) => candidate.value);
    visibleStpartsWarehouses = new Set(normalizeStpartsWarehouseColors(selectedColors));
    updateStpartsWarehouseInputs();
    saveStpartsWarehouses();
    renderResults();
    renderAnalogRows();
  });
});

armtekNonReturnableInput.addEventListener("change", () => {
  showArmtekNonReturnable = armtekNonReturnableInput.checked;
  saveArmtekNonReturnable();
  renderResults();
  renderAnalogRows();
});

partKomNonReturnableInput.addEventListener("change", () => {
  showPartKomNonReturnable = partKomNonReturnableInput.checked;
  savePartKomNonReturnable();
  renderResults();
  renderAnalogRows();
});

forumAutoNonReturnableInput.addEventListener("change", () => {
  showForumAutoNonReturnable = forumAutoNonReturnableInput.checked;
  saveForumAutoNonReturnable();
  renderResults();
  renderAnalogRows();
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

const hideResultContextMenu = (restoreFocus = false) => {
  resultContextMenu.hidden = true;
  contextMenuResult = null;
  if (restoreFocus && contextMenuAnchor?.isConnected) {
    contextMenuAnchor.focus();
  }
  contextMenuAnchor = null;
};

const showResultContextMenu = (result, clientX, clientY, anchor, canShowAnalogs) => {
  contextMenuResult = result;
  contextMenuAnchor = anchor;
  showAnalogsButton.hidden = !canShowAnalogs;
  resultContextMenu.hidden = false;
  const bounds = resultContextMenu.getBoundingClientRect();
  resultContextMenu.style.left = `${Math.max(8, Math.min(clientX, window.innerWidth - bounds.width - 8))}px`;
  resultContextMenu.style.top = `${Math.max(8, Math.min(clientY, window.innerHeight - bounds.height - 8))}px`;
  openResultButton.focus();
};

const clearAnalogStatusHideTimer = () => {
  if (analogStatusHideTimer !== null) {
    clearTimeout(analogStatusHideTimer);
    analogStatusHideTimer = null;
  }
};

const setAnalogSearchStatus = (title, description, state = "searching") => {
  clearAnalogStatusHideTimer();
  const content = document.createElement("div");
  const heading = document.createElement("strong");
  heading.textContent = title;
  content.append(heading);
  (Array.isArray(description) ? description : [description]).filter(Boolean).forEach((line) => {
    const details = document.createElement("span");
    details.textContent = line;
    content.append(details);
  });
  const children = [content];
  if (state === "searching") {
    const spinner = document.createElement("span");
    spinner.className = "analogs-search-status__spinner";
    spinner.setAttribute("aria-hidden", "true");
    children.unshift(spinner);
  }
  analogsSearchStatus.replaceChildren(...children);
  analogsSearchStatus.dataset.state = state;
  analogsSearchStatus.hidden = false;
};

const hideSuccessfulAnalogStatus = () => {
  analogStatusHideTimer = setTimeout(() => {
    analogStatusHideTimer = null;
    analogsSearchStatus.hidden = true;
  }, 5_000);
};

const formatAnalogResultSuppliers = () => analogSearchSuppliers
  .filter((supplier) => analogResultCounts[supplier])
  .map((supplier) => `${supplierNames[supplier] ?? supplier}: ${analogResultCounts[supplier]}`)
  .join(", ");

const updateAnalogSearchProgress = () => {
  const receivedFrom = formatAnalogResultSuppliers();
  const awaiting = analogSearchSources.size
    ? `Получаем аналоги: выполняется ${analogSearchSources.size} ${analogSearchSources.size === 1 ? "запрос" : "запроса"}.`
    : "Все поставщики ответили. Завершаем обработку результатов.";
  const received = receivedFrom
    ? `Выдали аналоги: ${receivedFrom}.`
    : "Пока ни один поставщик не выдал аналогов.";
  setAnalogSearchStatus(awaiting, received);
};

const scheduleAnalogRowsRender = () => {
  if (analogRenderFrame !== null) {
    return;
  }
  analogRenderFrame = requestAnimationFrame(() => {
    analogRenderFrame = null;
    renderAnalogRows();
  });
};

const renderAnalogRowsNow = () => {
  if (analogRenderFrame !== null) {
    cancelAnimationFrame(analogRenderFrame);
    analogRenderFrame = null;
  }
  renderAnalogRows();
};

const closeAnalogsModal = () => {
  analogSearchSources.forEach((source) => source.close());
  analogSearchSources = new Set();
  clearAnalogStatusHideTimer();
  if (analogRenderFrame !== null) {
    cancelAnimationFrame(analogRenderFrame);
    analogRenderFrame = null;
  }
  analogsModal.hidden = true;
  if (analogModalReturnFocus?.isConnected) {
    analogModalReturnFocus.focus();
  } else if (analogReturnResult) {
    const resultIndex = results.indexOf(analogReturnResult);
    resultsBody.querySelector(`[data-result-index="${resultIndex}"]`)?.focus();
  }
  analogModalReturnFocus = null;
  analogReturnResult = null;
};

const renderAnalogSource = (result) => {
  analogsSourceBrand.textContent = formatBrand(result.brand);
  analogsSourceArticle.textContent = formatArticle(result.article);
  analogsSourceTitle.textContent = result.title;
  analogsSourceTitle.title = result.title;
  analogsSourceSupplier.textContent = supplierNames[result.supplier] ?? result.supplier;
  analogsSourcePrice.textContent = formatPrice(result.price);
  analogsSourceMarkupPrice.textContent = formatPrice(getMarkupPrice(result));
  analogsSourceDelivery.textContent = result.supplier === "mladov" && !result.deliveryDate
    ? "-"
    : formatDeliveryDate(result.deliveryDate, result.deliveryDateApproximate, result.deliveryDateTo);
  analogsSourceWarehouse.textContent = formatWarehouse(result.warehouse);
  analogsSourceWarehouse.title = formatWarehouse(result.warehouse);
};

const renderArticleAnalogSource = (article, brand) => {
  analogsSourceBrand.textContent = formatBrand(brand);
  analogsSourceArticle.textContent = formatArticle(article);
  analogsSourceTitle.textContent = "Поиск аналогов по выбранному бренду";
  analogsSourceTitle.title = "Поиск аналогов по выбранному бренду";
  analogsSourceSupplier.textContent = "Выбранный бренд";
  analogsSourcePrice.textContent = "-";
  analogsSourceMarkupPrice.textContent = "-";
  analogsSourceDelivery.textContent = "-";
  analogsSourceWarehouse.textContent = "-";
  analogsSourceWarehouse.title = "";
};

const updateAnalogSortHeaders = () => {
  analogSortButtons.forEach((button) => {
    const isActive = button.dataset.analogSortKey === analogSortState.key;
    button.classList.toggle("is-active", isActive);
    button.closest("th").setAttribute("aria-sort", isActive ? analogSortState.direction : "none");
  });
};

const getVisibleAnalogTableColumns = () => analogTableColumnIds.filter((column) => column !== "purchasePrice" || showPurchasePrices);

const applyAnalogTableColumns = () => {
  const visibleColumns = getVisibleAnalogTableColumns();
  const minimumWidth = visibleColumns.reduce((width, column) => width + analogTableColumnWidths[column], 0);
  const analogsTable = analogsResultsBody.closest("table");
  analogsTable.style.setProperty("--analogs-results-table-min-width", `${minimumWidth}px`);
  analogsTable.querySelectorAll("th[data-analog-column]").forEach((header) => {
    header.style.width = visibleColumns.includes(header.dataset.analogColumn)
      ? `${analogTableColumnWidths[header.dataset.analogColumn] / minimumWidth * 100}%`
      : "";
  });
  analogsTable.querySelectorAll("[data-analog-column]").forEach((element) => {
    const visible = visibleColumns.includes(element.dataset.analogColumn);
    element.hidden = !visible;
    element.style.display = visible ? "" : "none";
  });
  analogsModal.querySelectorAll('.analogs-source [data-analog-column="purchasePrice"]').forEach((element) => {
    element.hidden = !showPurchasePrices;
  });
};

const renderAnalogRows = () => {
  hideWarehouseTooltip();
  applyAnalogTableColumns();
  const focusedResultIndex = analogsResultsBody.contains(document.activeElement)
    ? document.activeElement.closest("[data-analog-result-index]")?.dataset.analogResultIndex
    : null;
  const normalizedTerm = analogSearchTerm.trim().toLocaleLowerCase();
  const visibleResults = getVisibleAnalogResults(analogSearchResults);
  const filteredResults = getFilteredAnalogResults(visibleResults);
  const rows = [...filteredResults].sort((left, right) => compareResults(left, right, analogSortState));
  const bestPrice = filteredResults
    .filter((result) => Number.isFinite(result.price) && result.price > 0)
    .reduce((best, result) => !best || result.price < best.price ? result : best, null);
  const hasActiveAnalogFilters = mainFilterColumns.some((column) => hasActiveAnalogFilter(column));
  analogsCount.textContent = normalizedTerm || hasActiveAnalogFilters ? `${rows.length} из ${visibleResults.length}` : String(visibleResults.length);
  analogsCount.title = normalizedTerm || hasActiveAnalogFilters ? "Показано с учетом поиска и фильтров" : "Всего найдено";
  const supplierBreakdown = analogSearchSuppliers
    .map((supplier) => `${supplierNames[supplier] ?? supplier}: ${rows.filter((result) => result.supplier === supplier).length} позиций`)
    .join("\n");
  analogsCount.dataset.tooltip = supplierBreakdown;
  analogsCount.setAttribute("aria-label", supplierBreakdown ? `По поставщикам:\n${supplierBreakdown}` : "Нет аналогов");
  updateAnalogSortHeaders();
  renderAnalogFilterValues();

  if (!rows.length) {
    const message = normalizedTerm && analogSearchResults.length
      ? "По вашему запросу ничего не найдено"
      : analogSearchSources.size
        ? "Предложения появятся здесь по мере получения"
      : "Аналоги для выбранной позиции не найдены";
    analogsResultsBody.innerHTML = `<tr class="analogs-results__empty"><td colspan="${showPurchasePrices ? 9 : 8}">${message}</td></tr>`;
    analogsShowMore.hidden = true;
    return;
  }

  const displayedRows = rows.slice(0, analogVisibleLimit);
  analogsShowMore.hidden = displayedRows.length >= rows.length;
  analogsShowMore.textContent = analogSearchCompleted
    ? `Показать всё (показано ${displayedRows.length} из ${rows.length})`
    : `Показать ещё ${Math.min(200, rows.length - displayedRows.length)} (показано ${displayedRows.length} из ${rows.length})`;
  analogsResultsBody.innerHTML = displayedRows.map((result) => {
    const deliveryDate = formatDeliveryDate(result.deliveryDate, result.deliveryDateApproximate, result.deliveryDateTo);
    const isBestPrice = result === bestPrice;
    return `
      <tr class="results-table__row analogs-result-row${isBestPrice ? " is-best-price" : ""}" data-analog-result-index="${analogSearchResults.indexOf(result)}" tabindex="0" aria-label="Действия для ${escapeHtml(result.title)}">
        <td data-analog-column="supplier">${escapeHtml(supplierNames[result.supplier] ?? result.supplier)}</td>
        <td data-analog-column="brand">${escapeHtml(formatBrand(result.brand))}</td>
        <td data-analog-column="article">${escapeHtml(formatArticle(result.article))}</td>
        <td class="analogs-result-title" data-analog-column="title" title="${escapeHtml(result.title)}">${escapeHtml(result.title)}</td>
        <td data-analog-column="quantity">${escapeHtml(formatQuantity(result.quantity))}</td>
        <td data-analog-column="warehouse">${renderWarehouse(result)}</td>
        <td data-analog-column="purchasePrice"${showPurchasePrices ? "" : " hidden"}><span class="analogs-result-price">${escapeHtml(formatPrice(result.price))}</span></td>
        <td data-analog-column="markupPrice"><span class="analogs-result-price">${escapeHtml(formatPrice(getMarkupPrice(result)))}</span>${isBestPrice ? '<span class="analogs-best-price">Лучшая цена</span>' : ""}</td>
        <td data-analog-column="deliveryDate">${escapeHtml(deliveryDate)}</td>
      </tr>`;
  }).join("");
  applyAnalogTableColumns();
  if (focusedResultIndex !== null) {
    analogsResultsBody.querySelector(`[data-analog-result-index="${focusedResultIndex}"]`)?.focus();
  }
};

const finishAnalogSearch = (failureMessages) => {
  if (analogSearchSources.size) {
    return;
  }
  analogSearchCompleted = true;
  renderAnalogRowsNow();
  setAnalogFiltersSidebarOpen(true);
  const receivedFrom = formatAnalogResultSuppliers();
  const received = receivedFrom ? `Выдали аналоги: ${receivedFrom}.` : "Поставщики не выдали аналогов.";
  if (failureMessages.size) {
    setAnalogSearchStatus("Поиск завершен не полностью", [received, ...failureMessages], "warning");
  } else if (analogSearchResults.length) {
    setAnalogSearchStatus("Поиск аналогов завершен", received, "completed");
    hideSuccessfulAnalogStatus();
  } else {
    setAnalogSearchStatus("Аналоги не найдены", "Попробуйте выбрать другой бренд.", "empty");
  }
};

const completeAnalogSearchSource = (source, failureMessages) => {
  source.close();
  analogSearchSources.delete(source);
  finishAnalogSearch(failureMessages);
};

const getAnalogResultKey = (result) => JSON.stringify([
  result.supplier,
  result.brand,
  result.article,
  result.title,
  result.price,
  result.quantity,
  result.warehouse,
  result.deliveryDate,
  result.deliveryDateTo,
]);

const startAnalogSearchForQuery = ({ article, brands, sourceResult, returnFocus = document.activeElement }) => {
  analogSearchSources.forEach((source) => source.close());
  analogSearchSources = new Set();
  const selectedBrands = [...new Set(brands.map((brand) => brand.trim()).filter(Boolean))];
  analogModalReturnFocus = returnFocus;
  analogReturnResult = sourceResult;
  analogSourceResult = sourceResult;
  analogSearchResults = [];
  analogSearchResultKeys = new Set();
  selectedAnalogFilterValuesByColumn.clear();
  analogFilterRangesByColumn.clear();
  analogSearchTerm = "";
  analogSortState = { key: "price", direction: "ascending" };
  analogSearchSuppliers = analogSupplierIds.filter(isSupplierVisible);
  analogSupplierStatuses = {};
  analogResultCounts = {};
  analogVisibleLimit = 200;
  analogSearchCompleted = false;
  setAnalogFiltersSidebarOpen(false);
  clearAnalogStatusHideTimer();
  analogsTableSearch.value = "";
  analogsMarkupPercent.value = String(markupPercent);
  if (sourceResult) {
    renderAnalogSource(sourceResult);
  } else {
    renderArticleAnalogSource(article, selectedBrands.join(", "));
  }
  analogsModal.hidden = false;
  analogsModal.focus();
  if (!analogSearchSuppliers.length || !selectedBrands.length) {
    renderAnalogRowsNow();
    setAnalogSearchStatus("Поиск аналогов недоступен", "Включите хотя бы одного поставщика, поддерживающего поиск аналогов, в настройках.", "empty");
    return;
  }

  setAnalogSearchStatus(
    "Подготавливаем поиск аналогов",
    `Запрашиваем бренды: ${selectedBrands.join(", ")}.`,
  );

  const failureMessages = new Set();
  selectedBrands.forEach((brand) => {
    const searchParams = new URLSearchParams({ stream: "once", mode: "analogs", article, brand });
    analogSearchSuppliers.forEach((supplier) => searchParams.append("supplier", supplier));
    const source = openSearchStream(`/api/search?${searchParams.toString()}`);
    analogSearchSources.add(source);
    source.onmessage = (messageEvent) => {
      if (!analogSearchSources.has(source)) {
        return;
      }
      const payload = JSON.parse(messageEvent.data);
      if (payload.type === "result") {
        const resultKey = getAnalogResultKey(payload.result);
        if (analogSearchResultKeys.has(resultKey)) {
          return;
        }
        analogSearchResultKeys.add(resultKey);
        analogSearchResults.push(payload.result);
        analogResultCounts[payload.result.supplier] = (analogResultCounts[payload.result.supplier] ?? 0) + 1;
        scheduleAnalogRowsRender();
        updateAnalogSearchProgress();
        return;
      }
      if (payload.type === "supplier_status") {
        analogSupplierStatuses[payload.supplier] = payload.status;
        if (["timeout", "auth_error", "error"].includes(payload.status)) {
          const supplierName = supplierNames[payload.supplier] ?? payload.supplier;
          const failureMessage = payload.status === "auth_error"
            ? `Подключите ${supplierName} в настройках и повторите поиск.`
            : payload.status === "timeout"
              ? `${supplierName} не ответил вовремя. Повторите поиск позже.`
              : `${supplierName} не удалось выполнить поиск аналогов.`;
          failureMessages.add(failureMessage);
        }
        updateAnalogSearchProgress();
        return;
      }
      if (payload.type === "search_completed") {
        completeAnalogSearchSource(source, failureMessages);
        return;
      }
      if (payload.type === "fatal_error") {
        failureMessages.add(payload.message);
        completeAnalogSearchSource(source, failureMessages);
      }
    };
    source.onerror = () => {
      if (!analogSearchSources.has(source)) {
        return;
      }
      failureMessages.add("Не удалось получить полный результат поиска аналогов.");
      completeAnalogSearchSource(source, failureMessages);
    };
  });
  renderAnalogRows();
  updateAnalogSearchProgress();
};

const startAnalogSearch = (result, returnFocus = document.activeElement) => {
  startAnalogSearchForQuery({
    article: result.article,
    brands: [result.brand],
    sourceResult: result,
    returnFocus,
  });
};

const startArticleAnalogSearch = (article, brands, returnFocus = document.activeElement) => {
  startAnalogSearchForQuery({ article, brands, sourceResult: null, returnFocus });
};

const closeArticleAnalogsModal = (restoreFocus = true) => {
  articleBrandSearchSource?.close();
  articleBrandSearchSource = null;
  articleAnalogsModal.hidden = true;
  if (restoreFocus && articleBrandModalReturnFocus?.isConnected) {
    articleBrandModalReturnFocus.focus();
  }
  articleBrandModalReturnFocus = null;
};

const setArticleAnalogsModalStatus = (message, visible = true) => {
  articleAnalogsModalStatus.textContent = message;
  articleAnalogsModalStatus.hidden = !visible;
};

const renderArticleBrandCandidates = () => {
  const brands = [...articleBrandCandidates].sort((left, right) => resultCollator.compare(left, right));
  if (!brands.length) {
    closeArticleAnalogsModal();
    return;
  }

  articleAnalogsModalBrands.replaceChildren();
  brands.forEach((brand) => {
    const label = document.createElement("label");
    const input = document.createElement("input");
    const text = document.createElement("span");
    input.type = "checkbox";
    input.value = brand;
    input.className = "article-analogs-modal__brand-input";
    text.textContent = brand;
    label.append(input, text);
    articleAnalogsModalBrands.append(label);
  });
  articleAnalogsModalBrand.hidden = false;
  articleAnalogsModalContinue.hidden = false;
  articleAnalogsModalContinue.disabled = true;
  setArticleAnalogsModalStatus("Выберите один или несколько брендов для продолжения поиска по аналогам.");
};

const openArticleAnalogsModal = (tab, returnFocus = document.activeElement) => {
  articleBrandSearchSource?.close();
  articleBrandSearchSource = null;
  articleBrandModalReturnFocus = returnFocus;
  articleBrandArticle = tab.article;
  articleBrandCandidates = new Set();
  articleAnalogsModalDescription.textContent = `По артикулу ${formatArticle(articleBrandArticle)} точных предложений не найдено.`;
  articleAnalogsModalBrand.hidden = true;
  articleAnalogsModalBrands.replaceChildren();
  articleAnalogsModalContinue.hidden = true;
  articleAnalogsModalContinue.disabled = true;
  setArticleAnalogsModalStatus("Ищем бренды по артикулу…");
  articleAnalogsModal.hidden = false;
  articleAnalogsModal.focus();
  startArticleBrandSearch();
};

const startArticleBrandSearch = () => {
  const tab = getActiveTab();
  const suppliers = analogSupplierIds.filter((supplier) => tab?.enabledSuppliers.includes(supplier) && isSupplierVisible(supplier));
  if (!tab || !articleBrandArticle || !suppliers.length) {
    setArticleAnalogsModalStatus("Включите хотя бы одного API-поставщика, поддерживающего поиск аналогов, и повторите поиск.");
    return;
  }

  articleBrandCandidates = new Set();
  articleAnalogsModalBrand.hidden = true;
  articleAnalogsModalContinue.hidden = true;
  setArticleAnalogsModalStatus("Ищем бренды по артикулу…");
  const searchParams = new URLSearchParams({ stream: "once", mode: "brands", article: articleBrandArticle });
  suppliers.forEach((supplier) => searchParams.append("supplier", supplier));
  const source = openSearchStream(`/api/search?${searchParams.toString()}`);
  articleBrandSearchSource = source;

  source.onmessage = (messageEvent) => {
    if (articleBrandSearchSource !== source) {
      return;
    }
    const payload = JSON.parse(messageEvent.data);
    if (payload.type === "brand_candidates" && Array.isArray(payload.brands)) {
      payload.brands.forEach((brand) => {
        if (typeof brand === "string" && brand.trim()) {
          articleBrandCandidates.add(brand.trim());
        }
      });
      return;
    }
    if (payload.type === "search_completed") {
      source.close();
      articleBrandSearchSource = null;
      renderArticleBrandCandidates();
      return;
    }
    if (payload.type === "fatal_error") {
      source.close();
      articleBrandSearchSource = null;
      setArticleAnalogsModalStatus("Не удалось выполнить поиск брендов. Повторите попытку позже.");
    }
  };
  source.onerror = () => {
    if (articleBrandSearchSource !== source) {
      return;
    }
    source.close();
    articleBrandSearchSource = null;
    setArticleAnalogsModalStatus("Соединение с поиском брендов прервано. Повторите попытку позже.");
  };
};

const registerResultContextMenu = (body, resolveResult, canShowAnalogs) => {
  body.addEventListener("contextmenu", (event) => {
    const row = event.target.closest(".results-table__row");
    const result = row ? resolveResult(row) : null;
    if (!result) {
      return;
    }
    event.preventDefault();
    showResultContextMenu(result, event.clientX, event.clientY, row, canShowAnalogs);
  });

  body.addEventListener("keydown", (event) => {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) {
      return;
    }
    const row = event.target.closest(".results-table__row");
    const result = row ? resolveResult(row) : null;
    if (!result) {
      return;
    }
    event.preventDefault();
    const bounds = row.getBoundingClientRect();
    showResultContextMenu(result, bounds.left + 16, bounds.top + 16, row, canShowAnalogs);
  });
};

registerResultContextMenu(resultsBody, (row) => results[Number(row.dataset.resultIndex)], true);
registerResultContextMenu(analogsResultsBody, (row) => analogSearchResults[Number(row.dataset.analogResultIndex)], false);

openResultButton.addEventListener("click", () => {
  const link = getSafeResultLink(contextMenuResult?.link);
  hideResultContextMenu();
  if (link) {
    window.open(link, "_blank", "noreferrer");
  }
});

showAnalogsButton.addEventListener("click", () => {
  const result = contextMenuResult;
  const anchor = contextMenuAnchor;
  hideResultContextMenu();
  if (result) {
    startAnalogSearch(result, anchor);
  }
});

analogsTableSearch.addEventListener("input", () => {
  analogSearchTerm = analogsTableSearch.value;
  analogVisibleLimit = 200;
  renderAnalogRowsNow();
});

analogsMarkupPercent.addEventListener("change", () => {
  setMarkupPercent(analogsMarkupPercent.value);
  analogsMarkupPercent.value = String(markupPercent);
  if (analogSourceResult) {
    renderAnalogSource(analogSourceResult);
  }
  renderAnalogRowsNow();
});

analogSortButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const key = button.dataset.analogSortKey;
    analogSortState = {
      key,
      direction: analogSortState.key === key && analogSortState.direction === "ascending" ? "descending" : "ascending",
    };
    analogVisibleLimit = 200;
    renderAnalogRowsNow();
  });
});

analogsShowMore.addEventListener("click", () => {
  analogVisibleLimit = analogSearchCompleted ? Number.POSITIVE_INFINITY : analogVisibleLimit + 200;
  renderAnalogRowsNow();
});

closeAnalogsModalButtons.forEach((button) => button.addEventListener("click", closeAnalogsModal));
closeArticleAnalogsModalButtons.forEach((button) => button.addEventListener("click", () => closeArticleAnalogsModal()));
articleAnalogsModalBrands.addEventListener("change", () => {
  articleAnalogsModalContinue.disabled = !articleAnalogsModalBrands.querySelector("input:checked");
});
articleAnalogsModalContinue.addEventListener("click", () => {
  const brands = [...articleAnalogsModalBrands.querySelectorAll("input:checked")]
    .map((input) => input.value.trim())
    .filter(Boolean);
  if (!brands.length || !articleBrandArticle) {
    return;
  }
  const returnFocus = articleBrandModalReturnFocus;
  const article = articleBrandArticle;
  closeArticleAnalogsModal(false);
  startArticleAnalogSearch(article, brands, returnFocus);
});
window.addEventListener("resize", () => {
  hideResultContextMenu(true);
  hideTabContextMenu(true);
});
window.addEventListener("scroll", () => {
  hideResultContextMenu(true);
  hideTabContextMenu(true);
}, true);
window.addEventListener("resize", hideWarehouseTooltip);
window.addEventListener("scroll", hideWarehouseTooltip, true);

rosskoAuthForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setAuthCardLoading(rosskoAuthForm, true);

  try {
    const payload = await postJson("/api/suppliers/rossko/authorize", {
      key1: rosskoKey1Input.value.trim(),
      key2: rosskoKey2Input.value.trim(),
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
    clearAuthInputs(rosskoKey1Input, rosskoKey2Input);
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
      password: partKomPasswordInput.value,
    });
    handleAuthorizeResult(payload.session, "part-kom", partKomAuthFeedback, "PartKOM API отклонил авторизацию", updatePartKomSessionCard);
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

forumAutoAuthForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setAuthCardLoading(forumAutoAuthForm, true);

  try {
    const payload = await postJson("/api/suppliers/forum-auto/authorize", {
      login: forumAutoLoginInput.value.trim(),
      password: forumAutoPasswordInput.value,
    });
    handleAuthorizeResult(payload.session, "forum-auto", forumAutoAuthFeedback, "Forum-Auto API отклонил авторизацию", updateForumAutoSessionCard);
  } catch (error) {
    showAuthorizeError(forumAutoAuthFeedback, error);
  } finally {
    setAuthCardLoading(forumAutoAuthForm, false);
  }
});

forumAutoLogoutButton.addEventListener("click", async () => {
  try {
    const payload = await postJson("/api/suppliers/forum-auto/logout");
    updateForumAutoSessionCard(payload.session);
    clearAuthInputs(forumAutoLoginInput, forumAutoPasswordInput);
  } catch (error) {
    showAuthFeedback(forumAutoAuthFeedback, error.message);
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
  tab.supplierStatusDetails = {};
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
      if (typeof payload.details === "string" && payload.details.trim()) {
        tab.supplierStatusDetails[payload.supplier] = payload.details;
      }
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
      if (tab.id === activeTabId && getMainTableResults(tab.results).filteredResults.length === 0) {
        openArticleAnalogsModal(tab, submitButton);
      }
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
    showSupplierSessionCheckProgress(article);
    const canSearch = await checkSupplierSessions(article, enabledSuppliers);
    supplierCheckInProgress = false;
    if (!canSearch) {
      setSearchUiState(false);
      return;
    }
    rememberSupplierSessionsChecked();
  }

  startSearch(article, enabledSuppliers);
});

restoreSearchState();
restoreFiltersSidebarWidth();
restoreAnalogFiltersSidebarWidth();
restoreTableColumns();
restoreStpartsWarehouses();
restoreArmtekNonReturnable();
restorePartKomNonReturnable();
restoreForumAutoNonReturnable();
restoreSupplierVisibility();
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
  markupPercentInput.value = String(markupPercent);
  articleInput.value = restoredTab.article;
  globalStatus.textContent = restoredTab.status;
  supplierEnabledInputs.forEach((input) => {
    input.checked = isSupplierVisible(input.value) && restoredTab.enabledSuppliers.includes(input.value);
  });
}
supplierSearchSelectionsRestored = true;
markupPercentInput.addEventListener("change", () => {
  setMarkupPercent(markupPercentInput.value);
});
purchasePriceToggle.addEventListener("click", () => {
  setPurchasePricesVisible(!showPurchasePrices);
});
analogsPurchasePriceToggle.addEventListener("click", () => {
  setPurchasePricesVisible(!showPurchasePrices);
});

tableSearchInput.addEventListener("input", () => {
  tableSearchTerm = tableSearchInput.value;
  renderResults();
});
setSearchUiState(false);
renderTabs();
renderResults();
loadSessions().catch(() => undefined);
