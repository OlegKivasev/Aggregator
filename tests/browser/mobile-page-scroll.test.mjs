import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve, sep } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";

// Long fictional lists exercise the real renderers without contacting suppliers.
const repairs = [false, true].flatMap((testPlatform) => Array.from({ length: 36 }, (_, index) => ({
  documentId: `mobile-${testPlatform}-${index}`, number: `ЗН-${index}`, date: "2026-11-09T10:00:00",
  vehicleName: `Toyota Land Cruiser ${index} | А123ВС163`, status: "В работе", testPlatform,
  counterpartyName: `Организация ${index} с длинным названием ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789`,
  goodsReadiness: { totalPositions: 12, availablePositions: index % 13 },
})));
const offers = Array.from({ length: 36 }, (_, index) => ({ supplier: "armtek", brand: "TEST", article: `A${index}`,
  title: `Тестовая запчасть ${index}`, quantity: 10, price: 100 + index, warehouse: "Тестовый склад",
  deliveryDate: null, deliveryDateApproximate: false, link: "https://etp.armtek.ru/" }));
const searches = Array.from({ length: 36 }, (_, index) => ({ id: `search-${index}`, sku: `OEM-${index}-${"A".repeat(50)}`,
  makeName: "FORD", hasSearched: true, results: [{ carId: index + 1, makeName: "FORD", modelName: "TEST",
    carName: `Тестовый автомобиль ${"B".repeat(100)}`, carType: "PC", yearStart: "2000", yearEnd: "2026" }] }));

async function withMobilePage(check) {
  const frontend = resolve("src/frontend");
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, "http://127.0.0.1").pathname;
    const file = resolve(frontend, `.${path === "/" ? "/index.html" : path}`);
    if (!file.startsWith(`${frontend}${sep}`)) return response.writeHead(404).end();
    try {
      response.writeHead(200, { "Content-Type": file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css"
        : file.endsWith(".json") ? "application/json" : file.endsWith(".png") ? "image/png" : "text/html" }).end(await readFile(file));
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.TEST_BROWSER_EXECUTABLE_PATH });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(({ offers, searches }) => {
      localStorage.setItem("autoservice.searchState", JSON.stringify({ activeTabId: "mobile", tabs: [
        { id: "mobile", article: "A1", enabledSuppliers: ["armtek"], results: offers },
      ] }));
      localStorage.setItem("autoservice.supplierVisibility", JSON.stringify(["armtek"]));
      localStorage.setItem("autoservice.applicabilityState", JSON.stringify({ activeTabId: "mobile", tabs: [
        { id: "mobile", name: "Детали", searches },
      ] }));
    }, { offers, searches });
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.href === "https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" && process.env.MOBILE_BOOTSTRAP_CSS_PATH) {
        return route.fulfill({ contentType: "text/css", body: await readFile(process.env.MOBILE_BOOTSTRAP_CSS_PATH) });
      }
      if (url.origin !== origin) return route.abort();
      if (!url.pathname.startsWith("/api/")) return route.continue();
      const data = {
        "/api/auth/session": { enabled: false },
        "/api/repairs": { repairs },
        "/api/suppliers/sessions": { sessions: [{ supplier: "armtek", authorized: true }] },
        "/api/applicability/api-key": { configured: true, persistent: false, maskedKey: "…TEST1" },
        "/api/applicability/proxies": { persistent: false, activeRouteId: null, proxies: [], directLimited: false,
          usage: { requestCount: 0 }, directUsage: { requestCount: 0, secondsUntilReset: null } },
        "/api/garage/vehicles": { vehicles: Array.from({ length: 36 }, (_, index) => ({ id: `car-${index}`, name: `Автомобиль ${index}` })) },
      };
      return route.fulfill({ json: data[url.pathname] ?? { articles: [], brandCounts: [], hasMore: false } });
    });
    await page.goto(origin);
    await page.waitForLoadState("networkidle");
    try {
      await check(page);
    } catch (error) {
      if (process.env.TEST_CAPTURE_DIR) await page.screenshot({ path: join(process.env.TEST_CAPTURE_DIR, "mobile-scroll-failure.png") });
      throw error;
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function assertNoNestedScroll(page, selector) {
  const problems = await page.locator(selector).evaluateAll((nodes) => nodes.filter((node) => node.getClientRects().length)
    .filter((node) => node.scrollHeight > node.clientHeight + 1 || node.scrollWidth > node.clientWidth + 1)
    .map((node) => ({ id: node.id, className: node.className, clientHeight: node.clientHeight, scrollHeight: node.scrollHeight,
      clientWidth: node.clientWidth, scrollWidth: node.scrollWidth })));
  assert.deepEqual(problems, [], "Mobile content must grow instead of creating nested scroll panes");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true,
    "The page must fit without horizontal panning");
}

async function assertPageScrolls(page, lastRow) {
  await page.evaluate(() => window.scrollTo(0, 0));
  assert.ok(await page.evaluate(() => document.scrollingElement.scrollHeight > innerHeight * 2), "Long lists must extend the document");
  await page.mouse.move(180, 450);
  await page.mouse.wheel(0, 400);
  await page.waitForFunction(() => window.scrollY > 100);
  await lastRow.scrollIntoViewIfNeeded();
  const bounds = await lastRow.boundingBox();
  assert.ok(bounds.y >= 0 && bounds.y < page.viewportSize().height, "The last item must be reachable by scrolling the page");
}

test("production and test repairs use full-width cards and page scrolling on mobile, retaining desktop tables", async () => {
  await withMobilePage(async (page) => {
    for (const prefix of ["repairs", "test-repairs"]) {
      await page.locator(`#${prefix}-function-tab`).click();
      await page.waitForFunction((prefix) => document.querySelectorAll(`#${prefix}-rows tr`).length === 36, prefix);
      for (const width of [320, 390, 768, 800]) {
        await page.setViewportSize({ width, height: 740 });
        await assertNoNestedScroll(page, `#${prefix}-function, #${prefix}-function .repairs-table`);
        const row = page.locator(`#${prefix}-rows tr`).first();
        const name = await row.locator("td").first().boundingBox();
        const readiness = await row.locator("td").last().boundingBox();
        assert.ok(readiness.y >= name.y + name.height, "Readiness must appear below the vehicle on mobile");
        assert.equal(await row.locator(".repairs-vehicle-plate").textContent(), "А123ВС163");
        await assertPageScrolls(page, page.locator(`#${prefix}-rows tr`).last());
        assert.equal(await page.locator(`#${prefix}-function .repairs-table`).evaluate((node) => node.scrollTop), 0);
      }
      if (process.env.TEST_CAPTURE_DIR) {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await page.locator("#auth-toolbar").scrollIntoViewIfNeeded();
        await page.screenshot({ path: join(process.env.TEST_CAPTURE_DIR, `${prefix}-mobile-scroll.png`) });
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      assert.equal(await page.locator(`#${prefix}-function thead`).isVisible(), true);
      assert.ok(await page.locator(`#${prefix}-function .repairs-table`).evaluate((node) => node.scrollHeight > node.clientHeight),
        "Desktop tables retain their internal scrolling");
    }
  });
});

test("pricing, garage lists and applicability results flow down the mobile page", async () => {
  await withMobilePage(async (page) => {
    await page.waitForFunction(() => document.querySelectorAll("#results-body .main-result-row").length === 36);
    await page.locator("#garage-toggle").click();
    await page.locator("#garage-vehicles li").last().waitFor();
    await assertNoNestedScroll(page, ".workspace, #results-panel, #results-table, #garage-sidebar, #garage-vehicles");
    await assertPageScrolls(page, page.locator("#results-body .main-result-row").last());
    await page.locator("#garage-close").click();
    await page.locator("#applicability-function-tab").click();
    await page.waitForFunction(() => document.querySelectorAll(".applicability-summary-row").length === 36);
    for (const width of [320, 390, 768, 800]) {
      await page.setViewportSize({ width, height: 740 });
      await assertNoNestedScroll(page, ".applicability-function, .applicability-workspace, .applicability-shell, .applicability-results-panel, .applicability-results-table");
      await assertPageScrolls(page, page.locator(".applicability-summary-row").last());
    }
    await page.locator(".applicability-expand").first().click();
    await assertNoNestedScroll(page, ".applicability-results-table, .applicability-raw");
    if (process.env.TEST_CAPTURE_DIR) {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: join(process.env.TEST_CAPTURE_DIR, "applicability-mobile-scroll.png") });
    }
  });
});
