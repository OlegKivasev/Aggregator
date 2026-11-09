import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve, sep } from "node:path";
import { chromium } from "playwright";

test("Autopiter connects, searches analogs from offers and discovered brands, filters returns and stays search-only", async () => {
  const frontend = resolve("src/frontend");
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, "http://127.0.0.1").pathname;
    const file = resolve(frontend, `.${path === "/" ? "/index.html" : path}`);
    if (!file.startsWith(`${frontend}${sep}`)) return response.writeHead(404).end();
    try {
      const content = await readFile(file);
      response.writeHead(200, { "Content-Type": file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html" }).end(content);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.TEST_BROWSER_EXECUTABLE_PATH });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const errors = [];
    const searches = [];
    const searchQueries = [];
    let authorized = false;
    let submitted;
    page.on("pageerror", (error) => errors.push(error.message));
    const session = () => ({ supplier: "autopiter", authorized, lastCheckedAt: null, lastAuthorizedAt: null });
    await page.addInitScript(() => {
      if (!sessionStorage.getItem("autopiter-test-initialized")) {
        localStorage.setItem("autoservice.supplierVisibility", JSON.stringify(["autopiter"]));
        sessionStorage.setItem("autopiter-test-initialized", "true");
      }
    });
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (!url.pathname.startsWith("/api/")) return route.continue();
      if (url.pathname === "/api/suppliers/autopiter/authorize") {
        submitted = route.request().postDataJSON(); authorized = true;
        return route.fulfill({ json: { session: session() } });
      }
      if (url.pathname === "/api/suppliers/autopiter/logout") {
        authorized = false; return route.fulfill({ json: { session: session() } });
      }
      if (url.pathname === "/api/suppliers/sessions/validate") return route.fulfill({ json: { sessions: [session()], results: [{ supplier: "autopiter", status: "connected" }] } });
      if (url.pathname === "/api/search") {
        searches.push(url.searchParams.getAll("supplier"));
        const mode = url.searchParams.get("mode");
        const article = url.searchParams.get("article");
        searchQueries.push({ mode, article, brand: url.searchParams.get("brand"), suppliers: url.searchParams.getAll("supplier") });
        const results = mode === "brands" ? [{ type: "brand_candidates", supplier: "autopiter", brands: ["TEST"] }]
          : article === "A0" && mode !== "analogs" ? []
          : [true, false].map((isReturnable) => ({ type: "result", result: { supplier: "autopiter", article: mode === "analogs" ? "B1" : article,
            brand: mode === "analogs" ? "CROSS" : "TEST", ...(mode === "analogs" ? { isAnalog: true } : {}),
            title: mode === "analogs" ? isReturnable ? "Возвратный аналог" : "Невозвратный аналог" : isReturnable ? "Возвратный фильтр" : "Невозвратный фильтр",
            price: isReturnable ? 150 : 100, quantity: 5, warehouse: "Тестовый склад", deliveryDate: null,
            deliveryDateApproximate: false, isReturnable, link: "https://autopiter.ru/" } }));
        const events = [{ type: "search_started", article, suppliers: ["autopiter"] }, ...results,
          { type: "supplier_status", supplier: "autopiter", status: "completed" }, { type: "search_completed", article }];
        return route.fulfill({ contentType: "text/event-stream", body: events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") });
      }
      const data = {
        "/api/suppliers/sessions": { sessions: [session()] },
        "/api/applicability/api-key": { configured: false, persistent: false, maskedKey: null },
        "/api/applicability/proxies": { persistent: false, activeRouteId: null, proxies: [], directLimited: false, usage: { requestCount: 0 }, directUsage: { requestCount: 0, secondsUntilReset: null } },
        "/api/garage/vehicles": { vehicles: [] },
      };
      return route.fulfill({ json: data[url.pathname] ?? { articles: [], brandCounts: [], hasMore: false } });
    });
    await page.goto(origin);
    const openSettings = async () => {
      await page.locator("#settings-toggle").click();
      const summary = page.locator("#settings-drawer summary").getByText("Поставщики", { exact: true });
      if (!await summary.evaluate((node) => node.parentElement.open)) await summary.click();
    };
    await openSettings();
    await page.locator("#autopiter-login").fill("123456");
    await page.locator("#autopiter-password").fill(" fixture-password ");
    await page.locator("#autopiter-connect-button").click();
    await page.locator('#autopiter-auth-form[data-authorized="true"]').waitFor();
    assert.deepEqual(submitted, { login: "123456", password: " fixture-password " });
    await page.locator("#settings-close").click();
    await page.locator("#article-input").fill("A1");
    await page.locator("#submit-button").click();
    await page.getByText("Возвратный фильтр", { exact: true }).waitFor();
    assert.equal(await page.getByText("Невозвратный фильтр", { exact: true }).count(), 0);
    assert.equal(await page.locator("#results-body .cart-offer-button:enabled").count(), 0);
    assert.deepEqual(searches, [["autopiter"]]);
    await page.locator("#results-body .results-table__row").click({ button: "right" });
    await page.locator("#show-analogs-button").click();
    await page.locator("#analogs-results-body").getByText("Возвратный аналог", { exact: true }).waitFor();
    assert.equal(await page.getByText("Невозвратный аналог", { exact: true }).count(), 0);
    assert.equal(await page.locator("#analogs-results-body .cart-offer-button:enabled").count(), 0);
    assert.deepEqual(searchQueries.at(-1), { mode: "analogs", article: "A1", brand: "TEST", suppliers: ["autopiter"] });
    await page.locator("#analogs-modal button[data-close-analogs-modal]").click();
    await openSettings();
    await page.locator('[data-supplier="autopiter"] summary').click();
    await page.locator("#autopiter-non-returnable").check();
    await page.locator("#settings-close").click();
    assert.equal(await page.getByText("Невозвратный фильтр", { exact: true }).isVisible(), true);
    assert.equal(await page.locator("#results-body .cart-offer-button:enabled").count(), 0);
    assert.equal(await page.evaluate(() => JSON.stringify(localStorage).includes("fixture-password")), false);
    await page.reload();
    await page.getByText("Невозвратный фильтр", { exact: true }).waitFor();
    await page.locator("#article-input").fill("A0");
    await page.locator("#submit-button").click();
    await page.locator('#article-analogs-modal-brands input[value="TEST"]').check();
    assert.deepEqual(searchQueries.at(-1), { mode: "brands", article: "A0", brand: null, suppliers: ["autopiter"] });
    await page.locator("#article-analogs-modal-continue").click();
    await page.locator("#analogs-results-body").getByText("Невозвратный аналог", { exact: true }).waitFor();
    assert.deepEqual(searchQueries.at(-1), { mode: "analogs", article: "A0", brand: "TEST", suppliers: ["autopiter"] });
    await page.locator("#analogs-modal button[data-close-analogs-modal]").click();
    await openSettings();
    await page.locator('[data-supplier="autopiter"] summary').click();
    assert.equal(await page.locator("#autopiter-non-returnable").isChecked(), true);
    await page.locator("#autopiter-non-returnable").uncheck();
    assert.equal(await page.getByText("Невозвратный фильтр", { exact: true }).count(), 0);
    await page.locator("#autopiter-logout-button").click();
    await page.locator('#autopiter-auth-form[data-authorized="false"]').waitFor();
    assert.equal(await page.locator('#autopiter-password').inputValue(), "");
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close(); server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
