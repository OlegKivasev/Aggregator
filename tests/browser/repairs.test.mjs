import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";
import { createAggregatorServer } from "../../src/backend/http/create-server.ts";

// Fictional data never enters the configured production database.
const secret = "browser-test-only-repairs-secret-32-bytes";
const card = {
  documentId: "12345678-abcd-1234-abcd-123456789abc", number: "ТЕСТ-1",
  date: "2026-11-03T14:30:00", vehicleName: '<img src=x onerror="window.repairsXss=1">', status: "В работе",
};

test("repairs browser list loads real API data, renders safely, refreshes, restores and preserves other sections", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aggregator-repairs-browser-"));
  const previousPath = process.env.GARAGE_DB_PATH;
  const previousSecret = process.env.ONEC_REPAIRS_INTEGRATION_SECRET;
  process.env.GARAGE_DB_PATH = join(directory, "garage.sqlite");
  process.env.ONEC_REPAIRS_INTEGRATION_SECRET = secret;
  let browser;
  const server = createAggregatorServer({ application: { streamSearch: async () => {} }, publicDir: resolve("src/frontend") });
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.TEST_BROWSER_EXECUTABLE_PATH });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, timezoneId: "America/Los_Angeles" });
    const errors = [];
    const repairRequests = [];
    let failList = false;
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.href === "https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" && process.env.REPAIRS_BOOTSTRAP_CSS_PATH) {
        return route.fulfill({ contentType: "text/css", body: await readFile(process.env.REPAIRS_BOOTSTRAP_CSS_PATH) });
      }
      if (url.origin !== origin) return route.abort();
      if (url.pathname === "/api/repairs") {
        repairRequests.push(request);
        if (failList) return route.fulfill({ status: 500, json: { message: "Test database unavailable" } });
        return route.continue();
      }
      if (!url.pathname.startsWith("/api/")) return route.continue();
      const data = {
        "/api/suppliers/sessions": { sessions: [] },
        "/api/applicability/api-key": { configured: false, persistent: false, maskedKey: null },
        "/api/applicability/proxies": { persistent: false, activeRouteId: null, proxies: [], directLimited: false, usage: { requestCount: 0 }, directUsage: { requestCount: 0, secondsUntilReset: null } },
        "/api/garage/vehicles": { vehicles: [] },
      };
      return route.fulfill({ json: data[url.pathname] ?? { articles: [], brandCounts: [], hasMore: false } });
    });
    await page.goto(origin);
    await page.waitForLoadState("networkidle");
    assert.equal(await page.locator("#markup-function").isVisible(), true);
    await page.locator("#repairs-function-tab").click();
    await page.getByText("Заказ-нарядов в работе нет.").waitFor();
    assert.equal(await page.locator("#repairs-count").textContent(), "0");
    assert.equal(await page.locator("#markup-function").isVisible(), false);
    assert.equal(await page.locator("#applicability-function").isVisible(), false);
    const send = async (value) => {
      const response = await fetch(`${origin}/api/integration/1c/repairs`, { method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` }, body: JSON.stringify(value) });
      assert.equal(response.status, 200);
      await response.arrayBuffer();
    };
    await send(card);
    await page.locator("#repairs-refresh").click();
    await page.locator("#repairs-count").getByText("1", { exact: true }).waitFor();
    assert.equal(await page.locator("#repairs-rows tr").count(), 1);
    assert.deepEqual(await page.locator("#repairs-rows td").allTextContents(), [card.vehicleName, "Наличие ещё не проверено"]);
    assert.equal(await page.locator("#repairs-rows img").count(), 0);
    assert.equal(await page.evaluate(() => window.repairsXss), undefined);
    const updated = { ...card, vehicleName: "Тестовый контрагент с длинным наименованием для проверки переноса в списке заказ-нарядов", status: "В работе" };
    await send(updated);
    await page.reload();
    await page.getByText(updated.vehicleName, { exact: true }).waitFor();
    assert.equal(await page.locator("#repairs-rows tr").count(), 1);
    assert.equal(await page.locator("#repairs-function-tab").getAttribute("aria-selected"), "true");
    for (const request of repairRequests) assert.equal((await request.allHeaders()).authorization, undefined);
    const clientStorage = await page.evaluate(() => JSON.stringify({ ...localStorage }));
    assert.equal(clientStorage.includes(secret), false);
    const rendered = await page.content();
    assert.equal(rendered.includes(secret), false);
    for (const [goodsReadiness, tone, label, detail] of [
      [{ totalPositions: 5, availablePositions: 2 }, "waiting", "Есть товары к получению", "В наличии 2 из 5 позиций"],
      [{ totalPositions: 5, availablePositions: 5 }, "ready", "Все товары в наличии", "В наличии 5 из 5 позиций"],
      [{ totalPositions: 0, availablePositions: 0 }, "empty", "Не найдено товаров", null],
    ]) {
      await send({ ...updated, goodsReadiness });
      await page.locator("#repairs-refresh").click();
      await page.getByText(label, { exact: true }).waitFor();
      assert.equal(await page.locator(".repairs-readiness").getAttribute("data-tone"), tone);
      assert.equal(await page.locator("#repairs-rows td").count(), 2);
      assert.equal(await page.locator("#repairs-function thead th").count(), 2);
      if (detail) assert.equal(await page.locator(".repairs-readiness-detail").textContent(), detail);
      else assert.equal(await page.locator(".repairs-readiness-detail").count(), 0);
    }
    const legal = { ...updated, goodsReadiness: { totalPositions: 5, availablePositions: 2 }, vehicleName: "Toyota Camry А123ВС", counterpartyName: 'ООО «Тестовый автопарк»' };
    await send(legal);
    await page.locator("#repairs-refresh").click();
    await page.locator(".repairs-counterparty").waitFor();
    assert.equal(await page.locator("#repairs-rows td").count(), 2);
    assert.equal(await page.locator(".repairs-vehicle-name").textContent(), legal.vehicleName);
    assert.equal(await page.locator(".repairs-counterparty").textContent(), legal.counterpartyName);
    assert.equal(await page.locator("#repairs-rows img").count(), 0);
    assert.equal(await page.evaluate(() => window.repairsXss), undefined);
    const vehicleBox = await page.locator(".repairs-vehicle-name").boundingBox();
    const counterpartyBox = await page.locator(".repairs-counterparty").boundingBox();
    assert.ok(counterpartyBox.y >= vehicleBox.y + vehicleBox.height);
    if (process.env.REPAIRS_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.REPAIRS_SCREENSHOT_DIR, "repairs-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.locator("#repairs-function-tab").isVisible(), true);
    assert.equal(await page.locator("#repairs-refresh").isVisible(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.locator(".repairs-table").evaluate((element) => element.scrollWidth <= element.clientWidth), true);
    if (process.env.REPAIRS_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.REPAIRS_SCREENSHOT_DIR, "repairs-mobile.png"), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    const unsafeCounterparty = '<img src=x onerror="window.repairsXss=1">';
    await send({ ...legal, counterpartyName: unsafeCounterparty });
    await page.locator("#repairs-refresh").click();
    await page.getByText(unsafeCounterparty, { exact: true }).waitFor();
    assert.equal(await page.locator("#repairs-rows img").count(), 0);
    assert.equal(await page.evaluate(() => window.repairsXss), undefined);
    await send({ ...legal, vehicleName: "" });
    await page.locator("#repairs-refresh").click();
    await page.getByText("Договор не указан", { exact: true }).waitFor();
    assert.equal(await page.locator(".repairs-counterparty").textContent(), legal.counterpartyName);
    await send(updated);
    await page.locator("#repairs-refresh").click();
    await page.waitForFunction(() => !document.querySelector("#repairs-refresh").disabled);
    assert.equal(await page.locator(".repairs-counterparty").count(), 0);
    failList = true;
    await page.locator("#repairs-refresh").click();
    await page.getByText("Не удалось загрузить заказ-наряды. Нажмите «Обновить».").waitFor();
    assert.equal(await page.locator("#repairs-count").isVisible(), false);
    assert.equal(await page.locator("#repairs-refresh").isEnabled(), true);
    failList = false;
    await page.locator("#repairs-refresh").click();
    await page.getByText(updated.vehicleName, { exact: true }).waitFor();
    await page.locator("#applicability-function-tab").click();
    assert.equal(await page.locator("#repairs-function").isVisible(), false);
    assert.equal(await page.locator("#applicability-function").isVisible(), true);
    await page.locator("#markup-function-tab").click();
    assert.equal(await page.locator("#markup-function").isVisible(), true);
    assert.equal(await page.locator("#repairs-function").isVisible(), false);
    await send({ ...updated, testPlatform: true, status: "В работе" });
    await page.locator("#repairs-function-tab").click();
    await page.locator(".repairs-test-label").waitFor();
    assert.equal(await page.locator("#repairs-rows tr").count(), 2);
    assert.equal(await page.locator(".repairs-test-label").count(), 1);
    assert.equal(await page.locator('[data-test-platform="true"]').getByText("Тест", { exact: true }).count(), 1);
    const cleanup = await fetch(`${origin}/api/integration/1c/repairs/test`, { method: "DELETE",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ confirmTestCleanup: true }) });
    assert.equal(cleanup.status, 200);
    assert.deepEqual(await cleanup.json(), { deleted: 1 });
    await page.locator("#repairs-refresh").click();
    await page.locator("#repairs-count").getByText("1", { exact: true }).waitFor();
    assert.equal(await page.locator(".repairs-test-label").count(), 0);
    assert.equal(await page.getByText(updated.vehicleName, { exact: true }).count(), 1);
    await send({ ...updated, status: "Завершен" });
    await page.locator("#repairs-refresh").click();
    await page.getByText("Заказ-нарядов в работе нет.", { exact: true }).waitFor();
    assert.equal(await page.locator("#repairs-count").textContent(), "0");
    await send(updated);
    await page.locator("#repairs-refresh").click();
    await page.locator("#repairs-count").getByText("1", { exact: true }).waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    if (previousPath === undefined) delete process.env.GARAGE_DB_PATH;
    else process.env.GARAGE_DB_PATH = previousPath;
    if (previousSecret === undefined) delete process.env.ONEC_REPAIRS_INTEGRATION_SECRET;
    else process.env.ONEC_REPAIRS_INTEGRATION_SECRET = previousSecret;
    await rm(directory, { recursive: true, force: true });
  }
});
