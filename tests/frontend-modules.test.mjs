import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  compareDeliveryDates,
  escapeHtml,
  formatPrice,
  formatWarehouse,
  getSafeResultLink,
  renderWarehouse,
} from "../src/frontend/result-formatting.js";
import { openSearchStream } from "../src/frontend/search-stream.js";

test("result formatting escapes untrusted text and limits result links", () => {
  assert.equal(escapeHtml('<script data-value="x">'), "&lt;script data-value=&quot;x&quot;&gt;");
  assert.equal(getSafeResultLink("javascript:alert(1)"), "");
  assert.equal(getSafeResultLink("https://supplier.test/item?id=1"), "https://supplier.test/item?id=1");
  assert.equal(formatWarehouse("  Склад   12  "), "Склад 12");
  assert.equal(formatWarehouse("Упаковка поставщика"), "-");
  assert.equal(formatPrice(1234.569), "1 234,56 ₽");
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

test("delivery date sorting places single dates before intervals", () => {
  const results = [
    { label: "interval tomorrow", deliveryDate: "2026-07-27T00:00:00.000Z", deliveryDateTo: "2026-07-28T00:00:00.000Z" },
    { label: "single day after tomorrow", deliveryDate: "2026-07-28T00:00:00.000Z" },
    { label: "later interval", deliveryDate: "2026-07-28T00:00:00.000Z", deliveryDateTo: "2026-07-30T00:00:00.000Z" },
    { label: "single tomorrow", deliveryDate: "2026-07-27T00:00:00.000Z" },
  ];

  assert.deepEqual(results.sort(compareDeliveryDates).map((result) => result.label), [
    "single tomorrow",
    "single day after tomorrow",
    "interval tomorrow",
    "later interval",
  ]);
});

test("frontend opens on-demand analog search for a selected result", async () => {
  const html = await readFile(new URL("../src/frontend/index.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/frontend/app.js", import.meta.url), "utf8");

  assert.match(html, /id="result-context-menu"/);
  assert.match(html, /id="show-analogs-button"/);
  assert.match(html, /id="analogs-modal"/);
  assert.match(html, /id="analogs-source-title"/);
  assert.match(html, /id="analogs-source-markup-price"/);
  assert.match(html, /id="analogs-table-search"/);
  assert.match(html, /id="analogs-markup-percent"/);
  assert.match(html, /data-analog-sort-key="price"/);
  assert.match(html, /id="analogs-results-body"/);
  assert.equal((html.match(/id="results-body"/g) ?? []).length, 1);
  assert.doesNotMatch(html, /id="results-view-toggle"/);
  assert.match(app, /resultsBody\.addEventListener\("contextmenu"/);
  assert.match(app, /data-show-row-analogs/);
  assert.match(app, /analogsTableSearch\.addEventListener\("input"/);
  assert.match(app, /analogSortButtons\.forEach/);
  assert.match(app, /analogs-best-price/);
  assert.match(app, /mode: "analogs"/);
  assert.match(app, /supplier: "armtek"/);
  assert.match(app, /const exactResults = results\.filter\(\(result\) => result\.isAnalog !== true\);/);
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
