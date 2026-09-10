import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
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
} from "../src/frontend/result-formatting.js";
import { openSearchStream } from "../src/frontend/search-stream.js";
import {
  isStpartsWarehouseVisible,
  normalizeStpartsWarehouseColors,
} from "../src/frontend/stparts-warehouse-settings.js";
import { isPartKomReturnableVisible } from "../src/frontend/partkom-return-settings.js";
import { isForumAutoReturnableVisible } from "../src/frontend/forum-auto-return-settings.js";
import { isArmtekReturnableVisible } from "../src/frontend/armtek-return-settings.js";

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

test("frontend opens on-demand analog search for a selected result", async () => {
  const html = await readFile(new URL("../src/frontend/index.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/frontend/app.js", import.meta.url), "utf8");

  assert.match(html, /id="result-context-menu"/);
  assert.match(html, /id="open-result-button"/);
  assert.match(html, /id="show-analogs-button"/);
  assert.match(html, /id="analogs-modal"/);
  assert.match(html, /id="analogs-source-title"/);
  assert.match(html, /id="analogs-source-markup-price"/);
  assert.match(html, /id="analogs-table-search"/);
  assert.match(html, /id="analogs-markup-percent"/);
  assert.match(html, /id="analogs-purchase-price-toggle"[^>]*aria-pressed="false"/);
  assert.match(html, /id="analogs-filters"/);
  assert.match(html, /data-analog-filter-section="supplier"[\s\S]*?data-analog-filter-section="brand"[\s\S]*?data-analog-filter-section="article"[\s\S]*?data-analog-filter-section="warehouse"[\s\S]*?data-analog-filter-section="markupPrice"[\s\S]*?data-analog-filter-section="deliveryDate"/);
  assert.match(html, /data-analog-sort-key="price"/);
  assert.match(html, /id="analogs-results-body"/);
  assert.match(html, /id="analogs-show-more"/);
  assert.match(html, /id="analogs-count" tabindex="0"/);
  assert.equal((html.match(/id="results-body"/g) ?? []).length, 1);
  assert.doesNotMatch(html, /id="results-view-toggle"/);
  assert.match(app, /registerResultContextMenu\(resultsBody/);
  assert.match(app, /registerResultContextMenu\(analogsResultsBody/);
  assert.doesNotMatch(app, /data-show-row-analogs/);
  assert.match(app, /openResultButton\.addEventListener/);
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
  assert.match(app, /Выдали аналоги:/);
  assert.match(app, /hideSuccessfulAnalogStatus/);
  assert.match(app, /Показать всё/);
  assert.match(app, /analogSearchCompleted \? Number\.POSITIVE_INFINITY/);
  assert.match(app, /analogsCount\.dataset\.tooltip = supplierBreakdown/);
  assert.match(app, /scheduleAnalogRowsRender/);
  assert.match(app, /const exactResults = items\.filter\(\(result\) => result\.isAnalog !== true\);/);
});

test("frontend keeps retail price as the configurable column and discovers brands after an empty search", async () => {
  const html = await readFile(new URL("../src/frontend/index.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/frontend/app.js", import.meta.url), "utf8");

  assert.match(html, /id="purchase-price-toggle"[^>]*aria-pressed="false"/);
  assert.match(html, /data-column="purchasePrice" hidden>Закупочная цена/);
  assert.match(html, /data-column="markupPrice"[^>]*><button[^>]*data-sort-key="markupPrice">Цена/);
  assert.match(html, /table-column-input" type="checkbox" value="markupPrice" checked><span>Цена/);
  assert.doesNotMatch(html, /table-column-input" type="checkbox" value="price"/);
  assert.match(app, /let sortState = \{ key: "markupPrice", direction: "ascending" \}/);
  assert.match(app, /state\.key === "markupPrice" && comparison === 0/);
  assert.match(app, /compareDeliveryDates\(left, right\)/);
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
  assert.doesNotMatch(app, /filtersClose/);
  assert.match(app, /button\.setAttribute\("aria-pressed", String\(selected\)\)/);
  assert.match(app, /const candidateResults = getFilteredResults\(visibleExactResults, tableSearchTerm, markupPercent, column\);/);
  assert.match(app, /section\.hidden = !visibleTableColumns\.has\(column\) \|\| values\.length === 0;/);
  assert.match(app, /section\.hidden = !visibleTableColumns\.has\(column\) \|\| !hasValues;/);
  assert.match(app, /const filtersWidthStorageKey = "autoservice\.filtersWidth\.v2"/);
  assert.match(app, /Средняя закуп\. цена/);
  assert.match(app, /Средняя цена/);
  assert.match(app, /Math\.max\(180, Math\.round\(width \/ 10\) \* 10\)/);
  assert.match(styles, /\.workspace\s*\{[^}]*grid-template-columns: auto minmax\(0, 1fr\);/s);
  assert.match(styles, /\.filters-control:has\(\.filters-sidebar:not\(\[hidden\]\)\)\s*\{[^}]*align-items: center;/s);
  assert.match(styles, /\.filters-control\s*\{[^}]*align-self: start;/s);
  assert.match(styles, /\.filters-control:has\(\.filters-sidebar:not\(\[hidden\]\)\) \.filters-toggle\s*\{[^}]*order: 2;/s);
  assert.match(styles, /\.filters-sidebar\s*\{[^}]*--filters-sidebar-width: 200px;[^}]*min-width: 180px;/s);
  assert.match(styles, /@media \(max-width: 575\.98px\)\s*\{\s*\.workspace/);
  assert.match(styles, /\.filters-suppliers\s*\{[^}]*margin-top: 0;/s);
  assert.match(styles, /\.filters-sidebar__disclosure summary\s*\{[^}]*cursor: pointer;/s);
  assert.match(styles, /\.filters-sidebar__resize\s*\{[^}]*cursor: col-resize;/s);
  assert.match(styles, /\.supplier-search-toggle \.supplier-enabled-input\s*\{[^}]*clip-path: inset\(50%\);/s);
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
  assert.match(html, /class="table table-hover align-middle mb-0 results-data-table"/);
  assert.match(html, /class="results-panel__footer" aria-hidden="true"><\/footer>/);
  assert.match(html, /class="analogs-modal__footer">\s*<button[^>]*id="analogs-show-more"/s);
  assert.doesNotMatch(html, /Нажмите на строку/);
  assert.match(html, /id="warehouse-tooltip"/);
  assert.match(html, /data-column="quantity"[^>]*[\s\S]*?Количество[\s\S]*?data-column="warehouse"/);
  assert.match(html, /data-analog-sort-key="quantity"[^>]*>Количество/);
  assert.match(app, /formatQuantity\(result\.quantity\)/);
  assert.match(app, /main-result-row\$\{isBestPrice \? " is-best-price" : ""\}/);
  assert.match(app, /main-best-price/);
  assert.match(app, /const tableColumnWidths = \{\s+supplier: 100,\s+brand: 125,\s+article: 150,\s+title: 325,\s+quantity: 120,\s+warehouse: 120,\s+purchasePrice: 120,\s+markupPrice: 120,\s+deliveryDate: 120,/s);
  assert.match(app, /--results-table-min-width/);
  assert.match(app, /tableColumnWidths\[header\.dataset\.column\] \/ minimumWidth \* 100/);
  assert.match(app, /showWarehouseTooltip/);
  assert.match(styles, /\.results-data-table thead\s*\{[^}]*position: sticky;/s);
  assert.match(styles, /\.results-data-table\s*\{[^}]*width: max\(100%, var\(--results-table-min-width,/s);
  assert.match(styles, /\.results-data-table \[data-column="purchasePrice"\]\s*\{[^}]*text-align: center;/s);
  assert.match(styles, /\.results-data-table \[data-column="markupPrice"\],\s*\.results-data-table \[data-column="warehouse"\]\s*\{[^}]*text-align: center;/s);
  assert.match(styles, /\.results-data-table th\[data-column="markupPrice"\] \.table-sort,\s*\.results-data-table th\[data-column="warehouse"\] \.table-sort\s*\{[^}]*justify-content: center;/s);
  assert.doesNotMatch(styles, /\.results-data-table th:nth-child/);
  assert.match(styles, /\.warehouse-code\s*\{[^}]*max-width: 100%;[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;/s);
  assert.match(styles, /\.results-table\s*\{[^}]*overflow: auto;/s);
  assert.match(styles, /height: max\(420px, calc\(100dvh - 300px\)\)/);
  assert.match(styles, /width: min\(1600px, calc\(100vw - 24px\)\)/);
  assert.match(styles, /height: min\(960px, calc\(100dvh - 24px\)\)/);
});

test("search shows authorization progress before waiting for session validation", async () => {
  const app = await readFile(new URL("../src/frontend/app.js", import.meta.url), "utf8");
  const submitHandler = app.slice(app.indexOf('form.addEventListener("submit"'));
  const progressIndex = submitHandler.indexOf("showSupplierSessionCheckProgress(article);");
  const validationIndex = submitHandler.indexOf("await checkSupplierSessions(article, enabledSuppliers);");

  assert.notEqual(progressIndex, -1);
  assert.notEqual(validationIndex, -1);
  assert.ok(progressIndex < validationIndex);
  assert.match(app, /searchLoadingTitle\.textContent = "Проверяем авторизацию поставщиков";/);
  assert.match(app, /setSearchUiState\(false\);\s+return;\s+}\s+rememberSupplierSessionsChecked/);
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
