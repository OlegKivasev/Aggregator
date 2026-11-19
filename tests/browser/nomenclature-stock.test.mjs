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
    const poll = async (wait = 0, capability = 8) => {
      const response = await request(`/api/integration/1c/nomenclature/requests?waitSeconds=${wait}&stock=${capability}`, { headers });
      assert.equal(response.status, 200);
      return (await response.json()).request;
    };
    const priceTypes = [{ id: randomUUID(), name: "Розничная цена" }, { id: randomUUID(), name: "Закупочная цена" }];
    const category = randomUUID(), categoryChild = randomUUID(), group = randomUUID(), groupChild = randomUUID(), oemBrand = randomUUID();
    const navigation = {
      categories: [{ id: randomUUID(), name: "Б — категория", parentId: null, isFolder: false }, { id: randomUUID(), name: "Я — папка", parentId: null, isFolder: true },
        { id: category, name: "Запчасти", parentId: null, isFolder: true }, { id: categoryChild, name: "Фильтры", parentId: category, isFolder: false },
        { id: randomUUID(), name: "А — категория", parentId: null, isFolder: false }, { id: randomUUID(), name: "А — папка", parentId: null, isFolder: true }],
      groups: [{ id: group, name: "Расходники", parentId: null, isFolder: true }, { id: groupChild, name: "Масла", parentId: group, isFolder: true }],
      oemBrands: [{ id: oemBrand, name: "Toyota" }],
    };
    const incoming = { original: 100, replacement: 1200 };
    const waitForCancellation = async (job) => {
      const database = new DatabaseSync(process.env.GARAGE_DB_PATH);
      try {
        const status = database.prepare("SELECT status FROM nomenclature_stock_requests WHERE id=?");
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (status.get(job.id).status === "cancelled") return;
          await delay(10);
        }
        assert.fail("Browser request was not cancelled");
      } finally { database.close(); }
    };
    const complete = (job, products, hasMore = false, status = "completed", lastSortValue = null, totalCount = hasMore ? 1200 : products.length) => request("/api/integration/1c/nomenclature/stock-results", {
      method: "POST", ...json({ requestId: job.id, leaseId: job.leaseId, products: products.map((item) => ({ incoming, ...item })), hasMore, status, lastSortValue, ...(status === "completed" && !job.after ? { totalCount, priceTypes, ...(job.options.navigation ? { navigation } : {}) } : {}) }, headers),
    });
    await poll();
    browser = await chromium.launch({ headless: true, executablePath: process.env.TEST_BROWSER_EXECUTABLE_PATH });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
    await page.clock.setFixedTime(new Date("2026-11-17T20:05:00Z"));
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
    assert.equal(await page.locator("#nomenclature-stock-loading strong").evaluate((element) => getComputedStyle(element).color), "rgb(0, 0, 0)", "loading message stays black while result matches are green");
    assert.deepEqual(job.options, { availability: "available", priceType: null, searchMode: "text", category: null, group: null, oemBrand: null,
      navigation: true, inventory: true });
    assert.equal(await page.locator("#nomenclature-receipt-enabled").isChecked(), false);
    assert.equal(await page.locator("#nomenclature-receipt-values").isVisible(), false);
    assert.equal(await page.locator("#nomenclature-stock-status").textContent(), "");
    const products = Array.from({ length: 100 }, (_, index) => ({ id: randomUUID(),
      name: index === 0 ? '<img src=x onerror="window.stockXss=1"> Товар с длинным наименованием' : `Тестовый товар ${index + 1}`,
      article: index === 1 ? "" : `0000${index}`, quantity: index === 0 ? 1.125 : index + 1 }));
    const interchangeable = { ...products[1], quantity: 20, stockDetails: { original: 5, replacements: [
      { name: "Совместимая деталь", article: "00007", quantity: 7 },
      { name: "<img src=x> Вторая деталь", article: "00008", quantity: 8 },
    ] } };
    assert.equal((await complete(job, [products[0], interchangeable, ...products.slice(2)], true)).status, 200);
    await page.waitForFunction(() => document.querySelectorAll("#nomenclature-stock-rows tr").length === 100);
    const second = await poll(20);
    assert.deepEqual(second.after, { id: products.at(-1).id, value: null });
    assert.equal(second.options.receipts, undefined);
    const amounts = page.locator("#nomenclature-stock-rows tr").first().locator("td:nth-child(4) span");
    assert.deepEqual(await amounts.allTextContents(), ["100", "1k+"]);
    assert.equal((await amounts.nth(1).locator("button").getAttribute("title")).replace(/\s/g, ""), "Замена:1200");
    assert.deepEqual(await page.locator("th.nomenclature-incoming .nomenclature-incoming-pair span").allTextContents(), ["О", "З"]);
    assert.equal(reads.length, 2, "one initial read and one background page ahead, without browser polling");
    const stockButton = page.getByRole("button", { name: "Остаток 20. Тестовый товар 2" });
    await stockButton.press("Enter");
    const stockDetails = page.getByRole("dialog", { name: "Остаток с учётом заказов" });
    assert.equal(await stockDetails.getByText("Всего 20").isVisible(), true);
    assert.deepEqual(await stockDetails.getByRole("region", { name: "Оригинал" }).locator("dd").allTextContents(), ["5"]);
    const replacements = stockDetails.getByRole("region", { name: "Замена" });
    assert.deepEqual(await replacements.locator("dd").allTextContents(), ["7", "8"]);
    assert.equal(await replacements.getByText("00008").isVisible(), true);
    assert.equal(await replacements.locator("img").count(), 0);
    await page.keyboard.press("Escape");
    assert.equal(await stockDetails.isVisible(), false);
    assert.equal(await stockButton.evaluate((node) => document.activeElement === node), true);
    assert.equal(reads.length, 2, "stock details use the page snapshot");
    assert.match(await page.locator("#nomenclature-stock-statistics").textContent(), /Выделено: 0$/);
    assert.equal(await page.locator("#nomenclature-stock-loading").isVisible(), false, "continuation never shows the initial spinner above the rows");
    assert.equal(await page.locator("#nomenclature-stock-more-loading").isVisible(), true);
    assert.equal(await page.locator("#nomenclature-stock-more-loading").textContent(), "Продолжается поиск…");
    assert.equal(await page.locator("#nomenclature-stock-more-loading").evaluate((element) => element.getBoundingClientRect().top >= document.querySelector("#nomenclature-stock-table").getBoundingClientRect().bottom), true);
    assert.equal(await page.locator("#nomenclature-stock-rows tr").first().locator("td").first().textContent(), products[0].name);
    assert.equal(await page.locator("#nomenclature-stock-rows img").count(), 0);
    assert.equal(await page.locator("#nomenclature-stock-rows tr").first().locator("td").nth(1).textContent(), "00000");
    assert.equal(await page.locator("#nomenclature-stock-rows tr").first().locator("td").nth(2).textContent(), "1,125");
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
    assert.equal(await page.locator("#nomenclature-stock-loading").isVisible(), false);
    await page.locator("#nomenclature-stock-more-loading").waitFor();
    assert.equal(await poll(), null, "repeated scrolling during a slow background read cannot create another page request");
    if (process.env.NOMENCLATURE_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.NOMENCLATURE_SCREENSHOT_DIR, "nomenclature-bottom-loading.png"), fullPage: false });
    await page.evaluate(() => window.scrollTo(0, 0));
    assert.equal((await complete(second, [{ ...products[2], id: randomUUID(), name: "Последний товар" }])).status, 200);
    await page.locator("#nomenclature-stock-more-loading").waitFor({ state: "hidden" });
    assert.equal(await page.locator("#nomenclature-stock-rows tr").count(), 100, "a completed background page stays buffered until the user approaches the end");
    assert.equal(await poll(), null, "a buffered page stops further requests while the user stays at the top");
    const beforeScroll = reads.length;
    await page.locator("#nomenclature-stock-sentinel").scrollIntoViewIfNeeded();
    await page.locator("#nomenclature-stock-rows").getByText("Последний товар", { exact: true }).waitFor();
    assert.equal(reads.length, beforeScroll, "scrolling consumes the prepared page without waiting for another HTTP response");
    assert.equal(reads.length, 2);
    assert.equal(await page.locator("#nomenclature-stock-rows tr").count(), 101);

    const input = page.locator("#nomenclature-stock-query");
    await input.fill("ф"); await input.fill("фи"); await input.fill("ФИЛЬТР");
    assert.equal(await page.locator("#nomenclature-stock-rows tr").count(), 0);
    const search = await poll(20);
    assert.equal(search.query, "фильтр"); assert.equal(search.after, null);
    await input.press("Enter");
    assert.equal(reads.length, 3, "rapid typing makes one search request");
    assert.equal(await poll(), null, "Enter while the same initial search is running does not lease another job");
    const filtered = products.map((product, index) => ({ ...product, id: randomUUID(), name: `Фильтр ${index + 1}` }));
    assert.equal((await complete(search, filtered, true)).status, 200);
    await page.waitForFunction(() => document.querySelectorAll("#nomenclature-stock-rows tr").length === 100);
    assert.equal(await poll(), null, "text search does not prepare a second page before scrolling");
    await page.locator("#nomenclature-stock-sentinel").scrollIntoViewIfNeeded();
    const obsoletePrefetch = await poll(20);
    await input.fill("фильтрx"); await input.fill("ФИЛЬТР");
    const reverted = await poll(20);
    assert.equal(reverted.query, "фильтр", "returning to the current query cancels the pending different query");
    await waitForCancellation(obsoletePrefetch);
    assert.equal((await complete(obsoletePrefetch, [{ ...filtered[0], id: randomUUID() }])).status, 409, "changing search cancels the old background page");
    assert.equal((await complete(reverted, filtered, true)).status, 200);
    await page.waitForFunction(() => document.querySelectorAll("#nomenclature-stock-rows tr").length === 100);
    await page.locator("#nomenclature-stock-sentinel").scrollIntoViewIfNeeded();
    const failed = await poll(20);
    assert.equal(failed.query, "фильтр"); assert.deepEqual(failed.after, { id: filtered.at(-1).id, value: null });
    assert.equal((await complete(failed, [], false, "error")).status, 200);
    await page.waitForFunction(() => document.querySelector("#nomenclature-stock-progress").dataset.tone === "error");
    assert.equal(await page.locator("#nomenclature-stock-status").textContent(), "", "continuation errors stay below the table");
    assert.equal(await page.locator("#nomenclature-stock-loading").isVisible(), false);
    assert.equal(await page.locator("#nomenclature-stock-more-loading").isVisible(), false);
    assert.equal(await page.locator("#nomenclature-stock-rows tr").count(), 100);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.locator("#nomenclature-stock-sentinel").scrollIntoViewIfNeeded();
    assert.equal(await poll(), null, "an error cannot cause automatic retry loops");
    await page.locator("#nomenclature-stock-retry").click();
    const retriedPage = await poll(20);
    assert.deepEqual(retriedPage.after, failed.after, "retry resumes the failed page instead of restarting the catalogue");
    assert.equal(retriedPage.query, failed.query);
    assert.equal((await complete(retriedPage, [{ ...filtered[0], id: randomUUID(), name: "После повтора" }])).status, 200);
    await page.locator("#nomenclature-stock-rows").getByText("После повтора", { exact: true }).waitFor();
    assert.equal(await page.locator("#nomenclature-stock-rows tr").count(), 101, "retry preserves the loaded rows");
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
    await input.fill(" ТОР кол кол "); await input.press("Enter");
    const reverse = await poll(20);
    assert.equal(reverse.query, "тор кол кол", "word order and repetition must reach 1C synonym matching unchanged");
    assert.equal((await complete(reverse, brakePads)).status, 200);
    await page.locator("#nomenclature-stock-loading").waitFor({ state: "hidden" });

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
    await waitForCancellation(oldSearch);
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
    await waitForCancellation(cancelled);
    assert.equal((await complete(cancelled, [products[0]])).status, 409);
    await page.locator("#nomenclature-function-tab").click();
    const reopened = await poll(20);
    assert.equal(reopened.after, null);
    assert.equal((await complete(reopened, [{ ...products[0], name: "Свежий товар" }])).status, 200);
    await page.locator("#nomenclature-stock-rows").getByText("Свежий товар", { exact: true }).waitFor();
    const beforeLargeList = reads.length;

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
      await page.locator(`[data-product-id="${lastId}"]`).waitFor({ state: "attached" });
      if (!batch) await page.locator(`[data-product-id="${firstId}"]`).click();
      assert.match(await page.locator("#nomenclature-stock-statistics").textContent(), /Всего строк: 1.200; Выделено: 1/);
      assert.ok(await page.locator("#nomenclature-stock-rows tr").count() <= 300);
      if (batch < 11) await page.locator("#nomenclature-stock-sentinel").scrollIntoViewIfNeeded();
    }
    assert.equal(reads.length, beforeLargeList + 12, "1200 items still require exactly 12 page requests including prefetch");
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.locator(`[data-product-id="${firstId}"]`).waitFor();
    assert.equal(await page.locator(`[data-product-id="${firstId}"]`).getAttribute("aria-selected"), "true", "selection survives row removal and reconstruction");
    assert.equal(reads.length, beforeLargeList + 12, "scrolling back uses loaded data");
    await page.setViewportSize({ width: 1920, height: 900 });
    await page.locator("#nomenclature-navigation-resize").dblclick();
    const longListOpener = await page.locator("#nomenclature-navigation-toggle").boundingBox();
    assert.ok(longListOpener.y >= 0 && longListOpener.y + longListOpener.height <= 900, "the three-dot opener stays visible beside a long virtual catalogue");
    await page.locator("#nomenclature-navigation-toggle").click();
    assert.equal(reads.length, beforeLargeList + 12, "collapsing a long-list sidebar does not reload inventory");
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
      const sorted = await poll(20);
      assert.equal(sorted.sortField, field); assert.equal(sorted.sortDirection, direction); assert.equal(sorted.after, null);
      assert.equal(reads.length, before + 1, "a header click performs one fresh global request");
      assert.equal(await button.locator("..").getAttribute("aria-sort"), direction === "asc" ? "ascending" : "descending");
      assert.equal(await page.locator("#nomenclature-stock-table th[aria-sort]:not([aria-sort='none'])").count(), 1);
      assert.equal((await complete(sorted, [{ ...products[0], name: `${field} ${direction}` }])).status, 200);
      await page.locator("#nomenclature-stock-rows").getByText(`${field} ${direction}`, { exact: true }).waitFor();
    }
    // An in-flight page from the previous order must not overwrite the selected order.
    await page.locator('[data-nomenclature-sort="name"]').click();
    const obsoleteSort = await poll(20);
    await page.locator('[data-nomenclature-sort="quantity"]').click();
    const currentSort = await poll(20);
    await waitForCancellation(obsoleteSort);
    assert.equal((await complete(obsoleteSort, [products[0]])).status, 409);
    const ordered = products.map((item, index) => ({ ...item, quantity: index + 1 }));
    assert.equal((await complete(currentSort, ordered, true, "completed", "100")).status, 200);
    await page.waitForFunction(() => document.querySelectorAll("#nomenclature-stock-rows tr").length === 100);
    await page.locator("#nomenclature-stock-sentinel").scrollIntoViewIfNeeded();
    const continuation = await poll(20);
    assert.equal(continuation.sortField, "quantity"); assert.equal(continuation.sortDirection, "asc");
    assert.deepEqual(continuation.after, { id: ordered.at(-1).id, value: "100" });
    assert.equal((await complete(continuation, [{ ...products[0], id: randomUUID(), name: "Остаток 101", quantity: 101 }])).status, 200);
    await page.locator("#nomenclature-stock-loading").waitFor({ state: "hidden" });
    assert.equal(await page.locator("#nomenclature-stock-rows tr").count(), 101);
    await page.setViewportSize({ width: 1280, height: 844 });
    await page.evaluate(() => window.scrollTo(0, 0));
    if (process.env.NOMENCLATURE_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.NOMENCLATURE_SCREENSHOT_DIR, "nomenclature-stock-sort-desktop.png"), fullPage: false });
    // Availability includes zero stock, and price selection keeps items without a price.
    await page.locator("#nomenclature-availability").selectOption("all");
    const all = await poll(20);
    assert.equal(all.options.availability, "all"); assert.equal(all.options.priceType, null);
    const noStock = [0, 0, 5].map((quantity, index) => ({ id: randomUUID(), name: "Товар " + index, article: "A" + index, quantity }));
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
    assert.equal(sortedPrice.sortField, "price"); assert.equal(sortedPrice.sortDirection, "asc"); assert.equal(sortedPrice.options.availability, "all"); assert.equal(sortedPrice.options.priceType, priceTypes[0].id);
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
    const beforeReceiptFilter = reads.length;
    await page.locator("#nomenclature-receipt-enabled").check();
    const receiptsToday = await poll(20);
    assert.deepEqual(receiptsToday.options.receipts, { from: "2026-11-18", to: "2026-11-18", source: "free" });
    assert.equal(reads.length, beforeReceiptFilter + 1);
    assert.equal((await complete(receiptsToday, prices)).status, 200);
    await page.locator("#nomenclature-stock-loading").waitFor({ state: "hidden" });
    await page.locator("#nomenclature-receipt-from").fill("2026-11-17");
    const longerPeriod = await poll(20);
    assert.deepEqual(longerPeriod.options.receipts, { from: "2026-11-17", to: "2026-11-18", source: "free" });
    assert.equal((await complete(longerPeriod, prices)).status, 200);
    await page.locator("#nomenclature-receipt-enabled").uncheck();
    const noReceipts = await poll(20);
    assert.equal(noReceipts.options.receipts, undefined);
    assert.equal((await complete(noReceipts, prices)).status, 200);
    await page.locator("#nomenclature-sale-enabled").check();
    const sales = await poll(20);
    assert.deepEqual(sales.options.sales, { from: "2026-11-11", to: "2026-11-18", source: "free" });
    assert.equal((await complete(sales, prices)).status, 200);
    await page.locator("#nomenclature-oem-enabled").check();
    const oemAbsent = await poll(20);
    assert.equal(oemAbsent.options.oemPresence, "absent");
    assert.equal((await complete(oemAbsent, prices)).status, 200);
    await page.locator("#nomenclature-oem-filter-brand").selectOption(oemBrand);
    const oemByBrand = await poll(20);
    assert.equal(oemByBrand.options.oemFilterBrand, oemBrand);
    assert.deepEqual(oemByBrand.options.sales, sales.options.sales);
    assert.equal(oemByBrand.options.searchMode, "text");
    assert.equal((await complete(oemByBrand, prices)).status, 200);
    await page.locator("#nomenclature-stock-loading").waitFor({ state: "hidden" });

    const beforeDetails = reads.length;
    const popover = page.getByRole("dialog", { name: "Поставки замен" });
    const replacementButton = page.locator("#nomenclature-stock-rows [data-incoming-side=replacement]").first();
    const originalButton = page.locator("#nomenclature-stock-rows [data-incoming-side=original]").first();
    const supplierOrder = (productId = randomUUID()) => ({
      orderId: randomUUID(), productId, supplier: 'Мотор-Снаб <b>поставка</b>', number: "0042",
      name: "Фильтр-замена", article: "ALT-11", ordered: 12, quantity: 8, expectedDate: "2026-11-22",
    });
    const sendIncoming = (job, orders, hasMore = false) => request("/api/integration/1c/nomenclature/stock-results", {
      method: "POST", ...json({ requestId: job.id, leaseId: job.leaseId, products: [], hasMore: false, status: "completed",
        incomingDetails: { orders, hasMore } }, headers),
    });
    await page.setViewportSize({ width: 320, height: 844 });
    await replacementButton.click();
    await popover.getByText("Загружаются заказы…").waitFor();
    assert.equal(await poll(0, 7), null, "v7 never receives supplier detail jobs");
    const details = await poll(20);
    assert.deepEqual(details.options.incomingDetails, { productId: prices[0].id, side: "replacement" });
    assert.equal((await sendIncoming(details, [supplierOrder(prices[0].id)])).status, 400);
    const incomingRows = Array.from({ length: 100 }, () => supplierOrder());
    assert.equal((await sendIncoming(details, incomingRows, true)).status, 200);
    await popover.getByText("Фильтр-замена · ALT-11", { exact: true }).first().waitFor();
    assert.equal(await popover.locator("b").count(), 0, "supplier text is never inserted as markup");
    assert.deepEqual(await popover.locator("dl").first().locator("dd").allTextContents(), ["12", "8", "22 нояб. 2026 г."]);
    const firstBounds = await popover.boundingBox();
    assert.ok(firstBounds.x >= 7 && firstBounds.x + firstBounds.width <= 320, "supplier details fit the mobile viewport");
    if (process.env.NOMENCLATURE_SCREENSHOT_DIR) await popover.screenshot({ path: join(process.env.NOMENCLATURE_SCREENSHOT_DIR, "nomenclature-incoming-320.png") });
    await popover.getByRole("button", { name: "Показать ещё" }).click();
    const moreIncoming = await poll(20);
    const lastOrder = incomingRows.at(-1);
    assert.deepEqual(moreIncoming.options.incomingDetails.after, { orderId: lastOrder.orderId, productId: lastOrder.productId });
    assert.equal((await sendIncoming(moreIncoming, [{ ...supplierOrder(), expectedDate: null }])).status, 200);
    await popover.getByText("Не указана", { exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await popover.waitFor({ state: "hidden" });
    assert.equal(await replacementButton.evaluate((button) => button === document.activeElement), true);
    await originalButton.press("Enter");
    const original = await poll(20);
    assert.equal(original.options.incomingDetails.side, "original");
    await page.keyboard.press("Escape");
    await waitForCancellation(original);
    assert.equal((await sendIncoming(original, [supplierOrder(prices[0].id)])).status, 409);
    assert.equal(reads.length, beforeDetails, "opening, paging and closing supplier orders never reloads the stock list");

    await page.setViewportSize({ width: 1280, height: 844 });
    await page.locator("#nomenclature-stock-refresh").click();
    await page.evaluate(() => window.scrollTo(0, 0));
    const firstSales = await poll(20);
    const soldProducts = products.map((item) => ({ ...item, price: null }));
    assert.equal((await complete(firstSales, soldProducts, true, "completed", '{"hasPrice":false,"amount":0}', 101)).status, 200);
    await page.waitForFunction(() => document.querySelectorAll("#nomenclature-stock-rows tr").length === 100);
    assert.equal(await poll(), null, "sales continuation waits until the user approaches the end");
    await page.locator("#nomenclature-stock-sentinel").scrollIntoViewIfNeeded();
    const nextSales = await poll(20);
    assert.deepEqual(nextSales.options.sales, firstSales.options.sales);
    assert.equal((await complete(nextSales, [{ ...soldProducts[0], id: randomUUID() }])).status, 200);
    await page.locator("#nomenclature-sale-enabled").uncheck();
    const withoutSales = await poll(20);
    assert.equal(withoutSales.options.sales, undefined);
    assert.equal((await complete(withoutSales, prices)).status, 200);
    await page.locator("#nomenclature-stock-loading").waitFor({ state: "hidden" });

    const readsBeforeError = reads.length;
    await page.route((url) => url.pathname === "/api/nomenclature/stock" && url.searchParams.get("q") === "пустой", (route) => route.fulfill({ status: 502, body: "" }));
    await input.fill("пустой"); await input.press("Enter");
    await page.locator("#nomenclature-stock-status").getByText("Сервер не смог загрузить остатки (HTTP 502). Обновите список.", { exact: true }).waitFor();
    assert.equal(await page.locator("#nomenclature-stock-progress").textContent(), "", "initial errors appear once");
    assert.equal(reads.length, readsBeforeError + 1); assert.equal(await poll(0, 4), null);
    const replacement = await (await request("/api/nomenclature/connection", { method: "POST", ...json({}) })).json();
    headers.Authorization = `Bearer ${replacement.token}`;
    await poll(0, 6);
    const beforeIncompatible = reads.length;
    await input.fill("несовместимый"); await input.press("Enter");
    await page.locator("#nomenclature-stock-status").getByText(/Обработчик 1С подключён, но не поддерживает/).waitFor();
    assert.equal(reads.length, beforeIncompatible + 1, "incompatibility needs one browser request and no timeout retries");
    assert.equal(await poll(0, 6), null, "unsupported reads do not occupy the queue");
    await poll();
    await page.locator("#nomenclature-stock-refresh").click();
    const recovered = await poll(20);
    assert.equal((await complete(recovered, prices)).status, 200);
    await page.locator("#nomenclature-stock-loading").waitFor({ state: "hidden" });
    assert.equal(await page.locator("#nomenclature-stock-rows tr").count(), prices.length);
    assert.equal(await page.locator("#nomenclature-stock-status").textContent(), "");

    let failConnection = true;
    const networkProducts = products.map((item) => ({ ...item, id: randomUUID(), price: null, incoming }));
    await page.route((url) => url.pathname === "/api/nomenclature/stock" && url.searchParams.get("q") === "сеть", (route) => {
      const cursor = new URL(route.request().url()).searchParams.get("after");
      if (!cursor) return route.fulfill({ json: { products: networkProducts, hasMore: true, nextCursor: "network-page-2", receivedAt: new Date().toISOString(), totalCount: 101, priceTypes } });
      assert.equal(cursor, "network-page-2");
      if (failConnection) { failConnection = false; return route.abort("failed"); }
      return route.fulfill({ json: { products: [{ ...networkProducts[0], id: randomUUID(), name: "После восстановления сети" }], hasMore: false, nextCursor: null, receivedAt: new Date().toISOString() } });
    });
    await input.fill("сеть"); await input.press("Enter");
    await page.waitForFunction(() => document.querySelectorAll("#nomenclature-stock-rows tr").length === 100);
    await page.locator("#nomenclature-stock-sentinel").scrollIntoViewIfNeeded();
    await page.locator("#nomenclature-stock-progress").getByText("Соединение с агрегатором прервано. Повторите загрузку.", { exact: true }).waitFor();
    assert.equal(await page.locator("#nomenclature-stock-rows tr").count(), 100);
    assert.equal(await page.locator("#nomenclature-stock-status").textContent(), "");
    assert.equal(await page.locator("#nomenclature-stock-more-loading").isVisible(), false);
    const beforeNetworkRetry = reads.length;
    await page.locator("#nomenclature-stock-retry").click();
    await page.locator("#nomenclature-stock-more-loading").waitFor({ state: "hidden" });
    await page.locator("#nomenclature-stock-sentinel").scrollIntoViewIfNeeded();
    await page.locator("#nomenclature-stock-rows").getByText("После восстановления сети", { exact: true }).waitFor();
    assert.equal(await page.locator("#nomenclature-stock-rows tr").count(), 101);
    assert.equal(reads.length, beforeNetworkRetry + 1, "network recovery retries only the missing page, retaining the original rows");
    await input.fill(""); await input.press("Enter");
    const afterNetwork = await poll(20);
    assert.equal((await complete(afterNetwork, prices)).status, 200);
    await page.locator("#nomenclature-stock-loading").waitFor({ state: "hidden" });

    const stateDatabase = new DatabaseSync(process.env.GARAGE_DB_PATH);
    try { stateDatabase.prepare("UPDATE nomenclature_sources SET last_seen=?").run(Date.now() - 90_001); }
    finally { stateDatabase.close(); }
    const beforeOffline = reads.length;
    await page.locator("#nomenclature-stock-refresh").click();
    await page.locator("#nomenclature-stock-status").getByText("Нет связи с сервером 1С. Проверьте подключение и серверное задание поиска.", { exact: true }).waitFor();
    await page.locator("#nomenclature-stock-loading").waitFor({ state: "hidden" });
    assert.equal(await page.locator("#nomenclature-stock-table").getAttribute("aria-busy"), null);
    await page.evaluate(() => window.dispatchEvent(new Event("scroll")));
    assert.equal(reads.length, beforeOffline + 1, "an offline source stops the spinner after one HTTP request without automatic retries");
    await poll();
    await page.locator("#nomenclature-stock-refresh").click();
    const reconnected = await poll(20);
    assert.equal((await complete(reconnected, prices)).status, 200);
    await page.locator("#nomenclature-stock-loading").waitFor({ state: "hidden" });
    assert.equal(await page.locator("#nomenclature-stock-rows tr").count(), prices.length);
    assert.equal(await page.locator("#nomenclature-stock-status").textContent(), "");
    // Tree expansion/search is local; selections are applied to the whole 1C catalogue.
    await page.setViewportSize({ width: 1280, height: 900 });
    const beforeTree = reads.length;
    assert.equal(await page.locator("#nomenclature-navigation").isVisible(), true);
    assert.deepEqual(await page.locator("#nomenclature-category-tree [data-navigation-id]").allTextContents(), ["А — папка", "Запчасти", "Я — папка", "А — категория", "Б — категория"], "folders sort alphabetically before category elements");
    assert.equal(await page.locator(".nomenclature-tree-expand img").count(), 0, "tree disclosure uses a plain arrow");
    await page.getByRole("button", { name: "Раскрыть Запчасти", exact: true }).click();
    await page.locator("#nomenclature-category-query").fill("фильт");
    await page.locator("#nomenclature-category-tree").getByRole("button", { name: "Фильтры", exact: true }).waitFor();
    assert.equal(reads.length, beforeTree, "expanding/searching the tree makes no HTTP requests");
    await page.locator(`[data-navigation-id="${categoryChild}"]`).click();
    let navigationJob = await poll(20);
    assert.equal(navigationJob.options.category, categoryChild); assert.equal(navigationJob.options.navigation, false);
    assert.equal((await complete(navigationJob, prices)).status, 200);
    await page.locator("#nomenclature-stock-loading").waitFor({ state: "hidden" });
    await page.getByRole("radio", { name: "Группы", exact: true }).check();
    const switchGroup = await poll(20); assert.equal(switchGroup.options.category, null); assert.equal(switchGroup.options.group, null);
    assert.equal((await complete(switchGroup, prices)).status, 200);
    await page.locator("#nomenclature-stock-loading").waitFor({ state: "hidden" });
    assert.equal(await page.locator("#nomenclature-category-query").isVisible(), false);
    await page.locator("#nomenclature-group-query").fill("масл");
    await page.locator(`[data-navigation-id="${groupChild}"]`).click();
    navigationJob = await poll(20);
    assert.equal(navigationJob.options.group, groupChild); assert.equal(navigationJob.options.category, null);
    assert.equal((await complete(navigationJob, prices)).status, 200);
    await page.locator("#nomenclature-stock-loading").waitFor({ state: "hidden" });
    const beforeClearTreeSearch = reads.length;
    await page.locator("#nomenclature-group-query").fill("");
    assert.equal(await page.locator(`[data-navigation-id="${groupChild}"]`).isVisible(), true, "the selected folder remains expanded after clearing the tree search");
    assert.equal(reads.length, beforeClearTreeSearch);
    await input.fill("Гранта"); await input.press("Enter");
    const synonymSearch = await poll(20);
    assert.equal(synonymSearch.query, "гранта");
    assert.equal(synonymSearch.options.highlightSynonyms, true);
    const synonymRows = [
      { ...prices[0], id: randomUUID(), name: "Опора Lada Granta", article: "GRANTA-123", nameMatches: ["granta"] },
      { ...prices[0], id: randomUUID(), name: "Кронштейн Гранта / Granta", nameMatches: ["granta"] },
      { ...prices[0], id: randomUUID(), name: "Гранта", article: "00001" },
    ];
    assert.equal((await complete(synonymSearch, synonymRows)).status, 200);
    const synonymName = page.locator(`[data-product-id="${synonymRows[0].id}"] td`).first();
    await synonymName.locator("strong").waitFor();
    assert.equal(await synonymName.textContent(), "Опора Lada Granta");
    assert.equal(await synonymName.locator("strong").textContent(), "Granta");
    assert.equal(await synonymName.locator("strong").evaluate((element) => getComputedStyle(element).color), "rgb(25, 135, 84)");
    assert.equal(await page.locator(`[data-product-id="${synonymRows[0].id}"] td:nth-child(2) strong`).count(), 0);
    assert.deepEqual(await page.locator(`[data-product-id="${synonymRows[1].id}"] td:first-child strong`).allTextContents(), ["Гранта", "Granta"]);
    assert.equal(await page.locator(`[data-product-id="${synonymRows[2].id}"] td:first-child strong`).textContent(), "Гранта");
    assert.equal(reads.length, beforeClearTreeSearch + 1, "synonym highlighting rides in the original stock response");

    await input.fill("L30914-248"); await input.press("Enter");
    const article = await poll(20);
    const exactArticle = { ...prices[0], name: "Фильтр", article: "L309-14-248" };
    assert.equal((await complete(article, [exactArticle])).status, 200);
    const highlighted = page.locator("#nomenclature-stock-rows td strong");
    await highlighted.waitFor(); assert.equal(await highlighted.textContent(), "L309-14-248");
    assert.equal(await highlighted.evaluate((element) => getComputedStyle(element).color), "rgb(25, 135, 84)");
    await page.locator("#nomenclature-search-settings").click();
    await page.getByRole("button", { name: "Поиск по OEM-артикулу", exact: true }).click();
    const oem = await poll(20); assert.equal(oem.options.searchMode, "oem"); assert.equal(oem.query, "");
    assert.equal((await complete(oem, prices)).status, 200);
    await page.locator("#nomenclature-stock-loading").waitFor({ state: "hidden" });
    await page.locator("#nomenclature-oem-brand").selectOption(oemBrand);
    const brandSearch = await poll(20); assert.equal(brandSearch.options.oemBrand, oemBrand);
    assert.equal((await complete(brandSearch, prices)).status, 200);
    await page.locator("#nomenclature-stock-loading").waitFor({ state: "hidden" });
    await input.fill("90915-YZZJ1"); await input.press("Enter");
    const oemNumber = await poll(20); assert.equal(oemNumber.query, "90915-yzzj1"); assert.equal(oemNumber.options.oemBrand, oemBrand);
    assert.equal(oemNumber.options.highlightSynonyms, undefined);
    assert.equal((await complete(oemNumber, [{ ...prices[0], nameMatches: ["granta"] }])).status, 400);
    assert.equal((await complete(oemNumber, prices)).status, 200);
    await page.locator("#nomenclature-stock-loading").waitFor({ state: "hidden" });
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `OEM controls fit at ${width}`);
      const inputWidth = (await input.boundingBox()).width;
      assert.ok(inputWidth >= 80, `OEM article field is ${inputWidth}px wide at ${width}px`);
      await page.locator("#nomenclature-search-settings").click();
      const menuBounds = await page.locator("#nomenclature-search-menu").boundingBox();
      assert.ok(menuBounds.x >= 0 && menuBounds.x + menuBounds.width <= width, "search settings stay within the viewport");
      await page.locator("#nomenclature-search-settings").press("Escape");
      if (process.env.NOMENCLATURE_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.NOMENCLATURE_SCREENSHOT_DIR, `nomenclature-oem-${width}.png`), fullPage: false });
    }
    await page.locator("#nomenclature-search-settings").click();
    await page.getByRole("button", { name: "Обычный поиск", exact: true }).click();
    const normal = await poll(20); assert.equal(normal.query, "l30914-248"); assert.equal(normal.options.oemBrand, null);
    assert.equal(await page.locator("#nomenclature-oem-brand").isVisible(), false);
    assert.equal((await complete(normal, [exactArticle])).status, 200);
    await page.locator("#nomenclature-stock-loading").waitFor({ state: "hidden" });
    for (const width of [320, 390, 1280, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `no page overflow at ${width}`);
      if (width >= 1280) {
        const layout = await page.evaluate(() => {
          const main = document.querySelector(".nomenclature-main").getBoundingClientRect();
          const sidebar = document.querySelector("#nomenclature-navigation").getBoundingClientRect();
          const search = document.querySelector(".nomenclature-toolbar").getBoundingClientRect();
          const table = document.querySelector(".nomenclature-stock").getBoundingClientRect();
          const field = document.querySelector("#nomenclature-stock-search").getBoundingClientRect();
          const scanner = document.querySelector("#nomenclature-scan").getBoundingClientRect();
          return { main: main.toJSON(), sidebar: sidebar.toJSON(), search: search.toJSON(), table: table.toJSON(), field: field.toJSON(), scanner: scanner.toJSON() };
        });
        const vertical = await page.evaluate(() => {
          const form = document.querySelector("#nomenclature-function").getBoundingClientRect();
          const panel = document.querySelector("#nomenclature-navigation").getBoundingClientRect();
          const handle = document.querySelector("#nomenclature-navigation-resize").getBoundingClientRect();
          return { bottom: form.bottom, panelBottom: panel.bottom, handleCenter: handle.top + handle.height / 2, panelCenter: panel.top + panel.height / 2,
            expectedBottom: innerHeight - parseFloat(getComputedStyle(document.querySelector(".page")).paddingBottom), padding: parseFloat(getComputedStyle(document.querySelector("#nomenclature-function")).paddingBottom) };
        });
        assert.ok(Math.abs(vertical.bottom - vertical.expectedBottom) <= 1, "short nomenclature fills the viewport down to the page padding");
        assert.ok(Math.abs(vertical.panelBottom - (vertical.bottom - vertical.padding)) <= 1, "navigation fills the full available form height");
        assert.ok(Math.abs(vertical.handleCenter - vertical.panelCenter) <= 1, "panel resize grip is centered vertically");
        assert.ok(layout.field.width <= 541, "article search keeps its compact maximum width");
        if (width === 1920) assert.ok(layout.field.left > layout.scanner.right + 100, "search stays on the right with free space after the scanner");
        assert.ok(layout.search.right <= layout.sidebar.left && Math.abs(layout.table.width - layout.main.width) < 1, "search and table stay inside the main column beside navigation");
      }
      if (process.env.NOMENCLATURE_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.NOMENCLATURE_SCREENSHOT_DIR, `nomenclature-navigation-${width}.png`), fullPage: false });
    }
    await page.setViewportSize({ width: 1920, height: 900 });
    const beforePanel = reads.length;
    const panel = page.locator("#nomenclature-navigation");
    const handle = page.locator("#nomenclature-navigation-resize");
    const toggle = page.locator("#nomenclature-navigation-toggle");
    assert.equal(Math.round((await panel.boundingBox()).width), 280, "default panel dimensions stay unchanged");
    assert.equal(await toggle.isVisible(), false, "three-dot opener occupies the panel edge only when collapsed");
    const bounds = await handle.boundingBox();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.down(); await page.mouse.move(bounds.x - 70, bounds.y + bounds.height / 2, { steps: 8 }); await page.mouse.up();
    assert.equal(Math.round((await panel.boundingBox()).width), 360, "dragging the left edge resizes the panel");
    assert.equal(await page.evaluate(() => localStorage.getItem("autoservice-aggregator.nomenclature-navigation-width.v1")), "360");
    await handle.press("Home"); assert.equal(Math.round((await panel.boundingBox()).width), 180);
    await handle.press("ArrowRight"); assert.equal(await panel.isVisible(), false, "shrinking at minimum width collapses the panel like the garage");
    assert.equal((await toggle.textContent()).trim(), "⋮"); await toggle.click();
    assert.equal(await panel.isVisible(), true); assert.equal(await toggle.getAttribute("aria-expanded"), "true");
    await handle.press("End"); assert.equal(Math.round((await panel.boundingBox()).width), 420);
    await handle.dblclick(); assert.equal(await panel.isVisible(), false);
    await toggle.click();
    // Dragging towards the right edge collapses the panel without changing the active catalogue filter.
    const narrow = await handle.boundingBox();
    await page.mouse.move(narrow.x + narrow.width / 2, narrow.y + narrow.height / 2);
    await page.mouse.down(); await page.mouse.move(narrow.x + 450, narrow.y + narrow.height / 2, { steps: 8 }); await page.mouse.up();
    assert.equal(await panel.isVisible(), false); await toggle.click();
    await handle.press("Home");
    for (let step = 0; step < 10; step += 1) await handle.press("ArrowLeft");
    assert.equal(Math.round((await panel.boundingBox()).width), 280);
    await page.setViewportSize({ width: 390, height: 900 });
    await page.locator("#nomenclature-navigation-close").click(); assert.equal(await panel.isVisible(), false);
    await toggle.click(); assert.equal(await panel.isVisible(), true);
    assert.equal(reads.length, beforePanel, "resize, collapse and expand use no HTTP or 1C requests");
    if (process.env.NOMENCLATURE_SCREENSHOT_DIR) {
      await page.setViewportSize({ width: 1920, height: 1238 });
      await page.waitForFunction(() => {
        const form = document.querySelector("#nomenclature-function");
        const panel = document.querySelector("#nomenclature-navigation");
        const bottom = innerHeight - parseFloat(getComputedStyle(document.querySelector(".page")).paddingBottom);
        return Math.abs(form.getBoundingClientRect().bottom - bottom) <= 1
          && Math.abs(panel.getBoundingClientRect().bottom - (bottom - parseFloat(getComputedStyle(form).paddingBottom))) <= 1;
      });
      await page.screenshot({ path: join(process.env.NOMENCLATURE_SCREENSHOT_DIR, "nomenclature-panel-final.png"), fullPage: false });
    }
    assert.deepEqual(errors, []);
    console.log("Stock browser: search/debounce/cancellation, 1200 items in 12 batches, <=300 DOM rows; price sort, keyboard, cancellation and sorted continuation, one HTTP per action.");
  } finally {
    await browser?.close();
    server.closeAllConnections(); await new Promise((done) => server.close(done));
    if (previous === undefined) delete process.env.GARAGE_DB_PATH; else process.env.GARAGE_DB_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
