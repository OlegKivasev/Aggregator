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

test("PartKOM return preference is rendered and applied to regular and analog results", async () => {
  const html = await readFile(new URL("../src/frontend/index.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/frontend/app.js", import.meta.url), "utf8");

  assert.match(html, /id="part-kom-non-returnable"/);
  assert.match(app, /autoservice\.partKomNonReturnable/);
  assert.match(app, /filterVisiblePartKomReturnable\(filterVisibleStpartsWarehouses\([\s\S]*?exactResults\.filter/);
  assert.match(app, /filterVisiblePartKomReturnable\(filterVisibleStpartsWarehouses\([\s\S]*?analogSearchResults\.filter/);
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
  assert.match(html, /data-analog-sort-key="price"/);
  assert.match(html, /id="analogs-results-body"/);
  assert.match(html, /id="analogs-show-more"/);
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
  assert.match(app, /brand: result\.brand/);
  assert.match(app, /formatBrand\(result\.brand\)/);
  assert.match(app, /formatArticle\(result\.article\)/);
  assert.match(app, /const analogSupplierIds = \["armtek", "part-kom", "stparts", "forum-auto"\]/);
  assert.match(app, /analogSupplierIds\.filter\(isSupplierVisible\)/);
  assert.match(app, /Выдали аналоги:/);
  assert.match(app, /scheduleAnalogRowsRender/);
  assert.match(app, /const exactResults = results\.filter\(\(result\) => result\.isAnalog !== true\);/);
});

test("frontend can hide a supplier from searches, results, and authorization settings", async () => {
  const html = await readFile(new URL("../src/frontend/index.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/frontend/app.js", import.meta.url), "utf8");

  assert.match(html, /class="supplier-visibility-input" type="checkbox" value="armtek"/);
  assert.match(html, /class="auth-card" data-supplier="armtek"/);
  assert.match(app, /const supplierVisibilityStorageKey = "autoservice\.supplierVisibility"/);
  assert.match(app, /const updateSupplierVisibility = \(supplier\)/);
  assert.match(app, /result\.isAnalog !== true\)[\s\S]*?isSupplierVisible\(result\.supplier\)/);
  assert.match(app, /analogSearchResults\.filter\(\(result\) => isSupplierVisible\(result\.supplier\)\)/);
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
  assert.match(app, /--results-table-min-width/);
  assert.match(app, /tableColumnWidths\[header\.dataset\.column\] \/ minimumWidth \* 100/);
  assert.match(app, /showWarehouseTooltip/);
  assert.match(styles, /\.results-data-table thead\s*\{[^}]*position: sticky;/s);
  assert.match(styles, /\.results-data-table\s*\{[^}]*width: max\(100%, var\(--results-table-min-width,/s);
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
