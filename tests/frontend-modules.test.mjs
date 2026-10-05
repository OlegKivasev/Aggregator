import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  compareDeliveryDates,
  compareDeliveryDatesThenPrice,
  escapeHtml,
  formatArticle,
  formatBrand,
  formatPrice,
  formatQuantity,
  formatWarehouse,
  getSafeResultLink,
  renderDeliveryWarehouse,
  renderWarehouse,
} from "../src/frontend/result-formatting.js";
import { openSearchStream } from "../src/frontend/search-stream.js";
import {
  isStpartsWarehouseVisible,
  normalizeStpartsWarehouseColors,
} from "../src/frontend/stparts-warehouse-settings.js";
import { isPartKomReturnableVisible } from "../src/frontend/partkom-return-settings.js";
import { isForumAutoReturnableVisible } from "../src/frontend/forum-auto-return-settings.js";
import { isArmtekReturnableVisible } from "../src/frontend/armtek-return-settings.js";
import { applySavedColumnWidths } from "../src/frontend/table-column-widths.js";
import { formatDeliveryDate } from "../src/frontend/supplier-search-summary.js";

test("result formatting escapes untrusted text and limits result links", () => {
  assert.equal(escapeHtml('<script data-value="x">'), "&lt;script data-value=&quot;x&quot;&gt;");
  assert.equal(getSafeResultLink("javascript:alert(1)"), "");
  assert.equal(getSafeResultLink("https://supplier.test/item?id=1"), "https://supplier.test/item?id=1");
  assert.equal(formatWarehouse("  Склад   12  "), "Склад 12");
  assert.equal(formatWarehouse("Упаковка поставщика"), "-");
  assert.equal(formatPrice(1234.569), "1 234,56 ₽");
});

test("quantity formatting distinguishes real zero from missing data", () => {
  assert.equal(formatQuantity(12), "12");
  assert.equal(formatQuantity(1.5), "1,5");
  assert.equal(formatQuantity(0), "0");
  assert.equal(formatQuantity(null), "-");
  assert.equal(formatQuantity(Number.NaN), "-");
});

test("delivery date keeps the approximate marker on an interval", () => {
  assert.match(formatDeliveryDate("2026-10-07", true, "2026-10-09"), /^~07\.10\.2026 - 09\.10\.2026$/);
});

test("table column widths accept only bounded integer preferences", () => {
  const defaults = { supplier: 100, title: 320 };

  assert.deepEqual(applySavedColumnWidths(defaults, { supplier: 180, title: 700 }), { supplier: 180, title: 700 });
  assert.deepEqual(applySavedColumnWidths(defaults, { supplier: 79, title: 801 }), defaults);
});

test("brand and article formatting normalizes case consistently", () => {
  assert.equal(formatBrand("FORTLUFT"), "Fortluft");
  assert.equal(formatBrand("Fortluft"), "Fortluft");
  assert.equal(formatBrand("SHINE SYSTEMS"), "Shine systems");
  assert.equal(formatBrand("ШААЗ"), "Шааз");
  assert.equal(formatArticle("ss641"), "SS641");
  assert.equal(formatArticle("SS641"), "SS641");
  assert.equal(formatArticle("а123б"), "А123Б");
  assert.equal(formatBrand(""), "-");
  assert.equal(formatArticle(null), "-");
});

test("warehouse rendering escapes tooltip and validates supplier metadata", () => {
  const markup = renderWarehouse({
    supplier: "stparts",
    warehouse: "A-1",
    warehouseFull: 'Основной <склад> "A"',
    warehouseColor: "purple",
    warehouseRating: "<4.5",
  });

  assert.match(markup, /data-tooltip="Основной &lt;склад&gt; &quot;A&quot;"/);
  assert.doesNotMatch(markup, /warehouse-code--purple/);
  assert.match(markup, /&lt;4\.5/);
  assert.match(renderWarehouse({ supplier: "armtek", warehouse: "Основной склад" }), /data-tooltip="Основной склад"/);
  assert.equal(renderDeliveryWarehouse({ supplier: "armtek", warehouse: "Упаковка поставщика" }), "");
  assert.match(renderDeliveryWarehouse({ supplier: "armtek", warehouse: "Основной склад" }), /class="delivery-warehouse"/);
});

test("STParts warehouse settings default to green and always keep one color", () => {
  assert.deepEqual(normalizeStpartsWarehouseColors(null), ["green"]);
  assert.deepEqual(normalizeStpartsWarehouseColors([]), ["green"]);
  assert.deepEqual(normalizeStpartsWarehouseColors(["blue", "blue", "invalid"]), ["blue"]);
});

test("STParts warehouse visibility does not affect other suppliers", () => {
  const enabledColors = new Set(["green"]);

  assert.equal(isStpartsWarehouseVisible({ supplier: "stparts", warehouseColor: "green" }, enabledColors), true);
  assert.equal(isStpartsWarehouseVisible({ supplier: "stparts", warehouseColor: "red" }, enabledColors), false);
  assert.equal(isStpartsWarehouseVisible({ supplier: "armtek", warehouseColor: "red" }, enabledColors), true);
});

test("PartKOM return setting hides only confirmed non-returnable offers", () => {
  assert.equal(isPartKomReturnableVisible({ supplier: "part-kom", isReturnable: false }, false), false);
  assert.equal(isPartKomReturnableVisible({ supplier: "part-kom", isReturnable: false }, true), true);
  assert.equal(isPartKomReturnableVisible({ supplier: "part-kom" }, false), true);
  assert.equal(isPartKomReturnableVisible({ supplier: "stparts", isReturnable: false }, false), true);
});

test("Forum-Auto return setting hides only confirmed non-returnable offers", () => {
  assert.equal(isForumAutoReturnableVisible({ supplier: "forum-auto", isReturnable: false }, false), false);
  assert.equal(isForumAutoReturnableVisible({ supplier: "forum-auto", isReturnable: false }, true), true);
  assert.equal(isForumAutoReturnableVisible({ supplier: "forum-auto" }, false), true);
  assert.equal(isForumAutoReturnableVisible({ supplier: "stparts", isReturnable: false }, false), true);
});

test("Armtek return setting hides only confirmed non-returnable offers", () => {
  assert.equal(isArmtekReturnableVisible({ supplier: "armtek", isReturnable: false }, false), false);
  assert.equal(isArmtekReturnableVisible({ supplier: "armtek", isReturnable: false }, true), true);
  assert.equal(isArmtekReturnableVisible({ supplier: "armtek" }, false), true);
  assert.equal(isArmtekReturnableVisible({ supplier: "stparts", isReturnable: false }, false), true);
});

test("PartKOM return preference is rendered and applied only to regular results", async () => {
  const html = await readFile(new URL("../src/frontend/index.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/frontend/app.js", import.meta.url), "utf8");

  assert.match(html, /id="part-kom-non-returnable"/);
  assert.match(app, /autoservice\.partKomNonReturnable/);
  assert.match(app, /filterVisiblePartKomReturnable\(filterVisibleStpartsWarehouses\([\s\S]*?exactResults\.filter/);
  assert.match(app, /const getVisibleAnalogResults = \(items\) => filterVisibleArmtekReturnable\(filterVisibleForumAutoReturnable\(filterVisiblePartKomReturnable\(filterVisibleStpartsWarehouses/);
});

test("Forum-Auto return preference is rendered and applied only to regular results", async () => {
  const html = await readFile(new URL("../src/frontend/index.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/frontend/app.js", import.meta.url), "utf8");

  assert.match(html, /id="forum-auto-non-returnable"/);
  assert.match(app, /autoservice\.forumAutoNonReturnable/);
  assert.match(app, /filterVisibleForumAutoReturnable\(filterVisiblePartKomReturnable\(filterVisibleStpartsWarehouses\([\s\S]*?exactResults\.filter/);
  assert.match(app, /const getVisibleAnalogResults = \(items\) => filterVisibleArmtekReturnable\(filterVisibleForumAutoReturnable\(filterVisiblePartKomReturnable\(filterVisibleStpartsWarehouses/);
});

test("Armtek return preference is rendered and applied only to regular results", async () => {
  const html = await readFile(new URL("../src/frontend/index.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/frontend/app.js", import.meta.url), "utf8");

  assert.match(html, /id="armtek-non-returnable"/);
  assert.match(app, /autoservice\.armtekNonReturnable/);
  assert.match(app, /filterVisibleArmtekReturnable\(filterVisibleForumAutoReturnable\(filterVisiblePartKomReturnable\(filterVisibleStpartsWarehouses\([\s\S]*?exactResults\.filter/);
  assert.match(app, /const getVisibleAnalogResults = \(items\) => filterVisibleArmtekReturnable\(filterVisibleForumAutoReturnable\(filterVisiblePartKomReturnable\(filterVisibleStpartsWarehouses/);
});

test("delivery date sorting moves intervals above dates they finish before", () => {
  const today = new Date();
  const date = (offset) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset, 12).toISOString();
  const results = [
    { label: "interval tomorrow", deliveryDate: date(1), deliveryDateTo: date(2) },
    { label: "single day after tomorrow", deliveryDate: date(2) },
    { label: "later interval", deliveryDate: date(2), deliveryDateTo: date(4) },
    { label: "single tomorrow", deliveryDate: date(1) },
  ];

  assert.deepEqual(results.sort(compareDeliveryDates).map((result) => result.label), [
    "single tomorrow",
    "single day after tomorrow",
    "interval tomorrow",
    "later interval",
  ]);
});

test("delivery date sorting groups nearby, dated and interval deliveries", () => {
  const today = new Date();
  const date = (offset) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset, 12).toISOString();
  const results = [
    { label: "interval tomorrow", deliveryDate: date(1), deliveryDateTo: date(3), deliveryDateApproximate: false },
    { label: "approximate dated", deliveryDate: date(4), deliveryDateApproximate: true },
    { label: "approximate today", deliveryDate: date(0), deliveryDateApproximate: true },
    { label: "known dated", deliveryDate: date(5), deliveryDateApproximate: false },
    { label: "approximate day after tomorrow", deliveryDate: date(2), deliveryDateApproximate: true },
    { label: "known day after tomorrow", deliveryDate: date(2), deliveryDateApproximate: false },
    { label: "approximate tomorrow", deliveryDate: date(1), deliveryDateApproximate: true },
    { label: "known tomorrow", deliveryDate: date(1), deliveryDateApproximate: false },
    { label: "known today", deliveryDate: date(0), deliveryDateApproximate: false },
  ];

  assert.deepEqual(results.sort(compareDeliveryDates).map((result) => result.label), [
    "known today",
    "approximate today",
    "known tomorrow",
    "approximate tomorrow",
    "known day after tomorrow",
    "approximate day after tomorrow",
    "interval tomorrow",
    "approximate dated",
    "known dated",
  ]);
});

test("delivery date sorting treats same-day end as a single date", () => {
  const today = new Date();
  const dayAfterTomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 2, 12).toISOString();
  const later = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 3, 12).toISOString();
  const results = [
    { label: "later date", deliveryDate: later, deliveryDateApproximate: false },
    { label: "same-day poslezavtra", deliveryDate: dayAfterTomorrow, deliveryDateTo: dayAfterTomorrow, deliveryDateApproximate: false },
  ];

  assert.deepEqual(results.sort(compareDeliveryDates).map((result) => result.label), [
    "same-day poslezavtra",
    "later date",
  ]);
});

test("delivery date sorting moves intervals above dates they can arrive before", () => {
  const today = new Date();
  const date = (offset) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset, 12).toISOString();
  const results = [
    { label: "single July 30", deliveryDate: date(5), deliveryDateApproximate: false },
    { label: "interval starting July 28", deliveryDate: date(2), deliveryDateTo: date(3), deliveryDateApproximate: false },
    { label: "approximate July 30", deliveryDate: date(5), deliveryDateApproximate: true },
  ];

  assert.deepEqual(results.sort(compareDeliveryDates).map((result) => result.label), [
    "interval starting July 28",
    "single July 30",
    "approximate July 30",
  ]);
});

test("delivery date sorting places an interval starting on the 29th above the 30th", () => {
  const today = new Date();
  const date = (offset) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset, 12).toISOString();
  const results = [
    { label: "single 30th", deliveryDate: date(3), deliveryDateApproximate: false },
    { label: "interval 29th to 30th", deliveryDate: date(2), deliveryDateTo: date(3), deliveryDateApproximate: false },
  ];

  assert.deepEqual(results.sort(compareDeliveryDates).map((result) => result.label), [
    "interval 29th to 30th",
    "single 30th",
  ]);
});

test("delivery date sorting preserves delivery groups and uses price within one group", () => {
  const today = new Date();
  const date = (offset) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset, 12).toISOString();
  const results = [
    { label: "expensive interval", deliveryDate: date(2), deliveryDateTo: date(4), price: 4500 },
    { label: "approximate day after tomorrow", deliveryDate: date(2), deliveryDateApproximate: true, price: 1000 },
    { label: "known day after tomorrow", deliveryDate: date(2), price: 1900 },
    { label: "cheap interval", deliveryDate: date(2), deliveryDateTo: date(3), price: 1200 },
  ];

  assert.deepEqual(results.sort(compareDeliveryDatesThenPrice).map((result) => result.label), [
    "known day after tomorrow",
    "approximate day after tomorrow",
    "cheap interval",
    "expensive interval",
  ]);
});

test("frontend opens on-demand analog search for a selected result", async () => {
  const html = await readFile(new URL("../src/frontend/index.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/frontend/app.js", import.meta.url), "utf8");

  assert.match(html, /id="result-context-menu"/);
  assert.doesNotMatch(html, /id="open-result-button"/);
  assert.match(html, /id="search-result-button"[\s\S]*?id="show-analogs-button"/);
  assert.match(html, /id="show-analogs-button"/);
  assert.match(html, /id="analogs-modal"/);
  assert.match(html, /id="analogs-source-title"/);
  assert.match(html, /id="analogs-source-markup-price"/);
  assert.match(html, /id="analogs-table-search"/);
  assert.match(html, /id="analogs-markup-percent"/);
  assert.doesNotMatch(html, /id="analogs-purchase-price-toggle"/);
  assert.match(html, /id="analogs-filters-toggle"[^>]*aria-controls="analogs-filters-sidebar"[^>]*aria-expanded="true"/);
  assert.match(html, /id="analogs-filters-sidebar"/);
  assert.match(html, /data-analog-filter-section="supplier"[\s\S]*?data-analog-filter-section="brand"[\s\S]*?data-analog-filter-section="article"[\s\S]*?data-analog-filter-section="warehouse"[\s\S]*?data-analog-filter-section="markupPrice"[\s\S]*?data-analog-filter-section="deliveryDate"/);
  assert.match(html, /data-analog-sort-key="markupPrice"/);
  assert.match(html, /id="analogs-results-body"/);
  assert.match(html, /id="analogs-search-loading"[^>]*role="status"[^>]*hidden/);
  assert.match(html, /id="analogs-show-more"/);
  assert.match(html, /id="analogs-count" tabindex="0"/);
  assert.equal((html.match(/id="results-body"/g) ?? []).length, 1);
  assert.doesNotMatch(html, /id="results-view-toggle"/);
  assert.match(app, /registerResultContextMenu\(resultsBody/);
  assert.match(app, /registerResultContextMenu\(analogsResultsBody/);
  assert.match(app, /const setAnalogFiltersSidebarOpen = \(open\) =>/);
  assert.match(app, /const setAnalogSearchUiState = \(isSearching\) =>/);
  assert.match(app, /analogsSearchLoading\.hidden = !isSearching;/);
  assert.match(app, /analogsResults\.hidden = isSearching;/);
  assert.match(app, /setAnalogSearchUiState\(true\);/);
  assert.match(app, /setAnalogSearchUiState\(false\);/);
  assert.match(app, /analogSearchCompleted = false;\s+setAnalogSearchUiState\(false\);\s+setAnalogFiltersSidebarOpen\(false\);/s);
  assert.match(app, /analogSearchCompleted = true;\s+setAnalogSearchUiState\(false\);\s+renderAnalogRowsNow\(\);\s+setAnalogFiltersSidebarOpen\(true\);/s);
  assert.match(app, /renderAveragePrices\(container, getFilteredAnalogResults\(visibleResults\)\);/);
  assert.doesNotMatch(app, /renderAveragePrices\(container, getFilteredAnalogResults\(visibleResults\), showPurchasePrices\)/);
  assert.match(app, /analogFiltersToggle\.addEventListener\("click", \(\) => setAnalogFiltersSidebarOpen\(analogFiltersSidebar\.hidden\)\)/);
  assert.match(app, /analogFiltersResize\.releasePointerCapture\(event\.pointerId\);\s+setAnalogFiltersSidebarOpen\(false\);/s);
  assert.match(app, /class="analogs-result-purchase-price"/);
  assert.doesNotMatch(app, /data-show-row-analogs/);
  assert.match(app, /const renderOfferLink = \(result, text, title = text\) =>/);
  assert.doesNotMatch(app, /openResultButton\.addEventListener/);
  assert.match(app, /analogsTableSearch\.addEventListener\("input"/);
  assert.match(app, /analogSortButtons\.forEach/);
  assert.match(app, /analogs-best-price/);
  assert.match(app, /mode: "analogs"/);
  assert.match(app, /article: result\.article/);
  assert.match(app, /brands: \[result\.brand\]/);
  assert.match(app, /formatBrand\(result\.brand\)/);
  assert.match(app, /formatArticle\(result\.article\)/);
  assert.match(app, /const analogSupplierIds = \["rossko", "armtek", "part-kom", "stparts", "forum-auto"\]/);
  assert.match(app, /analogSupplierIds\.filter\(isSupplierVisible\)/);
  assert.doesNotMatch(html, /id="analogs-search-status"/);
  assert.doesNotMatch(app, /setAnalogSearchStatus|updateAnalogSearchProgress/);
  assert.match(app, /searchResultButton\.addEventListener\("click"/);
  assert.match(app, /const tab = createSearchTab\(\{ article, enabledSuppliers: getEnabledSuppliers\(\) \}\);/);
  assert.match(app, /form\.requestSubmit\(\);/);
  assert.match(app, /Показать всё/);
  assert.match(app, /analogSearchCompleted \? Number\.POSITIVE_INFINITY/);
  assert.match(app, /analogsCount\.dataset\.tooltip = supplierBreakdown/);
  assert.match(app, /scheduleAnalogRowsRender/);
  assert.match(app, /const exactResults = items\.filter\(\(result\) => result\.isAnalog !== true\);/);
});

test("frontend shows purchase price below the retail price and discovers brands after an empty search", async () => {
  const html = await readFile(new URL("../src/frontend/index.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/frontend/app.js", import.meta.url), "utf8");

  assert.doesNotMatch(html, /id="purchase-price-toggle"|data-column="purchasePrice"/);
  assert.match(html, /data-column="markupPrice"[^>]*><button[^>]*data-sort-key="markupPrice">Цена/);
  assert.match(html, /table-column-input" type="checkbox" value="markupPrice" checked><span>Цена/);
  assert.doesNotMatch(html, /table-column-input" type="checkbox" value="price"/);
  assert.match(app, /let sortState = \{ key: "markupPrice", direction: "ascending" \}/);
  assert.match(app, /class="main-result-purchase-price"/);
  assert.match(app, /state\.key === "markupPrice" && comparison === 0/);
  assert.match(app, /compareDeliveryDates\(left, right\)/);
  assert.match(app, /compareDeliveryDatesThenPrice\(left, right\)/);
  assert.match(html, /id="article-analogs-modal"/);
  assert.match(html, /id="article-analogs-modal-brands"/);
  assert.match(html, /Выберите один или несколько брендов/);
  assert.doesNotMatch(html, /По этому артикулу поставщики не вернули бренды/);
  assert.doesNotMatch(html, /id="article-analogs-modal-search"/);
  assert.match(app, /mode: "brands"/);
  assert.match(app, /payload\.type === "brand_candidates"/);
  assert.match(app, /startArticleBrandSearch\(\);/);
  assert.match(app, /startArticleAnalogSearch\(article, brands/);
  assert.match(app, /input\.type = "checkbox"/);
  assert.match(app, /selectedBrands\.forEach\(\(brand\) =>/);
  assert.match(app, /let analogSearchSources = new Set\(\);/);
  assert.match(app, /const getVisibleAnalogResults = \(items\) =>/);
  assert.match(app, /const getMainTableResults = \(items\) =>/);
  assert.match(app, /getMainTableResults\(tab\.results\)\.filteredResults\.length === 0/);
  assert.match(app, /if \(!brands\.length\) \{\s+closeArticleAnalogsModal\(\);\s+return;/);
  assert.match(app, /analogSupplierIds\.filter\(\(supplier\) => tab\?\.enabledSuppliers\.includes\(supplier\)/);
});

test("frontend can hide a supplier from searches, results, and authorization settings", async () => {
  const html = await readFile(new URL("../src/frontend/index.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/frontend/app.js", import.meta.url), "utf8");

  assert.match(html, /class="supplier-visibility-input" type="checkbox" value="armtek"/);
  assert.match(html, /class="auth-card" data-supplier="armtek"/);
  assert.match(app, /const supplierVisibilityStorageKey = "autoservice\.supplierVisibility"/);
  assert.match(app, /const updateSupplierVisibility = \(supplier\)/);
  assert.match(app, /result\.isAnalog !== true\)[\s\S]*?isSupplierVisible\(result\.supplier\)/);
  assert.match(app, /analogSearchSuppliers = analogSearchSuppliers\.filter\(isSupplierVisible\);/);
});

test("frontend preserves selected search suppliers when sessions load after restart", async () => {
  const app = await readFile(new URL("../src/frontend/app.js", import.meta.url), "utf8");

  assert.match(app, /let supplierSearchSelectionsRestored = false;/);
  assert.match(app, /if \(supplierSearchSelectionsRestored\) \{\s+syncActiveTab\(\);\s+saveSearchState\(\);\s+\}/);
  assert.match(app, /supplierSearchSelectionsRestored = true;/);
  assert.doesNotMatch(app, /updateRosskoSessionCard\(rosskoSession, true\)/);
  assert.doesNotMatch(app, /updateArmtekSessionCard\(armtekSession, true\)/);
});

test("main-search filters use a compact trigger, supplier disclosure, and direct filter buttons", async () => {
  const html = await readFile(new URL("../src/frontend/index.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/frontend/app.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/frontend/styles.css", import.meta.url), "utf8");

  assert.match(html, /id="filters-toggle"[^>]*aria-controls="filters-sidebar"[^>]*aria-expanded="true"[^>]*aria-label="Скрыть фильтры"[^>]*>⋮/);
  assert.match(html, /class="filters-control"[\s\S]*?id="filters-toggle"[\s\S]*?id="filters-sidebar"/);
  assert.match(html, /id="filters-sidebar"/);
  assert.doesNotMatch(html, /id="filters-sidebar" hidden/);
  assert.doesNotMatch(html, /<h2>Фильтры<\/h2>/);
  assert.doesNotMatch(html, /id="filters-close"/);
  assert.match(html, /id="filters-suppliers"/);
  assert.match(html, /class="supplier-enabled-input" type="checkbox" value="rossko" checked/);
  assert.match(html, /<details class="filters-sidebar__section filters-sidebar__disclosure" data-filter-section="warehouse" hidden>/);
  assert.match(html, /<details class="filters-sidebar__section filters-sidebar__disclosure" data-filter-section="markupPrice" hidden>/);
  assert.match(html, /<details class="filters-sidebar__section filters-sidebar__disclosure" data-filter-section="deliveryDate" hidden>/);
  assert.match(html, /data-filter-section="supplier"[\s\S]*?data-filter-section="brand"[\s\S]*?data-filter-section="article"[\s\S]*?data-filter-section="warehouse"[\s\S]*?data-filter-section="markupPrice"[\s\S]*?data-filter-section="deliveryDate"/);
  assert.match(html, /id="filters-resize" role="separator"/);
  assert.doesNotMatch(html, /Уточнить результаты/);
  assert.match(app, /filtersResize\.addEventListener\("pointerdown"/);
  assert.match(app, /filtersToggle\.setAttribute\("aria-label", open \? "Скрыть фильтры" : "Открыть фильтры"\)/);
  assert.match(app, /button\.setAttribute\("aria-pressed", String\(selected\)\)/);
  assert.match(app, /const candidateResults = getFilteredResults\(visibleExactResults, tableSearchTerm, markupPercent, column\);/);
  assert.match(app, /const isFilterColumnVisible = \(column\) => column === "warehouse" \|\| visibleTableColumns\.has\(column\);/);
  assert.match(app, /section\.hidden = !isFilterColumnVisible\(column\) \|\| values\.length === 0;/);
  assert.match(app, /section\.hidden = !isFilterColumnVisible\(column\) \|\| !hasValues;/);
  assert.match(app, /const filtersWidthStorageKey = "autoservice\.filtersWidth\.v2"/);
  assert.match(app, /Средняя закуп\. цена/);
  assert.match(app, /Средняя цена/);
  assert.match(app, /Math\.max\(180, Math\.round\(width \/ 10\) \* 10\)/);
  assert.match(styles, /\.workspace\s*\{[^}]*grid-template-columns: auto minmax\(0, 1fr\) auto;/s);
  assert.match(styles, /\.workspace\s*\{[^}]*height: calc\(100dvh - 52px\);[^}]*overflow: hidden;/s);
  assert.match(styles, /\.filters-control:has\(\.filters-sidebar:not\(\[hidden\]\)\)\s*\{[^}]*align-items: center;/s);
  assert.match(styles, /\.filters-control:has\(\.filters-sidebar:not\(\[hidden\]\)\)\s*\{[^}]*align-self: stretch;/s);
  assert.match(styles, /\.filters-control\s*\{[^}]*align-self: stretch;[^}]*align-items: center;/s);
  assert.match(styles, /\.filters-control:has\(\.filters-sidebar:not\(\[hidden\]\)\) \.filters-toggle\s*\{[^}]*display: none;/s);
  assert.match(styles, /\.filters-sidebar\s*\{[^}]*--filters-sidebar-width: 200px;[^}]*min-width: 180px;/s);
  assert.match(styles, /\.filters-sidebar\s*\{[^}]*height: 100%;[^}]*overflow-y: auto;/s);
  assert.match(styles, /@media \(max-width: 575\.98px\)\s*\{\s*\.workspace/);
  assert.match(styles, /\.filters-suppliers\s*\{[^}]*margin-top: 0;/s);
  assert.match(styles, /\.filters-sidebar__disclosure summary\s*\{[^}]*cursor: pointer;/s);
  assert.match(styles, /\.filters-sidebar__resize\s*\{[^}]*cursor: col-resize;/s);
  assert.match(styles, /\.filters-sidebar__resize::before\s*\{[^}]*height: 72px;/s);
  assert.match(app, /const filtersCloseThresholdRatio = 0\.02;/);
  assert.match(app, /const getFiltersCloseWidth = \(sidebar\) =>/);
  assert.match(app, /filtersResize\.releasePointerCapture\(event\.pointerId\);\s+setFiltersSidebarOpen\(false\);/s);
  assert.match(styles, /\.supplier-search-toggle \.supplier-enabled-input\s*\{[^}]*clip-path: inset\(50%\);/s);
});

test("garage uses a centered car icon and mirrors the filter resize control", async () => {
  const html = await readFile(new URL("../src/frontend/index.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/frontend/app.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/frontend/styles.css", import.meta.url), "utf8");
  const garage = await readFile(new URL("../src/frontend/garage-ui.js", import.meta.url), "utf8");

  assert.match(html, /class="filters-toggle garage-toggle" id="garage-toggle" aria-controls="garage-sidebar" aria-expanded="false" aria-label="Открыть гараж"/);
  assert.match(html, /id="garage-toggle"[\s\S]*?<svg[^>]*viewBox="0 0 24 24"/);
  assert.doesNotMatch(html, /id="garage-toggle"[\s\S]*?>▣<\/button>/);
  assert.doesNotMatch(app, /garage-offer-button"[^>]*>▣<\/button>/);
  assert.match(html, /id="garage-resize" role="separator"[^>]*aria-label="Изменить ширину гаража"/);
  assert.match(html, /class="new-tab-button btn btn-light garage-create" id="garage-create"/);
  assert.match(html, /form class="garage-search-form search-row" id="garage-search-form"[\s\S]*?class="search-input" id="garage-search"/);
  assert.match(html, /id="garage-context-menu" role="menu"[\s\S]*?id="garage-rename-button"[\s\S]*?id="garage-delete-button"/);
  assert.match(html, /data-garage-column="deliveryDate"[^>]*>[\s\S]*?data-garage-sort-key="deliveryDate">Доставка/);
  assert.doesNotMatch(html, /id="open-result-button"|>Открыть предложение</);
  assert.match(html, /id="garage-add-duplicate" hidden/);
  assert.match(html, /class="garage-add-modal__header"/);
  assert.match(html, /class="garage-add-modal__input garage-add-modal__search" id="garage-add-search"/);
  assert.match(html, /class="garage-add-modal__footer"/);
  assert.doesNotMatch(html, /garage-add-modal__footer[\s\S]*?data-garage-close>Отменить/);
  assert.doesNotMatch(html, /class="garage-add-modal__backdrop" data-garage-close/);
  assert.match(styles, /\.garage-add-modal__header h2\s*\{[^}]*font-size: 17px;/s);
  assert.match(styles, /\.garage-add-modal__search\s*\{[^}]*border: 2px solid var\(--accent\);/s);
  assert.match(styles, /\.garage-add-modal__vehicle\s*\{[^}]*background: transparent;/s);
  assert.doesNotMatch(html, /id="garage-price-toggle"|id="garage-purchase-price-heading"/);
  assert.match(garage, /getSafeResultLink/);
  assert.match(garage, /anchor\.target = "_blank";/);
  assert.match(garage, /anchor\.rel = "noreferrer";/);
  assert.match(garage, /className = "result-title-cell";/);
  assert.match(garage, /"garage-stock-quantity"/);
  assert.match(html, /class="table table-hover align-middle mb-0 results-data-table garage-data-table"/);
  assert.match(html, /data-garage-sort-key="deliveryDate">Доставка[\s\S]*?data-garage-sort-key="quantity">Количество[\s\S]*?data-garage-sort-key="price">Цена[\s\S]*?data-garage-sort-key="sum">Сумма/);
  assert.doesNotMatch(html, /data-garage-column="availability"/);
  assert.doesNotMatch(html, /<th>Комментарий<\/th>|<th>Нужно<\/th>|<th>Итог<\/th>/);
  assert.doesNotMatch(garage, /const comment = document\.createElement/);
  assert.match(styles, /\.garage-control\s*\{[^}]*align-self: stretch;[^}]*align-items: center;/s);
  assert.match(styles, /\.garage-sidebar\s*\{[^}]*--garage-sidebar-width: 260px;[^}]*min-width: 180px;[^}]*max-width: 420px;/s);
  assert.match(styles, /\.garage-search-form\s*\{[^}]*min-height: 40px;/s);
  assert.match(styles, /\.garage-add-column, \.garage-add-cell\s*\{[^}]*width: 52px;/s);
  assert.match(styles, /\.garage-offer-button svg\s*\{[^}]*stroke: currentColor;/s);
  assert.match(garage, /const workspace = document\.querySelector\("\.workspace"\);/);
  assert.match(garage, /workspace\.hidden = true;/);
  assert.match(garage, /if \(isCreating\) \{[\s\S]*?form\.append\(input\);/);
  assert.match(styles, /\.garage-sidebar__resize\s*\{[^}]*left: -10px;[^}]*cursor: col-resize;/s);
  assert.match(styles, /\.garage-sidebar__resize::before\s*\{[^}]*height: 72px;/s);
  assert.match(garage, /const widthStorageKey = "autoservice-garage-sidebar-width-v1";/);
  assert.match(garage, /resize\.addEventListener\("pointerdown"/);
  assert.match(garage, /resizeStart\.startWidth \+ resizeStart\.startX - event\.clientX/);
  assert.match(garage, /event\.key === "ArrowLeft" \? 10 : -10/);
  assert.match(garage, /const renderVehicleEditor =/);
  assert.match(garage, /const showContextMenu =/);
  assert.match(html, /id="garage-toast" role="status" aria-live="polite" hidden/);
  assert.match(html, /id="garage-group-form"[\s\S]*?id="garage-group-name"/);
  assert.match(html, /id="garage-total"[\s\S]*?<\/footer>/);
  assert.match(garage, /const createGaragePriceStack = \(items\) =>/);
  assert.match(garage, /"garage-price-stack__regular"/);
  assert.match(garage, /"garage-price-stack__purchase"/);
  assert.match(styles, /\.garage-price-stack__regular\s*\{[^}]*color: var\(--ink\);/s);
  assert.match(styles, /\.garage-price-stack__purchase\s*\{[^}]*color: var\(--muted\);[^}]*font-size: 10px;/s);
  assert.match(html, /id="garage-groups-toggle"[\s\S]*?aria-controls="garage-groups-sidebar"/);
  assert.match(html, /id="garage-groups-sidebar" hidden[\s\S]*?id="garage-group-search"[\s\S]*?id="garage-groups"[\s\S]*?id="garage-groups-resize"/);
  assert.doesNotMatch(html, /Перетащите товар за кнопку/);
  assert.match(html, /id="garage-item-menu" role="menu"[\s\S]*?id="garage-item-search-button"[\s\S]*?id="garage-item-menu-groups-toggle"[\s\S]*?id="garage-item-menu-remove-group"[\s\S]*?id="garage-item-menu-move-toggle"[\s\S]*?id="garage-item-menu-move-groups"[\s\S]*?Удалить из гаража/);
  assert.match(html, /id="garage-group-context-menu" role="menu"[\s\S]*?id="garage-group-rename-button"[\s\S]*?id="garage-group-delete-button"/);
  assert.match(html, /id="garage-add-group"/);
  assert.match(garage, /const groupItems = \(items\) =>/);
  assert.match(garage, /const renderGarageTotal = \(items\) =>/);
  assert.match(garage, /api\(`\/api\/garage\/vehicles\/\$\{selectedVehicle\.id\}\/groups`/);
  assert.match(garage, /groupId: modalGroup\.value \|\| null/);
  assert.match(garage, /"garage-item-menu-toggle"/);
  assert.match(garage, /application\/x-garage-item/);
  assert.match(garage, /const renderGarageGroups = \(\) =>/);
  assert.match(garage, /const moveItemToGroup = async/);
  assert.match(garage, /row\.addEventListener\("contextmenu"/);
  assert.match(garage, /startSearch\(item\.article\);/);
  assert.match(garage, /itemMenuGroupsControl\.addEventListener\("mouseenter"/);
  assert.match(styles, /\.garage-item-menu__groups\s*\{[^}]*position: absolute;/s);
  assert.match(styles, /\.garage-item-menu__groups\s*\{[^}]*left: 100%;/s);
  assert.match(garage, /const showGroupContextMenu =/);
  assert.match(garage, /method: "PATCH", body: JSON.stringify\(\{ vehicleRevision, name \}\)/);
  assert.doesNotMatch(garage, /appendGroup\(null, "Без группы"/);
  assert.match(garage, /showToast\(`Товар добавлен в «\$\{vehicle\.name\}»\.`, "success"\)/);
  assert.match(html, /id="garage-titlebar" hidden>[\s\S]*?class="garage-titlebar__heading">\s*<span>Товары для автомобиля<\/span>\s*<h1 id="garage-vehicle-name"/);
  assert.match(html, /class="garage-view results-panel card border-0 shadow-sm overflow-hidden" id="garage-view"/);
  assert.match(html, /id="garage-titlebar" hidden>[\s\S]*?id="garage-back"[\s\S]*?id="garage-vehicle-name"[\s\S]*?id="garage-refresh"/);
  assert.match(html, /id="garage-workspace" hidden>[\s\S]*?id="garage-filters-toggle"[\s\S]*?id="garage-filters-sidebar" hidden[\s\S]*?id="garage-filters-resize"/);
  assert.match(html, /class="results-panel__header garage-view__header card-header bg-white border-0">[\s\S]*?id="garage-result-count"[\s\S]*?id="garage-table-search"/);
  assert.match(html, /id="garage-filters-sidebar" hidden[\s\S]*?id="garage-filter-supplier"[\s\S]*?id="garage-filter-brand"[\s\S]*?id="garage-filter-article"/);
  assert.match(html, /data-garage-column="quantity"[\s\S]*?data-garage-column="price"/);
  assert.match(garage, /const garageSortButtons = \[\.\.\.document\.querySelectorAll\("\[data-garage-sort-key\]"\)\]/);
  assert.match(garage, /import \{ formatArticle, formatBrand, formatPrice, formatQuantity, getSafeResultLink \} from "\.\/result-formatting\.js"/);
  assert.match(garage, /import \{ formatDeliveryDate \} from "\.\/supplier-search-summary\.js"/);
  assert.match(garage, /\["deliveryDate", formatDeliveryDate\(item\.deliveryDate, item\.deliveryDateApproximate, item\.deliveryDateTo\)\]/);
  assert.match(garage, /Остаток: \$\{formatQuantity\(item\.supplierQuantity\)\}/);
  assert.match(garage, /replaceChildren\(requiredDisplay, stockDisplay\)/);
  assert.match(garage, /Нельзя указать больше остатка: \$\{formatQuantity\(maximumQuantity\)\}\./);
  assert.match(garage, /const previousQuantity = String\(item\.requiredQuantity\);/);
  assert.match(garage, /required\.value = previousQuantity;/);
  assert.match(garage, /const updateGarageResultCount = \(items\) =>/);
  assert.match(garage, /const renderGarageFilters = \(\) =>/);
  assert.match(garage, /const applyGarageTableColumns = \(\) =>/);
  assert.match(garage, /const tableSearch = document\.querySelector\("#garage-table-search"\)/);
  assert.match(garage, /tableSearch\.addEventListener\("input"/);
  assert.match(garage, /groupSearch\.addEventListener\("input"/);
  assert.match(garage, /const filtersWidthStorageKey = "autoservice-garage-filters-width-v1";/);
  assert.match(garage, /filtersResize\.addEventListener\("pointerdown"/);
  assert.match(garage, /setFiltersOpen\(false\);/);
  assert.match(garage, /garageWorkspace\.hidden = false;\s+setFiltersOpen\(true\);/s);
  assert.match(styles, /\.garage-workspace\s*\{[^}]*grid-template-columns: auto minmax\(0, 1fr\) auto;/s);
  assert.match(styles, /\.garage-groups-sidebar\s*\{[^}]*grid-column: 3;/s);
  assert.match(styles, /\.garage-filters-control:has\(\.garage-filters-sidebar:not\(\[hidden\]\)\) \.garage-filters-toggle\s*\{[^}]*display: none;/s);
  assert.match(garage, /const compareGarageItems =/);
  assert.match(garage, /const button = event\.target\.closest\("\.garage-offer-button"\)/);
  assert.match(styles, /\.garage-group-summary td\s*\{[^}]*padding: 8px 14px !important;/s);
  assert.match(styles, /\.garage-group-summary__content\s*\{[^}]*display: flex;/s);
  assert.match(garage, /const formatGroupDeliveryDate = \(items\) =>/);
  assert.match(garage, /formatDeliveryDate\(latest\.deliveryDate, latest\.deliveryDateApproximate, latest\.deliveryDateTo\)/);
  assert.doesNotMatch(garage, /Сохранить", "btn btn-light"|confirmRemove|cancelRemove/);
  assert.match(garage, /sidebar\.addEventListener\("drop"/);
  assert.match(app, /const garageActionColumnWidth = 52;/);
  assert.match(app, /const startSearchForArticle = \(value\) =>/);
  assert.match(app, /bootstrapGarage\(\{ getMarkupPercent: \(\) => markupPercent, startSearch: startSearchForArticle \}\)/);
  assert.match(app, /garage-offer-button" draggable="\$\{Boolean\(result\.offerId\)\}"/);
  assert.match(app, /const withoutOfferId = \(result\) =>/);
  assert.match(app, /results: tab\.results\.map\(withoutOfferId\)/);
  assert.match(garage, /modal\.dataset\.vehicleSelected = String\(hasSelectedVehicle\);/);
  assert.match(garage, /modalConfirm\.hidden = hasSelectedVehicle;/);
  assert.match(garage, /modalForm\.addEventListener\("submit"/);
  assert.doesNotMatch(garage, /setStatus\("Предложения актуализированы"\)/);
  assert.match(garage, /const setModalQuantityMaximum = \(value\) =>/);
  assert.match(garage, /const api = async \(path, options = \{\}, allowConflict = false\) =>/);
  assert.match(garage, /\(!allowConflict \|\| response\.status !== 409\)/);
  assert.match(garage, /const \{ payload: currentVehiclePayload \} = await api\(`\/api\/garage\/vehicles\/\$\{vehicle\.id\}`\);/);
  assert.match(garage, /vehicleRevision: currentVehicleRevision/);
  assert.match(garage, /duplicateStrategy \? \{ duplicateStrategy \} : \{\}\) \}\) \}, true\);/);
  assert.match(garage, /modalQuantity\.max = String\(quantity\);/);
  assert.match(garage, /required\.max = String\(maximumQuantity\);/);
  assert.match(garage, /const remainingQuantity = Math\.max\(0, supplierQuantity - result\.payload\.duplicate\.requiredQuantity\);/);
  assert.match(garage, /application\/x-garage-offer-quantity/);
  assert.match(app, /data-garage-offer-quantity="\$\{Number\.isFinite\(result\.quantity\)/);
  assert.match(app, /const renderOfferLink = \(result, text, title = text\) =>/);
  assert.match(app, /class="result-offer-link" href="\$\{escapeHtml\(link\)\}" target="_blank" rel="noreferrer"/);
  assert.match(styles, /\.result-offer-link\s*\{[^}]*color: #0666d6;/s);
  assert.match(styles, /\.garage-toast\s*\{[^}]*top: 24px;[^}]*right: 24px;/s);
  assert.match(styles, /\.garage-toast\[data-tone="success"\]\s*\{[^}]*background: #f4fbf6;/s);
  assert.match(styles, /\.garage-toast\[data-tone="error"\]\s*\{[^}]*background: #fff5f4;/s);
  assert.doesNotMatch(app, /main-result-row[\s\S]{0,250}draggable=|analogs-result-row[\s\S]{0,250}draggable=/);
  assert.doesNotMatch(garage, /window\.(?:prompt|confirm)/);
});

test("main application frame uses the expanded shared width", async () => {
  const styles = await readFile(new URL("../src/frontend/styles.css", import.meta.url), "utf8");

  assert.match(styles, /\.page\s*\{[^}]*max-width: 2400px;/s);
});

test("Rossko authorization form accepts only API keys", async () => {
  const html = await readFile(new URL("../src/frontend/index.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/frontend/app.js", import.meta.url), "utf8");

  assert.match(html, /id="rossko-key1" name="key1" type="password"/);
  assert.match(html, /id="rossko-key2" name="key2" type="password"/);
  assert.doesNotMatch(html, /id="rossko-(?:login|password)"/);
  assert.match(app, /key1: rosskoKey1Input\.value\.trim\(\)/);
  assert.match(app, /key2: rosskoKey2Input\.value\.trim\(\)/);
});

test("search tabs can be renamed through a context menu and keep their full name in a tooltip", async () => {
  const html = await readFile(new URL("../src/frontend/index.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/frontend/app.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/frontend/styles.css", import.meta.url), "utf8");

  assert.match(html, /id="tab-context-menu"/);
  assert.match(html, /id="rename-tab-button"/);
  assert.match(app, /name: normalizeTabName\(data\.name\)/);
  assert.match(app, /name: tab\.name/);
  assert.match(app, /searchTabsList\.addEventListener\("contextmenu"/);
  assert.match(app, /window\.prompt\("Введите название вкладки"/);
  assert.match(app, /title="\$\{escapeHtml\(title\)\}"/);
  assert.match(styles, /\.search-tab__title\s*\{[^}]*text-overflow: ellipsis;/s);
  assert.match(styles, /\.search-tab__status\s*\{[^}]*flex: 0 0 7px;/s);
});

test("main results use the same comparison-oriented table controls as analogs", async () => {
  const html = await readFile(new URL("../src/frontend/index.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/frontend/app.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/frontend/styles.css", import.meta.url), "utf8");

  assert.match(html, /<h2>Предложения<\/h2>/);
  assert.match(html, /id="analogs-results">[\s\S]*?<table class="table table-hover align-middle mb-0 results-data-table">/);
  assert.match(html, /class="results-panel__footer" aria-hidden="true"><\/footer>/);
  assert.match(html, /class="analogs-modal__footer">\s*<button[^>]*id="analogs-show-more"/s);
  assert.match(html, /id="analogs-filters-resize" role="separator"/);
  assert.doesNotMatch(html, /Нажмите на строку/);
  assert.match(html, /id="warehouse-tooltip"/);
  assert.doesNotMatch(html, /data-column="warehouse"/);
  assert.doesNotMatch(html, /data-analog-column="warehouse"/);
  assert.doesNotMatch(html, /table-column-input" type="checkbox" value="warehouse"/);
  assert.match(html, /data-analog-sort-key="quantity"[^>]*>Остаток/);
  assert.match(app, /formatQuantity\(result\.quantity\)/);
  assert.match(app, /main-result-row\$\{isBestPrice \? " is-best-price" : ""\}/);
  assert.match(app, /main-best-price/);
  assert.match(app, /const tableColumnWidths = \{\s+supplier: 100,\s+brand: 125,\s+article: 140,\s+title: 323,\s+deliveryDate: 180,\s+quantity: 120,\s+markupPrice: 120,/s);
  assert.match(app, /--results-table-min-width/);
  assert.match(app, /tableColumnWidths\[header\.dataset\.column\] \/ minimumWidth \* 100/);
  assert.match(app, /const analogTableColumnWidths = \{\s+supplier: 100,\s+brand: 125,\s+article: 140,\s+title: 323,\s+deliveryDate: 180,\s+quantity: 120,\s+markupPrice: 120,/s);
  assert.match(app, /const applyAnalogTableColumns = \(\) =>/);
  assert.match(app, /--analogs-results-table-min-width/);
  assert.match(app, /analogFiltersResize\.addEventListener\("pointerdown"/);
  assert.match(app, /showWarehouseTooltip/);
  assert.match(styles, /\.results-data-table thead\s*\{[^}]*position: sticky;/s);
  assert.match(styles, /\.results-data-table\s*\{[^}]*width: max\(100%, var\(--results-table-min-width,/s);
  assert.match(styles, /\.results-data-table tbody td\s*\{[^}]*font-size: 12px;/s);
  assert.match(styles, /\.analogs-results td\s*\{[^}]*font-size: 12px;/s);
  assert.match(styles, /\.main-result-purchase-price\s*\{[^}]*font-size: 12px;/s);
  assert.match(styles, /\.garage-stock-quantity\s*\{[^}]*display: block;[^}]*color: var\(--muted\);/s);
  assert.match(styles, /\.results-data-table \[data-column="deliveryDate"\]\s*\{[^}]*text-align: left;/s);
  assert.match(styles, /\.analogs-results \[data-analog-column="deliveryDate"\]\s*\{[^}]*text-align: left;/s);
  assert.match(styles, /\.garage-data-table \[data-garage-column="deliveryDate"\]\s*\{[^}]*text-align: left;/s);
  assert.match(styles, /\.results-data-table \[data-column="markupPrice"\]\s*\{[^}]*text-align: center;/s);
  assert.match(styles, /\.results-data-table th\[data-column="markupPrice"\] \.table-sort\s*\{[^}]*justify-content: center;/s);
  assert.doesNotMatch(styles, /\.results-data-table th:nth-child/);
  assert.match(styles, /\.warehouse-code\s*\{[^}]*max-width: 100%;[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;/s);
  assert.match(styles, /\.results-table\s*\{[^}]*overflow: auto;/s);
  assert.match(styles, /\.results-table\s*\{[^}]*flex: 1 1 auto;[^}]*overflow: auto;/s);
  assert.match(styles, /width: min\(2400px, calc\(100vw - 24px\)\)/);
  assert.match(styles, /height: min\(1440px, calc\(100dvh - 24px\)\)/);
  assert.match(styles, /\.analogs-workspace\s*\{[^}]*grid-template-columns: auto minmax\(0, 1fr\);/s);
  assert.match(styles, /\.analogs-workspace\s*\{[^}]*height: 100%;[^}]*overflow: hidden;/s);
  assert.match(styles, /\.analogs-filters-sidebar\s*\{[^}]*height: 100%;[^}]*overflow-y: auto;/s);
  assert.match(styles, /\.analogs-results table\s*\{[^}]*width: max\(100%, var\(--analogs-results-table-min-width,/s);
  assert.match(styles, /\.analogs-results \[data-analog-column="markupPrice"\]/);
  assert.match(styles, /\.delivery-warehouse\s*\{[^}]*color: var\(--muted\);/s);
  assert.match(styles, /\.delivery-warehouse\s*\{[^}]*justify-content: flex-start;/s);
  assert.match(styles, /\.delivery-warehouse \.warehouse-code\s*\{[^}]*color: var\(--muted\);/s);
  assert.match(styles, /\.analogs-results \[data-analog-column="markupPrice"\]\s*\{[^}]*text-align: center;/s);
  assert.doesNotMatch(styles, /\.analogs-results th:nth-child/);
});

test("search reports supplier authorization failures without waiting for session validation", async () => {
  const app = await readFile(new URL("../src/frontend/app.js", import.meta.url), "utf8");
  const submitHandler = app.slice(app.indexOf('form.addEventListener("submit"'));

  assert.doesNotMatch(submitHandler, /checkSupplierSessions|showSupplierSessionCheckProgress/);
  assert.match(submitHandler, /startSearch\(article, enabledSuppliers\);/);
  assert.match(app, /payload\.status === "auth_error"[\s\S]*?showSearchToast\(/);
  assert.match(app, /Поиск по остальным поставщикам продолжается/);
  assert.doesNotMatch(app, /supplier-check/);
});

test("search stream parses fragmented multiline SSE data", async () => {
  const originalFetch = globalThis.fetch;
  let requestHeaders;

  try {
    globalThis.fetch = async (_url, options) => {
      requestHeaders = options.headers;
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"type":"result",'));
          controller.enqueue(new TextEncoder().encode('\ndata: "value":1}\n\n'));
          controller.close();
        },
      }));
    };

    const messages = [];
    await new Promise((resolve, reject) => {
      const stream = openSearchStream("/api/search");
      stream.onmessage = ({ data }) => messages.push(data);
      stream.onerror = (error) => {
        if (error.message === "Search stream closed before completion") {
          resolve();
        } else {
          reject(error);
        }
      };
    });

    assert.deepEqual(requestHeaders, { Accept: "text/event-stream" });
    assert.deepEqual(messages, ['{"type":"result",\n"value":1}']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
