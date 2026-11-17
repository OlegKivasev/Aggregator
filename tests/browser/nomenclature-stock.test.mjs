import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";
import { createAggregatorServer } from "../../src/backend/http/create-server.ts";

const json = (value, headers = {}) => ({ headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(value) });

test("stock opens automatically, renders bounded safe mobile pages and cancels work when leaving", async () => {
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
    const poll = async (wait = 0) => {
      const response = await request(`/api/integration/1c/nomenclature/requests?waitSeconds=${wait}&stock=1`, { headers });
      assert.equal(response.status, 200);
      return (await response.json()).request;
    };
    const complete = (job, products, hasMore = false, status = "completed") => request("/api/integration/1c/nomenclature/stock-results", {
      method: "POST", ...json({ requestId: job.id, leaseId: job.leaseId, products, hasMore, status }, headers),
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
    await page.locator("#nomenclature-stock-status").getByText("Загружаем товары в наличии…", { exact: true }).waitFor();
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
    assert.equal(await page.locator("#nomenclature-stock-rows tr").nth(1).locator("td").nth(1).textContent(), "—");
    assert.equal(await page.locator("#nomenclature-stock-previous").isDisabled(), true);
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      if (process.env.NOMENCLATURE_SCREENSHOT_DIR) {
        await mkdir(process.env.NOMENCLATURE_SCREENSHOT_DIR, { recursive: true });
        await page.locator("#nomenclature-function").screenshot({ path: join(process.env.NOMENCLATURE_SCREENSHOT_DIR, `nomenclature-stock-${width}.png`) });
      }
      assert.deepEqual(await page.locator(".nomenclature-stock").evaluate((element) => ({ width: element.clientWidth,
        overflow: element.scrollWidth > element.clientWidth,
        children: [...element.children].filter((child) => child.scrollWidth > element.clientWidth).map((child) => [child.className, child.scrollWidth]),
      })), { width: await page.locator(".nomenclature-stock").evaluate((element) => element.clientWidth), overflow: false, children: [] });
    }
    await page.locator("#nomenclature-stock-next").click();
    const second = await poll(20);
    assert.equal(second.after, products.at(-1).id);
    assert.equal(await page.locator("#nomenclature-stock-rows tr").count(), 0, "previous quantities are hidden during refresh");
    assert.equal((await complete(second, [{ ...products[2], name: "Последний товар" }])).status, 200);
    await page.locator("#nomenclature-stock-page").getByText("Страница 2", { exact: true }).waitFor();
    assert.equal(reads.length, 2);
    assert.equal(await page.locator("#nomenclature-stock-rows tr").count(), 1);
    assert.equal(await page.locator("#nomenclature-stock-next").isDisabled(), true);
    await page.locator("#nomenclature-stock-previous").click();
    const back = await poll(20);
    assert.equal(back.after, null); assert.notEqual(back.id, job.id);
    assert.equal((await complete(back, [])).status, 200);
    await page.locator("#nomenclature-stock-status").getByText("Товаров с положительным остатком нет.", { exact: true }).waitFor();
    assert.equal(await page.locator("#nomenclature-stock-table").isVisible(), false);
    await page.locator("#nomenclature-stock-refresh").click();
    const failed = await poll(20);
    assert.equal((await complete(failed, [], false, "error")).status, 200);
    await page.waitForFunction(() => document.querySelector("#nomenclature-stock-status").dataset.tone === "error");
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
    assert.equal(reads.length, 6);
    assert.deepEqual(errors, []);
    console.log("Stock browser: 6 page loads, 6 browser requests, <=100 rendered rows at 320/390/1280px.");
  } finally {
    await browser?.close();
    server.closeAllConnections(); await new Promise((done) => server.close(done));
    if (previous === undefined) delete process.env.GARAGE_DB_PATH; else process.env.GARAGE_DB_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
