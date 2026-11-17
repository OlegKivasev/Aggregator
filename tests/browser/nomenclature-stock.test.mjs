import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { createAggregatorServer } from "../../src/backend/http/create-server.ts";

const json = (value, headers = {}) => ({ headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(value) });

test("stock searches all inventory, loads on scroll and bounds DOM while retaining earlier batches", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nomenclature-stock-browser-"));
  const previous = process.env.GARAGE_DB_PATH;
  process.env.GARAGE_DB_PATH = join(directory, "database.sqlite");
  const server = createAggregatorServer({ application: { streamSearch: async () => {} }, publicDir: resolve("src/frontend") });
  let browser;
  try {
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const request = (path, options) => fetch(origin + path, options);
    const token = (await (await request("/api/nomenclature/connection", { method: "POST", ...json({}) })).json()).token;
    const headers = { Authorization: `Bearer ${token}` };
    const poll = async (wait = 0, capability = 5) => {
      const response = await request(`/api/integration/1c/nomenclature/requests?waitSeconds=${wait}&stock=${capability}`, { headers });
      assert.equal(response.status, 200);
      return (await response.json()).request;
    };
    const priceTypes = [{ id: randomUUID(), name: "Розничная цена" }, { id: randomUUID(), name: "Закупочная цена" }];
    const complete = (job, products, hasMore = false, status = "completed", lastSortValue = null, totalCount = hasMore ? 1200 : products.length) => request("/api/integration/1c/nomenclature/stock-results", {
      method: "POST", ...json({ requestId: job.id, leaseId: job.leaseId, products, hasMore, status, lastSortValue, ...(status === "completed" && !job.after ? { totalCount, priceTypes } : {}) }, headers),
    });
    await poll();
    browser = await chromium.launch({ headless: true, executablePath: process.env.TEST_BROWSER_EXECUTABLE_PATH });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    const reads = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (req) => { if (new URL(req.url()).pathname === "/api/nomenclature/stock") reads.push(req.url()); });
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.href === "https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" && process.env.REPAIRS_BOOTSTRAP_CSS_PATH) {
        return route.fulfill({ contentType: "text/css", body: await readFile(process.env.REPAIRS_BOOTSTRAP_CSS_PATH) });
      }
      if (url.origin !== origin) return route.abort();
      if (!url.pathname.startsWith("/api/") || url.pathname.startsWith("/api/nomenclature/")) return route.continue();
      const responses = {
        "/api/auth/session": { enabled: false, user: null }, "/api/repairs": { repairs: [] },
        "/api/suppliers/sessions": { sessions: [] }, "/api/applicability/api-key": { configured: false },
        "/api/applicability/proxies": { persistent: false, proxies: [], activeRouteId: null, directUsage: {}, usage: {} },
        "/api/garage/vehicles": { vehicles: [] },
      };
      return route.fulfill({ json: responses[url.pathname] ?? { articles: [], brandCounts: [], hasMore: false } });
    });
    await page.goto(origin);
    await page.waitForFunction(() => window.aggregatorAuthState?.ready);
    assert.equal(reads.length, 0, "no stock reads before entering the tab");
    await page.locator("#nomenclature-function-tab").click();
    const job = await poll(20);
    assert.equal(job.kind, "stock");
    await page.locator("#nomenclature-stock-loading").waitFor();
    assert.deepEqual(job.options, { availability: "available", priceType: null });
    assert.equal(await page.locator("#nomenclature-stock-status").textContent(), "");
    const products = Array.from({ length: 100 }, (_, index) => ({ id: randomUUID(),
      name: index === 0 ? '<img src=x onerror="window.stockXss=1"> Товар с длинным наименованием' : `Тестовый товар ${index + 1}`,
      article: index === 1 ? "" : `0000${index}`, quantity: index === 0 ? 1.125 : index + 1 }));
    assert.equal((await complete(job, products, true)).status, 200);
    await page.waitForFunction(() => document.querySelectorAll("#nomenclature-stock-rows tr").length === 100);
    assert.equal(reads.length, 1, "one browser request waits for the entire page without polling");
    assert.equal(await page.locator("#nomenclature-stock-rows tr").first().locator("td").first().textContent(), products[0].name);
    assert.equal(await page.locator("#nomenclature-stock-rows img").count(), 0);
    assert.equal(await page.locator("#nomenclature-stock-rows tr").first().locator("td").nth(1).textContent(), "00000");
    assert.equal(await page.locator("#nomenclature-stock-rows tr").first().locator("td").last().textContent(), "1,125");
    const beforeSelection = reads.length;
    await page.locator("#nomenclature-stock-rows tr").first().click();
    await page.locator("#nomenclature-stock-rows tr").nth(1).click({ modifiers: ["Control"] });
    assert.match(await page.locator("#nomenclature-stock-statistics").textContent(), /Выделено: 2$/);
    await page.locator("#nomenclature-stock-rows tr").nth(4).click({ modifiers: ["Shift"] });
    assert.match(await page.locator("#nomenclature-stock-statistics").textContent(), /Выделено: 4$/);
    await page.locator("#nomenclature-stock-rows tr").nth(4).press("Space");
    assert.match(await page.locator("#nomenclature-stock-statistics").textContent(), /Выделено: 3$/);
    assert.equal(reads.length, beforeSelection, "selection requires no HTTP");
    assert.equal(await page.locator("#nomenclature-stock-rows tr").nth(1).locator("td").nth(1).textContent(), "");
    assert.equal(await page.locator("#nomenclature-stock-previous, #nomenclature-stock-next").count(), 0);
    for (const width of [320, 390, 1280, 1920]) {
      await page.setViewportSize({ width, height: 844 });
      const bounds = await page.locator("#nomenclature-function").evaluate((element) => {
        const section = element.getBoundingClientRect(); const parent = element.parentElement.getBoundingClientRect();
        return { x: section.x, width: section.width, parentX: parent.x, parentWidth: parent.width };
      });
      assert.ok(Math.abs(bounds.x - bounds.parentX) <= 1 && Math.abs(bounds.width - bounds.parentWidth) <= 1, "nomenclature fills the same content column as markup");
      if (process.env.NOMENCLATURE_SCREENSHOT_DIR) {
        await mkdir(process.env.NOMENCLATURE_SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({ path: join(process.env.NOMENCLATURE_SCREENSHOT_DIR, `nomenclature-stock-${width}.png`), fullPage: false });
      }
      assert.deepEqual(await page.locator(".nomenclature-stock").evaluate((element) => ({ width: element.clientWidth,
        overflow: element.scrollWidth > element.clientWidth,
        children: [...element.children].filter((child) => child.scrollWidth > element.clientWidth).map((child) => [child.className, child.scrollWidth]),
      })), { width: await page.locator(".nomenclature-stock").evaluate((element) => element.clientWidth), overflow: false, children: [] });
    }
    await page.locator("#nomenclature-stock-sentinel").scrollIntoViewIfNeeded();
    const second = await poll(20);
    assert.deepEqual(second.after, { id: products.at(-1).id, value: null });
    await page.locator("#nomenclature-stock-sentinel").scrollIntoViewIfNeeded();
    assert.equal(await poll(), null, "scrolling during a load cannot create a parallel batch");
    assert.equal(await page.locator("#nomenclature-stock-rows tr").count(), 100, "scrolling keeps previous batches");
    assert.equal((await complete(second, [{ ...products[2], id: randomUUID(), name: "Последний товар" }])).status, 200);
    await page.locator("#nomenclature-stock-loading").waitFor({ state: "hidden" });
    assert.equal(reads.length, 2);
    assert.equal(await page.locator("#nomenclature-stock-rows tr").count(), 101);

    const input = page.locator("#nomenclature-stock-query");
    await input.fill("ф"); await input.fill("фи"); await input.fill("ФИЛЬТР");
    assert.equal(await page.locator("#nomenclature-stock-rows tr").count(), 0);
    const search = await poll(20);
    assert.equal(search.query, "фильтр"); assert.equal(search.after, null);
    assert.equal(reads.length, 3, "rapid typing makes one search request");
    const filtered = products.map((product, index) => ({ ...product, id: randomUUID(), name: `Фильтр ${index + 1}` }));
    assert.equal((await complete(search, filtered, true)).status, 200);
    await page.waitForFunction(() => document.querySelectorAll("#nomenclature-stock-rows tr").length === 100);
    await input.fill("фильтрx"); await input.fill("ФИЛЬТР");
    const reverted = await poll(20);
    assert.equal(reverted.query, "фильтр", "returning to the current query cancels the pending different query");
    assert.equal((await complete(reverted, filtered, true)).status, 200);
    await page.waitForFunction(() => document.querySelectorAll("#nomenclature-stock-rows tr").length === 100);
    await page.locator("#nomenclature-stock-sentinel").scrollIntoViewIfNeeded();
    const failed = await poll(20);
    assert.equal(failed.query, "фильтр"); assert.deepEqual(failed.after, { id: filtered.at(-1).id, value: null });
    assert.equal((await complete(failed, [], false, "error")).status, 200);
    await page.waitForFunction(() => document.querySelector("#nomenclature-stock-status").dataset.tone === "error");
    assert.equal(await page.locator("#nomenclature-stock-rows tr").count(), 100);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.locator("#nomenclature-stock-sentinel").scrollIntoViewIfNeeded();
    assert.equal(await poll(), null, "an error cannot cause automatic retry loops");
    await page.locator("#nomenclature-stock-refresh").click();
    const retried = await poll(20);
    assert.equal(retried.after, null); assert.equal(retried.query, failed.query);
    assert.equal((await complete(retried, [{ ...filtered[0], id: randomUUID(), name: "Фильтр из конца склада" }])).status, 200);
    await page.locator("#nomenclature-stock-loading").waitFor({ state: "hidden" });

    await input.fill("00001"); await input.press("Enter");
    const articleSearch = await poll(20);
    assert.equal(articleSearch.query, "00001"); assert.equal(articleSearch.after, null);
    assert.equal((await complete(articleSearch, [{ id: randomUUID(), name: "Товар из конца склада", article: "00001", quantity: 3 }])).status, 200);
    await page.locator("#nomenclature-stock-rows").getByText("Товар из конца склада", { exact: true }).waitFor();
    await input.fill("AB12XY"); await input.press("Enter");
    const articleFragments = await poll(20);
    assert.equal(articleFragments.query, "ab12xy");
    const articleProduct = { id: randomUUID(), name: "Фильтр по артикулу", article: "AB-12-XY", quantity: 2 };
    assert.equal((await complete(articleFragments, [articleProduct])).status, 200);
    const articleRow = page.locator("#nomenclature-stock-rows tr").first();
    await articleRow.waitFor();
    assert.equal(await articleRow.locator("td").nth(1).locator("strong").textContent(), "AB-12-XY");

    await input.fill("кол тор"); await input.press("Enter");
    const fragments = await poll(20);
    assert.equal(fragments.query, "кол тор");
    const brakePads = ["Тормозные колодки", "Колодки тормозные"].map((name) => ({ id: randomUUID(), name, article: "PAD", quantity: 1 }));
    assert.equal((await complete(fragments, brakePads)).status, 200);
    for (const item of brakePads) await page.locator("#nomenclature-stock-rows").getByText(item.name, { exact: true }).waitFor();
    assert.equal(await page.locator("#nomenclature-stock-rows tr").first().locator("strong").count(), 2);
    const readsBeforeReverse = reads.length;
    await input.fill(" ТОР кол кол ");
    assert.equal(await poll(), null);
    assert.equal(reads.length, readsBeforeReverse, "reversing/repeating fragments preserves the same search without HTTP");

    await input.fill("Не существует"); await input.press("Enter");
    const missing = await poll(20);
    assert.equal(missing.query, "не существует");
    assert.equal((await complete(missing, [])).status, 200);
    await page.locator("#nomenclature-stock-status").getByText("Товары не найдены.", { exact: true }).waitFor();
    assert.equal(await page.locator("#nomenclature-stock-table").isVisible(), true, "the header stays available to change sort even without matching rows");

    await input.fill("Старый");
    const oldSearch = await poll(20);
    await input.fill("Новый");
    const newSearch = await poll(20);
    assert.equal(oldSearch.query, "старый"); assert.equal(newSearch.query, "новый");
    assert.equal((await complete(oldSearch, [products[0]])).status, 409);
    assert.equal((await complete(newSearch, [])).status, 200);
    await page.waitForFunction(() => document.querySelector("#nomenclature-stock-status").textContent.includes("не найдены"));

    await input.fill("");
    const cleared = await poll(20);
    assert.equal(cleared.query, ""); assert.equal(cleared.after, null);
    assert.equal((await complete(cleared, [products[0]])).status, 200);
    await page.locator("#nomenclature-stock-loading").waitFor({ state: "hidden" });
    assert.equal(await page.locator("#nomenclature-stock-refresh").isEnabled(), true);
    await page.locator("#nomenclature-stock-refresh").click();
    const cancelled = await poll(20);
    await page.locator("#markup-function-tab").click();
    // A real subsequent API turn observes the closed browser request before delivery.
    await request("/api/nomenclature/connection");
    assert.equal((await complete(cancelled, [products[0]])).status, 409);
    await page.locator("#nomenclature-function-tab").click();
    const reopened = await poll(20);
    assert.equal(reopened.after, null);
    assert.equal((await complete(reopened, [{ ...products[0], name: "Свежий товар" }])).status, 200);
    await page.locator("#nomenclature-stock-rows").getByText("Свежий товар", { exact: true }).waitFor();
    assert.equal(reads.length, 15);

    await page.locator("#nomenclature-stock-refresh").click();
    let firstId;
    let lastId = null;
    for (let batch = 0; batch < 12; batch += 1) {
      const pending = await poll(20);
      assert.deepEqual(pending.after, lastId ? { id: lastId, value: null } : null); assert.equal(pending.query, "");
      const values = Array.from({ length: 100 }, (_, offset) => ({ id: randomUUID(),
        name: `Длинный список ${batch * 100 + offset + 1}`, article: String(batch * 100 + offset), quantity: 1 }));
      if (!batch) firstId = values[0].id;
      lastId = values.at(-1).id;
      assert.equal((await complete(pending, values, batch < 11)).status, 200);
      await page.locator("#nomenclature-stock-loading").waitFor({ state: "hidden" });
      if (!batch) await page.locator(`[data-product-id="${firstId}"]`).click();
      assert.match(await page.locator("#nomenclature-stock-statistics").textContent(), /Всего строк: 1.200; Выделено: 1/);
      assert.ok(await page.locator("#nomenclature-stock-rows tr").count() <= 300);
      if (batch < 11) await page.locator("#nomenclature-stock-sentinel").scrollIntoViewIfNeeded();
    }
    assert.equal(reads.length, 27, "1200 items require 12 additional requests without eager loading");
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.locator(`[data-product-id="${firstId}"]`).waitFor();
    assert.equal(await page.locator(`[data-product-id="${firstId}"]`).getAttribute("aria-selected"), "true", "selection survives row removal and reconstruction");
    assert.equal(reads.length, 27, "scrolling back uses loaded data");
    assert.ok(await page.locator("#nomenclature-stock-rows tr").count() <= 300);
    await page.setViewportSize({ width: 320, height: 844 });
    await page.locator(`[data-product-id="${firstId}"]`).waitFor();
    assert.ok(await page.locator("#nomenclature-stock-rows tr").count() <= 300);
    if (process.env.NOMENCLATURE_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.NOMENCLATURE_SCREENSHOT_DIR, "nomenclature-stock-long-mobile.png"), fullPage: false });
    const headerStyle = await page.locator("#nomenclature-stock-table th").first().evaluate((element) => {
      const actual = getComputedStyle(element);
      const reference = getComputedStyle(document.querySelector(".results-data-table th"));
      return ["backgroundColor", "fontSize", "fontWeight", "textTransform", "padding"].every((key) => actual[key] === reference[key]);
    });
    assert.equal(headerStyle, true, "stock uses the pricing header appearance");
    await page.evaluate(() => window.scrollTo(0, 0));
    for (const field of ["name", "article", "quantity"]) for (const direction of ["asc", "desc"]) {
      const button = page.locator(`[data-nomenclature-sort="${field}"]`);
      const before = reads.length;
      if (direction === "desc") await button.press("Enter"); else await button.click();
      const sorted = await poll(20, 5);
      assert.equal(sorted.sortField, field); assert.equal(sorted.sortDirection, direction); assert.equal(sorted.after, null);
      assert.equal(reads.length, before + 1, "a header click performs one fresh global request");
      assert.equal(await button.locator("..").getAttribute("aria-sort"), direction === "asc" ? "ascending" : "descending");
      assert.equal(await page.locator("#nomenclature-stock-table th[aria-sort]:not([aria-sort='none'])").count(), 1);
      assert.equal((await complete(sorted, [{ ...products[0], name: `${field} ${direction}` }])).status, 200);
      await page.locator("#nomenclature-stock-rows").getByText(`${field} ${direction}`, { exact: true }).waitFor();
    }
    // An in-flight page from the previous order must not overwrite the selected order.
    await page.locator('[data-nomenclature-sort="name"]').click();
    const obsoleteSort = await poll(20, 5);
    await page.locator('[data-nomenclature-sort="quantity"]').click();
    const currentSort = await poll(20, 5);
    const inspection = new DatabaseSync(process.env.GARAGE_DB_PATH);
    try {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (inspection.prepare("SELECT status FROM nomenclature_stock_requests WHERE id=?").get(obsoleteSort.id).status === "cancelled") break;
        await delay(10);
      }
    } finally { inspection.close(); }
    assert.equal((await complete(obsoleteSort, [products[0]])).status, 409);
    const ordered = products.map((item, index) => ({ ...item, quantity: index + 1 }));
    assert.equal((await complete(currentSort, ordered, true, "completed", "100")).status, 200);
    await page.waitForFunction(() => document.querySelectorAll("#nomenclature-stock-rows tr").length === 100);
    await page.locator("#nomenclature-stock-sentinel").scrollIntoViewIfNeeded();
    const continuation = await poll(20, 5);
    assert.equal(continuation.sortField, "quantity"); assert.equal(continuation.sortDirection, "asc");
    assert.deepEqual(continuation.after, { id: ordered.at(-1).id, value: "100" });
    assert.equal((await complete(continuation, [{ ...products[0], id: randomUUID(), name: "Остаток 101", quantity: 101 }])).status, 200);
    await page.locator("#nomenclature-stock-loading").waitFor({ state: "hidden" });
    assert.equal(await page.locator("#nomenclature-stock-rows tr").count(), 101);
    await page.setViewportSize({ width: 1280, height: 844 });
    await page.evaluate(() => window.scrollTo(0, 0));
    if (process.env.NOMENCLATURE_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.NOMENCLATURE_SCREENSHOT_DIR, "nomenclature-stock-sort-desktop.png"), fullPage: false });
    // Availability includes zero/negative rows, price selection adds a column without excluding missing prices.
    await page.locator("#nomenclature-availability").selectOption("all");
    const all = await poll(20);
    assert.deepEqual(all.options, { availability: "all", priceType: null });
    const noStock = [0, -2, 5].map((quantity, index) => ({ id: randomUUID(), name: "Товар " + index, article: "A" + index, quantity }));
    assert.equal((await complete(all, noStock)).status, 200);
    await page.locator("#nomenclature-stock-loading").waitFor({ state: "hidden" });
    assert.match(await page.locator("#nomenclature-stock-statistics").textContent(), /Всего строк: 3; Выделено: 0/);
    await page.locator("#nomenclature-price-enabled").check();
    const priced = await poll(20);
    assert.equal(priced.options.priceType, priceTypes[0].id);
    const prices = noStock.map((item, index) => ({ ...item, price: index === 0 ? null : { amount: index === 1 ? 0 : 1500.5, currency: "RUB", unit: "шт" } }));
    assert.equal((await complete(priced, prices)).status, 200);
    await page.locator("#nomenclature-stock-loading").waitFor({ state: "hidden" });
    await page.locator('[data-nomenclature-sort="price"]').click();
    const sortedPrice = await poll(20);
    assert.equal(sortedPrice.sortField, "price"); assert.equal(sortedPrice.sortDirection, "asc"); assert.deepEqual(sortedPrice.options, { availability: "all", priceType: priceTypes[0].id });
    assert.equal((await complete(sortedPrice, prices)).status, 200);
    await page.locator("#nomenclature-stock-loading").waitFor({ state: "hidden" });
    assert.equal(await page.locator("#nomenclature-stock-price-heading").textContent(), priceTypes[0].name);
    assert.equal(await page.locator("[data-stock-price]").first().textContent(), "—");
    assert.match(await page.locator("[data-stock-price]").nth(1).textContent(), /0,00/);
    assert.doesNotMatch(await page.locator("[data-stock-price]").nth(1).textContent(), /шт/);
    assert.match(await page.locator("[data-stock-price]").nth(2).textContent(), /1.500,50/);
    for (const width of [320, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      await page.evaluate(() => window.scrollTo(0, 0));
      const toolbar = await page.locator(".nomenclature-toolbar").evaluate((element) => {
        const actions = element.querySelector(".nomenclature-toolbar__actions");
        return { toolbar: element.getBoundingClientRect(), scanner: element.firstElementChild.getBoundingClientRect(), actions: actions.getBoundingClientRect(), controls: [...actions.children].map((item) => item.getBoundingClientRect()) };
      });
      if (width > 600) assert.ok(Math.abs((toolbar.scanner.y + toolbar.scanner.height / 2) - (toolbar.actions.y + toolbar.actions.height / 2)) < 1, "scanner and search controls share one row");
      assert.ok(toolbar.controls.every((item) => item.right <= toolbar.toolbar.right + 1));
      if (process.env.NOMENCLATURE_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.NOMENCLATURE_SCREENSHOT_DIR, "nomenclature-filters-" + width + ".png") });
    }
    await page.locator("#nomenclature-price-type").selectOption(priceTypes[1].id);
    const otherPrice = await poll(20);
    assert.equal(otherPrice.options.priceType, priceTypes[1].id);
    assert.equal((await complete(otherPrice, prices)).status, 200);
    await page.locator("#nomenclature-stock-loading").waitFor({ state: "hidden" });
    assert.equal(await page.locator("#nomenclature-stock-price-heading").textContent(), priceTypes[1].name);
    await page.locator("#nomenclature-availability").selectOption("absent");
    const absent = await poll(20);
    assert.equal(absent.options.availability, "absent");
    assert.equal((await complete(absent, prices.slice(0, 2))).status, 200);
    await page.locator("#nomenclature-stock-loading").waitFor({ state: "hidden" });
    await page.locator("#nomenclature-availability-enabled").uncheck();
    const disabled = await poll(20);
    assert.equal(disabled.options.availability, "all");
    assert.equal(await page.locator("#nomenclature-availability").isDisabled(), true);
    assert.equal((await complete(disabled, prices)).status, 200);
    await page.locator("#nomenclature-stock-loading").waitFor({ state: "hidden" });
    assert.equal(await page.locator("#nomenclature-stock-progress").textContent(), "");
    assert.equal(await page.locator("#nomenclature-function").getByText("1С на связи", { exact: true }).count(), 0);
    const readsBeforeError = reads.length;
    await page.route((url) => url.pathname === "/api/nomenclature/stock" && url.searchParams.get("q") === "пустой", (route) => route.fulfill({ status: 502, body: "" }));
    await input.fill("пустой"); await input.press("Enter");
    await page.locator("#nomenclature-stock-status").getByText("Сервер не смог загрузить остатки (HTTP 502). Обновите список.", { exact: true }).waitFor();
    assert.equal(await page.locator("#nomenclature-stock-progress").textContent(), "", "initial errors appear once");
    assert.equal(reads.length, readsBeforeError + 1); assert.equal(await poll(0, 4), null);
    const replacement = await (await request("/api/nomenclature/connection", { method: "POST", ...json({}) })).json();
    headers.Authorization = `Bearer ${replacement.token}`;
    await poll(0, 4);
    const beforeIncompatible = reads.length;
    await input.fill("несовместимый"); await input.press("Enter");
    await page.locator("#nomenclature-stock-status").getByText(/Обработчик 1С подключён, но не поддерживает/).waitFor();
    assert.equal(reads.length, beforeIncompatible + 1, "incompatibility needs one browser request and no timeout retries");
    assert.equal(await poll(0, 4), null, "unsupported reads do not occupy the queue");
    await poll(0, 5);
    await page.locator("#nomenclature-stock-refresh").click();
    const recovered = await poll(20);
    assert.equal((await complete(recovered, prices)).status, 200);
    await page.locator("#nomenclature-stock-loading").waitFor({ state: "hidden" });
    assert.equal(await page.locator("#nomenclature-stock-rows tr").count(), prices.length);
    assert.equal(await page.locator("#nomenclature-stock-status").textContent(), "");
    assert.deepEqual(errors, []);
    console.log("Stock browser: search/debounce/cancellation, 1200 items in 12 batches, <=300 DOM rows; price sort, keyboard, cancellation and sorted continuation, one HTTP per action.");
  } finally {
    await browser?.close();
    server.closeAllConnections(); await new Promise((done) => server.close(done));
    if (previous === undefined) delete process.env.GARAGE_DB_PATH; else process.env.GARAGE_DB_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
