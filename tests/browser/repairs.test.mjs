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
    const manualRefreshRequests = [];
    const sourceCards = new Map();
    const workerHeaders = { Authorization: `Bearer ${secret}` };
    const pollSource = async (testPlatform) => {
      const response = await fetch(`${origin}/api/integration/1c/repairs/refresh/requests?testPlatform=${testPlatform}&waitSeconds=0`, { headers: workerHeaders });
      assert.equal(response.status, 200); return (await response.json()).request;
    };
    const confirmRefresh = async (created, testPlatform) => {
      const job = await pollSource(testPlatform);
      assert.equal(job.id, created.refresh.id);
      const repairs = [], removedDocumentIds = [];
      for (const id of job.documentIds) {
        const current = sourceCards.get(`${testPlatform}:${id}`);
        if (current?.status === "В работе") repairs.push({ ...current, goodsReadiness: current.goodsReadiness ?? { totalPositions: 0, availablePositions: 0 } });
        else removedDocumentIds.push(id);
      }
      const response = await fetch(`${origin}/api/integration/1c/repairs/refresh/results`, { method: "POST", headers: { ...workerHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: job.id, leaseId: job.leaseId, testPlatform, status: "success", repairs, removedDocumentIds }) });
      assert.equal(response.status, 200);
    };
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
      if (url.pathname.startsWith("/api/repairs/refresh")) {
        if (request.method() === "POST") manualRefreshRequests.push(request);
        if (failList) return route.fulfill({ status: 503, json: { message: "Test source unavailable" } });
        if (request.method() === "POST") {
          const testPlatform = url.searchParams.get("testPlatform") === "true";
          await pollSource(testPlatform);
          const response = await route.fetch();
          const created = await response.json();
          assert.equal(response.status(), 202);
          await confirmRefresh(created, testPlatform);
          const completed = await fetch(`${origin}/api/repairs/refresh/${created.refresh.id}?testPlatform=${testPlatform}`);
          return route.fulfill({ status: 202, json: await completed.json() });
        }
        return route.continue();
      }
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
      sourceCards.set(`${value.testPlatform === true}:${value.documentId}`, value);
    };
    await send(card);
    await pollRepairs();
    await page.locator("#repairs-function-tab").waitFor();
    assert.equal(await page.locator("#test-repairs-function-tab").isVisible(), false);
    await page.locator("#repairs-function-tab").click();
    await page.locator("#repairs-count").getByText("1", { exact: true }).waitFor();
    assert.equal(await page.locator("#repairs-rows tr").count(), 1);
    assert.deepEqual(await page.locator("#repairs-rows td").allTextContents(), [card.vehicleName, "Наличие ещё не проверено",
      "Оплата ещё не проверенаОсталось оплатить:Картой: —Наличка: —Суммы по способам оплаты ещё не получены из 1С"]);
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
      assert.equal(await page.locator("#repairs-rows td").count(), 3);
      assert.equal(await page.locator("#repairs-function thead th").count(), 3);
      if (detail) assert.equal(await page.locator("#repairs-function .repairs-readiness-detail").textContent(), detail);
      else assert.equal(await page.locator("#repairs-function .repairs-readiness-detail").count(), 0);
    }
    for (const [paymentStatus, label, amountDue] of [["payment_required", "Не оплачен", 20_500], ["partially_paid", "Частично оплачен", 10_500.29],
      ["partially_paid", "Частично оплачен", 500.01], ["paid", "Оплачен", 0], ["payment_required", "Не оплачен", undefined], [undefined, "Оплата ещё не проверена", undefined]]) {
      await send({ ...updated, paymentStatus, amountDue });
      await page.locator("#repairs-refresh").click();
      const badge = page.locator("#repairs-rows .repairs-payment");
      await badge.getByText(label, { exact: true }).waitFor();
      assert.equal(await badge.getAttribute("data-status"), paymentStatus ?? "unknown");
      if (paymentStatus === "payment_required" || paymentStatus === "partially_paid") {
        assert.equal(await badge.evaluate((element) => getComputedStyle(element).color), "rgb(163, 47, 39)");
      } else {
        if (paymentStatus === "paid") assert.equal(await badge.evaluate((element) => getComputedStyle(element).color), "rgb(33, 102, 60)");
      }
      if (paymentStatus === "paid") {
        assert.equal(await page.locator("#repairs-rows .repairs-payment-detail").count(), 0);
        continue;
      }
      assert.equal(await page.locator("#repairs-rows .repairs-payment-card").textContent(), "Картой: —");
      assert.equal(await page.locator("#repairs-rows .repairs-payment-cash").textContent(), "Наличка: —");
      assert.equal(await page.locator("#repairs-rows .repairs-payment-note").textContent(), "Суммы по способам оплаты ещё не получены из 1С");
    }
    const formatAmount = (value) => value.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    for (const [paymentOptions, expectedDiscount] of [
      [{ cardAmountDue: 10_500.29, cashAmountDue: 9_500.01, cashDiscountPercent: 4.88 }, "скидка 5%/1 000руб"],
      [{ cardAmountDue: 0.29, cashAmountDue: 0.01, cashDiscountPercent: 0 }, "скидка 0%/0руб"],
      [{ cardAmountDue: 0, cashAmountDue: 0, cashDiscountPercent: 5 }, "скидка 5%/0руб"],
      [{ cardAmountDue: 100, cashAmountDue: 110, cashDiscountPercent: 0 }, "скидка 0%/0руб"],
      [{ cardAmountDue: 500, cashAmountDue: 299.51, cashDiscountPercent: 4.49 }, "скидка 4%/200руб"],
      [{ cardAmountDue: 500, cashAmountDue: 299.50, cashDiscountPercent: 4.50 }, "скидка 5%/201руб"],
      [{ cardAmountDue: 200.79, cashAmountDue: 0.29, cashDiscountPercent: 4.51 }, "скидка 5%/201руб"],
      [{ cardAmountDue: 500, cashAmountDue: 299.99, cashDiscountPercent: 5.50 }, "скидка 6%/200руб"],
      [{ cardAmountDue: 10_500.29, cashAmountDue: null, cashDiscountPercent: null }, null],
    ]) {
      await send({ ...updated, paymentStatus: paymentOptions.cardAmountDue ? "partially_paid" : "paid",
        amountDue: paymentOptions.cardAmountDue, paymentOptions });
      await page.locator("#repairs-refresh").click();
      await waitForRepairIdle();
      if (paymentOptions.cardAmountDue === 0) {
        assert.equal(await page.locator("#repairs-rows .repairs-payment").textContent(), "Оплачен");
        assert.equal(await page.locator("#repairs-rows .repairs-payment-detail").count(), 0);
        continue;
      }
      const expectedCard = `Картой: ${formatAmount(paymentOptions.cardAmountDue)}`;
      await page.locator("#repairs-rows .repairs-payment-card").getByText(expectedCard, { exact: true }).waitFor();
      const discount = page.locator("#repairs-rows .repairs-payment-discount");
      const expectedCash = paymentOptions.cashAmountDue === null ? "Наличка: Недоступно"
        : `Наличка: ${formatAmount(paymentOptions.cashAmountDue)} (${expectedDiscount})`;
      assert.equal((await page.locator("#repairs-rows .repairs-payment-cash").textContent()).replaceAll("\u00a0", " "), expectedCash.replaceAll("\u00a0", " "));
      assert.equal(await page.locator("#repairs-rows .repairs-payment-detail > span").textContent(), "Осталось оплатить:");
      assert.equal(await page.locator("#repairs-rows .repairs-payment-note").count(), 0);
      if (paymentOptions.cashDiscountPercent !== null) {
        assert.equal(await discount.evaluate((element) => element.tagName), "STRONG");
        assert.equal(await discount.evaluate((element) => getComputedStyle(element).fontWeight), "800");
      } else assert.equal(await discount.count(), 0);
    }
    const legal = { ...updated, goodsReadiness: { totalPositions: 5, availablePositions: 2 }, paymentStatus: "partially_paid", amountDue: 10_500,
      paymentOptions: { cardAmountDue: 10_500, cashAmountDue: 9_975, cashDiscountPercent: 5 },
      vehicleName: "Toyota Camry | А123ВС163", counterpartyName: 'ООО «Тестовый автопарк»',
      contactName: "Анна Тестовая", contactPhone: "+7 (900) 123-45-67" };
    await send(legal);
    await page.locator("#repairs-refresh").click();
    await page.locator("#repairs-function .repairs-counterparty").waitFor();
    assert.equal(await page.locator("#repairs-rows td").count(), 3);
    assert.equal(await page.locator("#repairs-function .repairs-vehicle-name").textContent(), "Toyota Camry");
    assert.equal(await page.locator("#repairs-function .repairs-vehicle-plate").textContent(), "А123ВС163");
    assert.equal(await page.locator("#repairs-function .repairs-counterparty").textContent(), legal.counterpartyName);
    assert.equal(await page.locator("#repairs-rows .repairs-contact-name").textContent(), legal.contactName);
    assert.equal(await page.locator("#repairs-rows .repairs-contact-phone").textContent(), legal.contactPhone);
    assert.equal(await page.locator("#repairs-rows img").count(), 0);
    assert.equal(await page.evaluate(() => window.repairsXss), undefined);
    const vehicleBox = await page.locator("#repairs-function .repairs-vehicle-name").boundingBox();
    const plateBox = await page.locator("#repairs-function .repairs-vehicle-plate").boundingBox();
    const counterpartyBox = await page.locator("#repairs-function .repairs-counterparty").boundingBox();
    assert.ok(plateBox.y >= vehicleBox.y + vehicleBox.height);
    assert.ok(counterpartyBox.y >= plateBox.y + plateBox.height);
    const assertVehicleStyles = async (mobile) => {
      assert.equal(await page.locator("#repairs-rows .repairs-payment-card").evaluate((element) => getComputedStyle(element).color), "rgb(163, 47, 39)");
      assert.equal(await page.locator("#repairs-rows .repairs-payment-cash").evaluate((element) => getComputedStyle(element).color), "rgb(33, 102, 60)");
      assert.equal(await page.locator("#repairs-rows .repairs-payment-detail > span").evaluate((element) => getComputedStyle(element).color), "rgb(23, 32, 42)");
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
    const { contactName, contactPhone, ...withoutContacts } = legal;
    for (const contact of [{ contactName }, { contactPhone }, {}]) {
      await send({ ...withoutContacts, ...contact });
      await page.locator("#repairs-refresh").click();
      await page.waitForFunction(() => !document.querySelector("#repairs-refresh").disabled);
      for (const [field, selector] of [["contactName", ".repairs-contact-name"], ["contactPhone", ".repairs-contact-phone"]]) {
        const element = page.locator(`#repairs-rows ${selector}`);
        assert.equal(await element.count(), contact[field] ? 1 : 0);
        if (contact[field]) assert.equal(await element.textContent(), contact[field]);
      }
    }
    const unsafeCounterparty = '<img src=x onerror="window.repairsXss=1">';
    await send({ ...legal, counterpartyName: unsafeCounterparty, contactName: unsafeCounterparty, contactPhone: unsafeCounterparty });
    await page.locator("#repairs-refresh").click();
    await page.locator("#repairs-rows .repairs-counterparty").filter({ hasText: unsafeCounterparty }).waitFor();
    assert.equal(await page.locator("#repairs-rows img").count(), 0);
    assert.equal(await page.evaluate(() => window.repairsXss), undefined);
    assert.equal(await page.locator("#repairs-rows .repairs-contact-name").textContent(), unsafeCounterparty);
    assert.equal(await page.locator("#repairs-rows .repairs-contact-phone").textContent(), unsafeCounterparty);
    await send({ ...legal, vehicleName: "" });
    await page.locator("#repairs-refresh").click();
    await page.getByText("Договор не указан", { exact: true }).waitFor();
    assert.equal(await page.locator("#repairs-function .repairs-counterparty").textContent(), legal.counterpartyName);
    await send(updated);
    await page.locator("#repairs-refresh").click();
    await page.waitForFunction(() => !document.querySelector("#repairs-refresh").disabled);
    assert.equal(await page.locator("#repairs-function .repairs-counterparty").count(), 0);
    assert.equal(await page.locator("#repairs-rows .repairs-contact").count(), 0);
    failList = true;
    await page.locator("#repairs-refresh").click();
    await page.getByText(/Произошёл сбой обновления.*Обратитесь в магазин/).waitFor();
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
    await send({ ...updated, testPlatform: true, vehicleName: testVehicle, goodsReadiness: { totalPositions: 5, availablePositions: 2 }, paymentStatus: "payment_required", amountDue: 20_500,
      paymentOptions: { cardAmountDue: 20_500, cashAmountDue: 19_475, cashDiscountPercent: 5 } });
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
    assert.deepEqual(await page.locator("#test-repairs-function thead th").allTextContents(), ["Наименование", "Готовность товаров", "Оплата"]);
    assert.equal(await page.locator("#test-repairs-rows .repairs-readiness").textContent(), "Есть товары к получению");
    assert.equal(await page.locator("#test-repairs-rows .repairs-readiness-detail").textContent(), "В наличии 2 из 5 позиций");
    assert.equal(await page.locator("#test-repairs-rows .repairs-payment").textContent(), "Не оплачен");
    assert.equal(await page.locator("#test-repairs-rows .repairs-payment-card").textContent(), `Картой: ${formatAmount(20_500)}`);
    assert.equal((await page.locator("#test-repairs-rows .repairs-payment-cash").textContent()).replaceAll("\u00a0", " "), "Наличка: 19 475,00 (скидка 5%/1 025руб)");
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
    await page.locator("#test-repairs-feedback").getByText(/Произошёл сбой обновления.*Обратитесь в магазин/).waitFor();
    failList = false;
    await page.locator("#test-repairs-refresh").click();
    await page.locator("#test-repairs-rows").getByText(testVehicle, { exact: true }).waitFor();
    const cleanup = await fetch(`${origin}/api/integration/1c/repairs/test`, { method: "DELETE",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ confirmTestCleanup: true }) });
    assert.equal(cleanup.status, 200);
    assert.deepEqual(await cleanup.json(), { deleted: 1 });
    sourceCards.delete(`true:${card.documentId}`);
    await pollRepairs();
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
    await page.getByText(/Произошёл сбой обновления.*Обратитесь в магазин/).waitFor();
    assert.equal(await page.getByText("В наличии 3 из 4 позиций", { exact: true }).isVisible(), false);
    assert.equal(await page.locator("#repairs-count").isVisible(), false);
    failList = false;
    await send({ ...updated, goodsReadiness: { totalPositions: 4, availablePositions: 4 } });
    await page.locator("#repairs-refresh").click();
    await page.getByText("В наличии 4 из 4 позиций", { exact: true }).waitFor();
    assert.match(await page.locator("#repairs-feedback").textContent(), /обновлены/);

    // A closed order leaves the list on the normal timer without issuing a manual 1C refresh.
    const beforeClose = manualRefreshRequests.length;
    await waitForRepairIdle();
    const removed = await fetch(`${origin}/api/integration/1c/repairs`, { method: "DELETE",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ documentId: card.documentId, testPlatform: false }) });
    assert.equal(removed.status, 200);
    sourceCards.delete(`false:${card.documentId}`);
    await removed.arrayBuffer();
    assert.equal(await page.locator("#repairs-rows .repairs-readiness").count(), 1);
    await pollRepairs();
    await page.locator("#repairs-function-tab").waitFor({ state: "hidden" });
    assert.equal(await page.locator("#markup-function").isVisible(), true);
    assert.equal(manualRefreshRequests.length, beforeClose);
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
