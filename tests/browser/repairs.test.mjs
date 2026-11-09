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
  let releaseList;
  const server = createAggregatorServer({ application: { streamSearch: async () => {} }, publicDir: resolve("src/frontend") });
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.TEST_BROWSER_EXECUTABLE_PATH });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, timezoneId: "America/Los_Angeles" });
    const errors = [];
    const repairRequests = [];
    let failList = false;
    let holdList = false;
    let onListHeld;
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
        if (holdList) await new Promise((resolve) => {
          releaseList = resolve;
          onListHeld();
        });
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
    assert.equal(await page.locator("#repairs-function-tab").isVisible(), false);
    assert.equal(await page.locator("#test-repairs-function-tab").isVisible(), false);
    await page.evaluate(() => localStorage.setItem("autoservice.activeFunction", "test-repairs"));
    await page.reload();
    await page.waitForLoadState("networkidle");
    assert.equal(await page.locator("#markup-function").isVisible(), true);
    assert.equal(await page.locator("#test-repairs-function").isVisible(), false);
    await page.clock.install();
    const waitForRepairIdle = () => page.waitForFunction(() => !document.querySelector("#repairs-refresh").disabled);
    const pollRepairs = async () => {
      await waitForRepairIdle();
      const response = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/repairs");
      await page.clock.runFor(10_001);
      await response;
      await waitForRepairIdle();
    };
    const send = async (value) => {
      const response = await fetch(`${origin}/api/integration/1c/repairs`, { method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` }, body: JSON.stringify(value) });
      assert.equal(response.status, 200);
      await response.arrayBuffer();
    };
    await send(card);
    await pollRepairs();
    await page.locator("#repairs-function-tab").waitFor();
    assert.equal(await page.locator("#test-repairs-function-tab").isVisible(), false);
    await page.locator("#repairs-function-tab").click();
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
      assert.equal(await page.locator("#repairs-function .repairs-readiness").getAttribute("data-tone"), tone);
      assert.equal(await page.locator("#repairs-rows td").count(), 2);
      assert.equal(await page.locator("#repairs-function thead th").count(), 2);
      if (detail) assert.equal(await page.locator("#repairs-function .repairs-readiness-detail").textContent(), detail);
      else assert.equal(await page.locator("#repairs-function .repairs-readiness-detail").count(), 0);
    }
    const legal = { ...updated, goodsReadiness: { totalPositions: 5, availablePositions: 2 }, vehicleName: "Toyota Camry | А123ВС163", counterpartyName: 'ООО «Тестовый автопарк»' };
    await send(legal);
    await page.locator("#repairs-refresh").click();
    await page.locator("#repairs-function .repairs-counterparty").waitFor();
    assert.equal(await page.locator("#repairs-rows td").count(), 2);
    assert.equal(await page.locator("#repairs-function .repairs-vehicle-name").textContent(), "Toyota Camry");
    assert.equal(await page.locator("#repairs-function .repairs-vehicle-plate").textContent(), "А123ВС163");
    assert.equal(await page.locator("#repairs-function .repairs-counterparty").textContent(), legal.counterpartyName);
    assert.equal(await page.locator("#repairs-rows img").count(), 0);
    assert.equal(await page.evaluate(() => window.repairsXss), undefined);
    const vehicleBox = await page.locator("#repairs-function .repairs-vehicle-name").boundingBox();
    const plateBox = await page.locator("#repairs-function .repairs-vehicle-plate").boundingBox();
    const counterpartyBox = await page.locator("#repairs-function .repairs-counterparty").boundingBox();
    assert.ok(plateBox.y >= vehicleBox.y + vehicleBox.height);
    assert.ok(counterpartyBox.y >= plateBox.y + plateBox.height);
    const assertVehicleStyles = async (mobile) => {
      assert.equal(await page.locator("#repairs-function .repairs-vehicle-name").evaluate((element) => getComputedStyle(element).fontSize), mobile ? "18px" : "12px");
      assert.equal(await page.locator("#repairs-function .repairs-vehicle-plate").evaluate((element) => getComputedStyle(element).fontSize), mobile ? "17px" : "12px");
      for (const id of ["repairs-refresh", "test-repairs-refresh"]) {
        assert.equal(await page.locator(`#${id}`).evaluate((element) => getComputedStyle(element).backgroundColor), "rgb(255, 75, 19)");
        assert.equal(await page.locator(`#${id}`).evaluate((element) => getComputedStyle(element).color), "rgb(255, 255, 255)");
      }
    };
    await page.mouse.move(0, 0);
    await page.addStyleTag({ content: ".repairs-function button { transition: none !important; }" });
    await assertVehicleStyles(false);
    assert.equal(await page.locator("#repairs-rows td").first().textContent().then((text) => text.includes("|")), false);
    assert.equal(await page.locator("#auth-toolbar #settings-toggle").isVisible(), true);
    assert.equal(await page.locator("#search-form #settings-toggle").count(), 0);
    await page.locator("#settings-toggle").click();
    assert.equal(await page.locator("#settings-drawer").isVisible(), true);
    await page.locator("#settings-close").click();
    const search = page.locator("#repairs-search");
    const beforeSearch = repairRequests.length;
    for (const query of ["tOyOtA", "camry", "A123BC163", "а 123 вс 163", "автопарк"]) {
      await search.fill(query);
      assert.equal(await page.locator("#repairs-rows .repairs-vehicle-name").textContent(), "Toyota Camry");
      assert.equal(await page.locator("#repairs-count").textContent(), "1 из 1");
    }
    await search.fill("несуществующая машина");
    assert.equal(await page.locator("#repairs-rows .repairs-vehicle-name").count(), 0);
    assert.equal(await page.locator("#repairs-count").textContent(), "0 из 1");
    assert.equal(await page.locator("#repairs-function-tab").isVisible(), true);
    assert.equal(await page.locator("#repairs-function").isVisible(), true);
    assert.equal(repairRequests.length, beforeSearch);
    await page.locator("#repairs-refresh").click();
    await waitForRepairIdle();
    assert.equal(await search.inputValue(), "несуществующая машина");
    assert.equal(await page.locator("#repairs-count").textContent(), "0 из 1");
    await search.fill("Toyota");
    await pollRepairs();
    assert.equal(await search.inputValue(), "Toyota");
    assert.equal(await page.locator("#repairs-rows .repairs-vehicle-name").textContent(), "Toyota Camry");
    await search.fill("");
    assert.equal(await page.locator("#repairs-count").textContent(), "1");
    if (process.env.REPAIRS_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.REPAIRS_SCREENSHOT_DIR, "repairs-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await assertVehicleStyles(true);
    assert.equal(await search.isVisible(), true);
    assert.equal(await page.locator("#repairs-function-tab").isVisible(), true);
    assert.equal(await page.locator("#repairs-refresh").isVisible(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.locator("#repairs-function .repairs-table").evaluate((element) => element.scrollWidth <= element.clientWidth), true);
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
    assert.equal(await page.locator("#repairs-function .repairs-counterparty").textContent(), legal.counterpartyName);
    await send(updated);
    await page.locator("#repairs-refresh").click();
    await page.waitForFunction(() => !document.querySelector("#repairs-refresh").disabled);
    assert.equal(await page.locator("#repairs-function .repairs-counterparty").count(), 0);
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
    const testVehicle = "Тестовая машина в отдельной вкладке";
    await send({ ...updated, testPlatform: true, vehicleName: testVehicle, goodsReadiness: { totalPositions: 5, availablePositions: 2 } });
    await pollRepairs();
    await page.locator("#repairs-function-tab").click();
    await page.locator("#repairs-count").getByText("1", { exact: true }).waitFor();
    assert.equal(await page.locator("#repairs-rows tr").count(), 1);
    assert.equal(await page.locator("#repairs-rows").getByText(updated.vehicleName, { exact: true }).count(), 1);
    assert.equal(await page.locator("#repairs-rows").getByText(testVehicle, { exact: true }).count(), 0);
    await page.locator("#test-repairs-function-tab").click();
    await page.locator("#test-repairs-rows").getByText(testVehicle, { exact: true }).waitFor();
    assert.equal(await page.locator("#repairs-function").isVisible(), false);
    assert.equal(await page.locator("#test-repairs-count").textContent(), "1");
    assert.equal(await page.locator("#test-repairs-rows tr").count(), 1);
    assert.deepEqual(await page.locator("#test-repairs-function thead th").allTextContents(), ["Наименование", "Готовность товаров"]);
    assert.equal(await page.locator("#test-repairs-rows .repairs-readiness").textContent(), "Есть товары к получению");
    assert.equal(await page.locator("#test-repairs-rows .repairs-readiness-detail").textContent(), "В наличии 2 из 5 позиций");
    await page.locator("#test-repairs-search").fill("нет такой машины");
    assert.equal(await page.locator("#test-repairs-count").textContent(), "0 из 1");
    assert.equal(await page.locator("#test-repairs-function").isVisible(), true);
    assert.equal(await page.locator("#repairs-search").inputValue(), "");
    await page.locator("#test-repairs-search").fill("ТЕСТОВАЯ машина");
    assert.equal(await page.locator("#test-repairs-rows .repairs-vehicle-name").textContent(), testVehicle);
    await page.reload();
    await page.locator("#test-repairs-rows").getByText(testVehicle, { exact: true }).waitFor();
    assert.equal(await page.locator("#test-repairs-function-tab").getAttribute("aria-selected"), "true");
    failList = true;
    await page.locator("#test-repairs-refresh").click();
    await page.locator("#test-repairs-feedback").getByText("Не удалось загрузить заказ-наряды. Нажмите «Обновить».").waitFor();
    failList = false;
    await page.locator("#test-repairs-refresh").click();
    await page.locator("#test-repairs-rows").getByText(testVehicle, { exact: true }).waitFor();
    const cleanup = await fetch(`${origin}/api/integration/1c/repairs/test`, { method: "DELETE",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ confirmTestCleanup: true }) });
    assert.equal(cleanup.status, 200);
    assert.deepEqual(await cleanup.json(), { deleted: 1 });
    await page.locator("#test-repairs-refresh").click();
    await page.locator("#test-repairs-function-tab").waitFor({ state: "hidden" });
    assert.equal(await page.locator("#test-repairs-function").isVisible(), false);
    assert.equal(await page.locator("#markup-function").isVisible(), true);
    assert.equal(await page.locator("#repairs-function-tab").isVisible(), true);
    await page.locator("#repairs-function-tab").click();
    await page.locator("#repairs-count").getByText("1", { exact: true }).waitFor();
    assert.equal(await page.locator("#repairs-rows").getByText(updated.vehicleName, { exact: true }).count(), 1);
    await send({ ...updated, status: "Завершен" });
    await page.locator("#repairs-refresh").click();
    await page.locator("#repairs-function-tab").waitFor({ state: "hidden" });
    assert.equal(await page.locator("#markup-function").isVisible(), true);
    await send(updated);
    await pollRepairs();
    await page.locator("#repairs-function-tab").waitFor();
    await page.locator("#repairs-function-tab").click();
    await page.locator("#repairs-count").getByText("1", { exact: true }).waitFor();
    // Reproduce a saved fourth product: the visible list updates without a button.
    await send({ ...updated, goodsReadiness: { totalPositions: 3, availablePositions: 3 } });
    await page.reload();
    await page.getByText("В наличии 3 из 3 позиций", { exact: true }).waitFor();
    await send({ ...updated, goodsReadiness: { totalPositions: 4, availablePositions: 3 } });
    holdList = true;
    const beforePoll = repairRequests.length;
    const listHeld = new Promise((resolve) => { onListHeld = resolve; });
    await page.clock.runFor(10_001);
    await listHeld;
    assert.equal(repairRequests.length, beforePoll + 1);
    assert.equal(await page.getByText("В наличии 3 из 3 позиций", { exact: true }).isVisible(), true);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    assert.equal(repairRequests.length, beforePoll + 1);
    holdList = false;
    releaseList();
    releaseList = undefined;
    await page.getByText("В наличии 3 из 4 позиций", { exact: true }).waitFor();
    assert.equal(await page.locator("#repairs-function .repairs-readiness").getAttribute("data-tone"), "waiting");
    assert.equal(await page.locator("#repairs-rows tr").count(), 1);

    failList = true;
    await pollRepairs();
    await page.getByText("Не удалось обновить заказ-наряды. Показаны ранее загруженные данные.", { exact: true }).waitFor();
    assert.equal(await page.getByText("В наличии 3 из 4 позиций", { exact: true }).isVisible(), true);
    assert.equal(await page.locator("#repairs-count").isVisible(), true);
    failList = false;
    await send({ ...updated, goodsReadiness: { totalPositions: 4, availablePositions: 4 } });
    await pollRepairs();
    await page.getByText("В наличии 4 из 4 позиций", { exact: true }).waitFor();
    assert.equal(await page.locator("#repairs-feedback").textContent(), "");

    // An unposting command from 1C removes the card without manual browser refresh.
    const removed = await fetch(`${origin}/api/integration/1c/repairs`, { method: "DELETE",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ documentId: card.documentId, testPlatform: false }) });
    assert.equal(removed.status, 200);
    await removed.arrayBuffer();
    await pollRepairs();
    await page.locator("#repairs-function-tab").waitFor({ state: "hidden" });
    assert.equal(await page.locator("#markup-function").isVisible(), true);
    await send({ ...updated, goodsReadiness: { totalPositions: 4, availablePositions: 4 } });
    await pollRepairs();
    await page.locator("#repairs-function-tab").waitFor();
    await page.locator("#repairs-function-tab").click();
    await page.getByText("В наличии 4 из 4 позиций", { exact: true }).waitFor();
    // Availability updates outside repairs; hidden browser pages pause all polling.
    await page.locator("#markup-function-tab").click();
    await waitForRepairIdle();
    const beforeInactive = repairRequests.length;
    for (let index = 0; index < 3; index++) await pollRepairs();
    assert.equal(repairRequests.length, beforeInactive + 3);
    await send({ ...updated, goodsReadiness: { totalPositions: 0, availablePositions: 0 } });
    await page.locator("#repairs-function-tab").click();
    await page.getByText("Не найдено товаров", { exact: true }).waitFor();
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const beforeHidden = repairRequests.length;
    await page.clock.runFor(30_001);
    assert.equal(repairRequests.length, beforeHidden);
    await send({ ...updated, goodsReadiness: { totalPositions: 4, availablePositions: 3 } });
    await page.evaluate(() => {
      delete document.hidden;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.getByText("В наличии 3 из 4 позиций", { exact: true }).waitFor();
    // The isolated test tab retains the same readiness renderer and background refresh.
    const testCard = { ...updated, testPlatform: true, vehicleName: testVehicle,
      goodsReadiness: { totalPositions: 5, availablePositions: 2 } };
    await send(testCard);
    await pollRepairs();
    await page.locator("#test-repairs-function-tab").click();
    await page.locator("#test-repairs-rows").getByText("В наличии 2 из 5 позиций", { exact: true }).waitFor();
    await send({ ...testCard, goodsReadiness: { totalPositions: 5, availablePositions: 5 } });
    const beforeTestPoll = repairRequests.length;
    await pollRepairs();
    await page.locator("#test-repairs-rows").getByText("Все товары в наличии", { exact: true }).waitFor();
    assert.equal(repairRequests.length, beforeTestPoll + 1);
    assert.equal(await page.locator("#test-repairs-rows .repairs-readiness-detail").textContent(), "В наличии 5 из 5 позиций");
    await page.locator("#repairs-function-tab").click();
    await page.locator("#repairs-rows").getByText("В наличии 3 из 4 позиций", { exact: true }).waitFor();
    assert.deepEqual(errors, []);
  } finally {
    releaseList?.();
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
