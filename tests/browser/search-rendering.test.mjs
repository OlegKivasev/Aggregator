import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve, sep } from "node:path";
import { chromium } from "playwright";

// Fictional offers reproduce the reported 308-result article without supplier IO.
const article = "406-1005050-60";
const offers = Array.from({ length: 308 }, (_, index) => ({ supplier: "autopiter", article, brand: "TEST",
  title: `Тестовый товар ${index}`, price: 100 + index, quantity: 5, warehouse: `Тестовый склад ${index % 4}`,
  deliveryDate: null, deliveryDateApproximate: false, isReturnable: index % 4 !== 0, link: "https://autopiter.ru/" }));
const sse = (events) => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");

for (const ending of ["completed", "fatal_error", "disconnect"]) {
test(`large pricing streams batch updates and retain all offers on ${ending}`, async (t) => {
  const frontend = resolve("src/frontend");
  let activeResponse;
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, "http://127.0.0.1").pathname;
    if (path === "/api/search") {
      activeResponse = response;
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      response.write(sse([{ type: "search_started", article, suppliers: ["autopiter"] },
        { type: "supplier_status", supplier: "autopiter", status: "searching" },
        ...offers.slice(0, 154).map((result) => ({ type: "result", result }))]));
      return;
    }
    const file = resolve(frontend, `.${path === "/" ? "/index.html" : path}`);
    if (!file.startsWith(`${frontend}${sep}`)) return response.writeHead(404).end();
    try {
      const source = path === "/app.js" && process.env.TEST_SEARCH_RENDER_APP ? process.env.TEST_SEARCH_RENDER_APP : file;
      response.writeHead(200, { "Content-Type": file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html" }).end(await readFile(source));
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.TEST_BROWSER_EXECUTABLE_PATH });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(60_000);
    const origin = `http://127.0.0.1:${server.address().port}`;
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      localStorage.setItem("autoservice.supplierVisibility", JSON.stringify(["autopiter"]));
      if (!localStorage.getItem("autoservice.searchState")) localStorage.setItem("autoservice.searchState", JSON.stringify({
        activeTabId: "render-test", tabs: [{ id: "render-test", article: "", enabledSuppliers: ["autopiter"], results: [] }],
      }));
      const original = Storage.prototype.setItem;
      window.searchStateWrites = 0;
      Storage.prototype.setItem = function (key, value) {
        if (this === localStorage && key === "autoservice.searchState") window.searchStateWrites++;
        return original.call(this, key, value);
      };
    });
    await page.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (!url.pathname.startsWith("/api/") || url.pathname === "/api/search") return route.continue();
      const data = {
        "/api/suppliers/sessions": { sessions: [{ supplier: "autopiter", authorized: true, lastCheckedAt: null, lastAuthorizedAt: null }] },
        "/api/applicability/api-key": { configured: false, persistent: false, maskedKey: null },
        "/api/applicability/proxies": { persistent: false, activeRouteId: null, proxies: [], directLimited: false, usage: { requestCount: 0 }, directUsage: { requestCount: 0, secondsUntilReset: null } },
        "/api/garage/vehicles": { vehicles: [] },
      };
      return route.fulfill({ json: data[url.pathname] ?? { articles: [], brandCounts: [], hasMore: false } });
    });
    await page.goto(origin);
    await page.locator('#autopiter-auth-form[data-authorized="true"]').waitFor({ state: "attached" });
    await page.locator("#article-input").fill(article);
    await page.evaluate(() => {
      window.searchStateWrites = 0;
      window.tableReplacements = 0;
      new MutationObserver((records) => { window.tableReplacements += records.filter((record) => record.type === "childList").length; })
        .observe(document.querySelector("#results-body"), { childList: true });
    });
    const started = performance.now();
    await page.locator("#submit-button").click();
    await page.waitForFunction(() => document.querySelectorAll("#results-body .main-result-row").length === 115);
    assert.equal(await page.locator("#submit-button").isDisabled(), true);
    activeResponse.end(sse([...offers.slice(154).map((result) => ({ type: "result", result })),
      ...(ending === "completed" ? [{ type: "supplier_status", supplier: "autopiter", status: "completed" }, { type: "search_completed", article }]
        : ending === "fatal_error" ? [{ type: "fatal_error", message: "Search failed" }] : [])]));
    await page.waitForFunction(() => document.querySelectorAll("#results-body .main-result-row").length === 231 && !document.querySelector("#submit-button").disabled);
    const metrics = await page.evaluate(() => ({ writes: window.searchStateWrites, renders: window.tableReplacements,
      saved: JSON.parse(localStorage.getItem("autoservice.searchState")).tabs.find((tab) => tab.article === "406-1005050-60").results.length }));
    t.diagnostic(`308 offers: ${Math.round(performance.now() - started)} ms; ${metrics.renders} table replacements; ${metrics.writes} state writes`);
    assert.equal(metrics.saved, 308);
    assert.ok(metrics.renders < 20, `Expected batched renders, received ${metrics.renders}`);
    assert.ok(metrics.writes < 20, `Expected batched persistence, received ${metrics.writes}`);
    if (ending !== "completed") assert.match(await page.locator("#global-status").textContent(), ending === "fatal_error" ? /Search failed/ : /Соединение/);
    assert.equal(await page.locator("#results-body .cart-offer-button:enabled").count(), 0);
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll("#results-body .main-result-row").length === 231);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close(); activeResponse?.destroy(); server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
}
