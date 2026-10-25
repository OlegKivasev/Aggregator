import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve, sep } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";

// All history entries and search responses are fictional local fixtures.
async function withHistoryPage(check, { corrupt = false, blockedStorage = false } = {}) {
  const frontend = resolve("src/frontend");
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, "http://127.0.0.1").pathname;
    const file = resolve(frontend, `.${path === "/" ? "/index.html" : path}`);
    if (!file.startsWith(`${frontend}${sep}`)) return response.writeHead(404).end();
    try {
      const content = await readFile(file);
      const extension = file.split(".").at(-1);
      response.writeHead(200, { "Content-Type": ({ js: "text/javascript", css: "text/css", json: "application/json", png: "image/png" })[extension] ?? "text/html" }).end(content);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.TEST_BROWSER_EXECUTABLE_PATH });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    const searches = [];
    const applicabilitySearches = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(({ corrupt, blockedStorage }) => {
      if (!sessionStorage.getItem("history-initialized")) {
        localStorage.setItem("autoservice.supplierVisibility", JSON.stringify(["armtek"]));
        localStorage.setItem("autoservice.searchState", JSON.stringify({ activeTabId: "history-test", tabs: [{ id: "history-test", article: "", enabledSuppliers: ["armtek"], results: [] }] }));
        localStorage.setItem("autoservice.searchHistory", corrupt ? "{invalid" : JSON.stringify(Array.from({ length: 35 }, (_, index) => ({ query: `HIST${index}` }))));
        localStorage.setItem("autoservice.applicabilitySearchHistory", corrupt ? "{}" : JSON.stringify([
          { query: '<img src=x onerror="window.historyXss=1">', brands: ["FORD"] },
          ...Array.from({ length: 35 }, (_, index) => ({ query: `OEM${index}`, brands: ["FORD", "BMW"] })),
        ]));
        sessionStorage.setItem("history-initialized", "1");
      }
      if (blockedStorage) Storage.prototype.setItem = () => { throw new Error("Storage disabled"); };
    }, { corrupt, blockedStorage });
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (!url.pathname.startsWith("/api/")) return route.continue();
      if (url.pathname === "/api/search") {
        const article = url.searchParams.get("article");
        searches.push(article);
        const events = [
          { type: "search_started", article, suppliers: ["armtek"] },
          { type: "result", result: { supplier: "armtek", article, brand: "TEST", title: "Тестовый товар", quantity: 1, price: 100, warehouse: null, deliveryDate: null, deliveryDateApproximate: false, link: "https://etp.armtek.ru/" } },
          { type: "supplier_status", supplier: "armtek", status: "completed" },
          { type: "search_completed", article },
        ];
        return route.fulfill({ contentType: "text/event-stream", body: events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") });
      }
      if (url.pathname === "/api/applicability/search") {
        applicabilitySearches.push(route.request().postDataJSON());
        return route.fulfill({ json: { results: [], cacheHit: false } });
      }
      const data = {
        "/api/suppliers/sessions": { sessions: [{ supplier: "armtek", authorized: true, lastCheckedAt: null, lastAuthorizedAt: null }] },
        "/api/applicability/api-key": { configured: true, persistent: false, maskedKey: "…ABCDE" },
        "/api/applicability/cached-brands": { brands: [] },
        "/api/garage/vehicles": { vehicles: [] },
        "/api/applicability/proxies": { persistent: false, activeRouteId: null, proxies: [], directLimited: false, usage: { requestCount: 0 }, directUsage: { requestCount: 0, secondsUntilReset: null } },
      };
      return route.fulfill({ json: data[url.pathname] ?? { articles: [], brandCounts: [], hasMore: false } });
    });
    await page.goto(origin);
    await page.locator('#armtek-auth-form[data-authorized="true"]').waitFor({ state: "attached" });
    await check(page, { searches, applicabilitySearches });
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function focusHistory(root) {
  const input = root.locator("input");
  await input.blur();
  await input.focus();
  await root.locator(".search-history__panel").waitFor({ state: "visible" });
}

async function assertTenVisibleEntries(root) {
  const visibleCount = await root.locator(".search-history__list").evaluate((node) => {
    const bounds = node.getBoundingClientRect();
    return [...node.children].filter((option) => {
      const rect = option.getBoundingClientRect();
      return rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1;
    }).length;
  });
  assert.equal(visibleCount, 10);
}

test("search histories scroll, restore queries and brands, persist, and keep searches separate", async () => {
  await withHistoryPage(async (page, { searches, applicabilitySearches }) => {
    const pricing = page.locator("#search-form .search-history");
    const pricingInput = page.locator("#article-input");
    assert.equal(await page.locator(".search-history__toggle").count(), 0);
    await focusHistory(pricing);
    assert.equal(await pricing.getByRole("option").count(), 30);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("autoservice.searchHistory")).length), 30);
    await assertTenVisibleEntries(pricing);
    assert.equal(await pricing.locator(".search-history__list").evaluate((node) => node.scrollHeight > node.clientHeight), true);
    await pricing.getByRole("option", { name: "HIST29", exact: true }).click();
    assert.equal(await pricingInput.inputValue(), "HIST29");
    assert.deepEqual(searches, []);
    await pricingInput.fill("HIST24");
    assert.equal(await pricing.getByRole("option").count(), 1);
    assert.equal(await pricing.locator(".search-history__list").evaluate((node) => node.scrollHeight > node.clientHeight), false);
    await pricingInput.fill("HIST2");
    assert.equal(await pricing.getByRole("option").count(), 11);
    await pricingInput.press("ArrowDown");
    await pricingInput.press("Enter");
    assert.equal(await pricingInput.inputValue(), "HIST2");
    assert.deepEqual(searches, []);
    await pricingInput.fill("A1");
    await page.locator("#submit-button").click();
    await page.waitForFunction(() => document.querySelector("#submit-button").disabled === false);
    assert.deepEqual(searches, ["A1"]);
    await page.locator("#submit-button").click();
    await page.waitForFunction(() => document.querySelector("#submit-button").disabled === false);
    await page.reload();
    await focusHistory(pricing);
    assert.equal(await pricing.getByRole("option").first().textContent(), "A1");
    assert.equal(await pricing.getByRole("option", { name: "A1", exact: true }).count(), 1);
    assert.equal(await pricing.getByRole("option").count(), 30);
    assert.equal(await pricing.getByRole("option", { name: "HIST29", exact: true }).count(), 0);
    await pricingInput.press("Escape");
    assert.equal(await pricingInput.getAttribute("aria-expanded"), "false");
    await page.locator("#applicability-function-tab").click();
    const applicability = page.locator("#applicability-search-form .search-history");
    await focusHistory(applicability);
    assert.equal(await applicability.getByRole("option").count(), 30);
    await assertTenVisibleEntries(applicability);
    assert.equal(await applicability.locator(".search-history__list").evaluate((node) => node.scrollHeight > node.clientHeight), true);
    assert.equal(await applicability.locator(".search-history__list img").count(), 0);
    await applicability.getByRole("option").first().click();
    assert.equal(await page.evaluate(() => window.historyXss), undefined);
    await focusHistory(applicability);
    await applicability.getByRole("option", { name: "OEM5 FORD, BMW", exact: true }).click();
    assert.deepEqual(await page.locator(".applicability-make-chip__label").allTextContents(), ["FORD", "BMW"]);
    assert.deepEqual(applicabilitySearches, []);
    await page.locator("#applicability-sku").fill("APP-1, APP-2");
    await page.locator("#applicability-submit").click();
    await page.waitForFunction(() => document.querySelector("#applicability-submit").disabled === false);
    assert.equal(applicabilitySearches.length, 4);
    assert.deepEqual([...new Set(applicabilitySearches.map((entry) => entry.sku))], ["APP1", "APP2"]);
    await page.reload();
    await focusHistory(applicability);
    assert.equal(await applicability.getByRole("option").first().textContent(), "APP-1, APP-2FORD, BMW");
    assert.equal(await applicability.getByRole("option").count(), 30);
    assert.equal(await applicability.getByRole("option", { name: "OEM28 FORD, BMW", exact: true }).count(), 0);
    for (const root of [applicability, pricing]) {
      await page.setViewportSize({ width: 390, height: 1100 });
      if (root === pricing) await page.locator("#markup-function-tab").click();
      await focusHistory(root);
      await assertTenVisibleEntries(root);
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await root.locator(".search-history__panel").evaluate((node) => {
        const rect = node.getBoundingClientRect();
        return rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight && node.scrollWidth <= node.clientWidth;
      }), true);
      if (process.env.TEST_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.TEST_SCREENSHOT_DIR, `${root === pricing ? "pricing" : "applicability"}-search-history.png`) });
    }
    await pricing.locator(".search-history__clear").click();
    assert.equal(await pricing.getByRole("option").count(), 0);
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("autoservice.searchHistory"))), []);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("autoservice.applicabilitySearchHistory")).length), 30);
  });
});

test("corrupt history and unavailable browser storage do not block searches", async () => {
  await withHistoryPage(async (page, { searches }) => {
    await page.locator("#article-input").focus();
    await page.locator("#article-input").press("ArrowDown");
    assert.equal(await page.locator("#search-form").getByRole("option").count(), 0);
    await page.locator("#article-input").fill("A1");
    await page.locator("#submit-button").click();
    await page.waitForFunction(() => document.querySelector("#submit-button").disabled === false);
    assert.deepEqual(searches, ["A1"]);
  }, { corrupt: true, blockedStorage: true });
});
