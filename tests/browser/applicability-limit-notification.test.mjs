import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve, sep } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";

// Explicit browser regression test. All API responses are fictional test fixtures.
test("applicability key failures use a red toast and retain successful batch results", async () => {
  const frontendDir = resolve("src/frontend");
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, "http://127.0.0.1").pathname;
    const file = resolve(frontendDir, `.${path === "/" ? "/index.html" : path}`);
    if (!file.startsWith(`${frontendDir}${sep}`)) {
      response.writeHead(404).end();
      return;
    }
    try {
      const content = await readFile(file);
      const contentType = file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : file.endsWith(".json") ? "application/json" : file.endsWith(".png") ? "image/png" : "text/html";
      response.writeHead(200, { "Content-Type": contentType }).end(content);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.TEST_BROWSER_EXECUTABLE_PATH });
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let mode = "limit";
    const notice = "Закончились лимиты у ключа PartsAPI …ABCDE.";
    let saves = 0;
    const activations = [];
    let resetOnNextRead = false;
    let keyState = {
      configured: true, fallbackKeyCount: 2, persistent: true,
      primaryKey: { maskedKey: "…ABCDE", active: true, limited: false, resetAt: null, requestCount: 0 },
      fallbackKeys: ["…BBBBB", "…EEEEE"].map((maskedKey) => ({ maskedKey, active: false, limited: false, resetAt: null, requestCount: 0 })),
    };
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/applicability/search") {
        const { sku } = route.request().postDataJSON();
        if (mode === "rotation") {
          keyState = { ...keyState, primaryKey: { ...keyState.primaryKey, active: false, limited: true, resetAt: 1_900_000_000_000, requestCount: keyState.primaryKey.requestCount + 1 },
            fallbackKeys: keyState.fallbackKeys.map((key, index) => ({ ...key, active: index === 0, requestCount: key.requestCount + (index === 0 ? 1 : 0) })) };
          await route.fulfill({ json: { results: [{ carId: 1, makeName: "FORD", modelName: "TEST", carName: "2.0", carType: "PC", yearStart: null, yearEnd: null }], cacheHit: false } });
        } else if (mode === "successful") {
          for (const key of [keyState.primaryKey, ...keyState.fallbackKeys]) if (key.active) key.requestCount += 1;
          await route.fulfill({ json: { results: [{ carId: 1, makeName: "FORD", modelName: "TEST", carName: "2.0", carType: "PC", yearStart: null, yearEnd: null }], cacheHit: false } });
        } else if (mode.startsWith("mixed") && sku === "CACHED1") {
          await route.fulfill({ json: { results: [{ carId: 1, makeName: "FORD", modelName: "TEST", carName: "2.0", carType: "PC", yearStart: null, yearEnd: null }], cacheHit: true } });
        } else if (mode === "mixed-normalized" && sku === "CACHED-1") {
          await route.fulfill({ json: { results: [], cacheHit: false } });
        } else {
          await route.fulfill({ status: mode === "integration" ? 502 : 401, json: { message: mode === "integration" ? "Applicability search failed" : notice } });
        }
      } else if (path === "/api/applicability/api-key/active") {
        const { index } = route.request().postDataJSON();
        activations.push(index);
        [keyState.primaryKey, ...keyState.fallbackKeys].forEach((key, candidate) => { key.active = candidate === index; });
        await route.fulfill({ json: keyState });
      } else if (path === "/api/applicability/api-key") {
        if (resetOnNextRead && route.request().method() === "GET") {
          [keyState.primaryKey, ...keyState.fallbackKeys].forEach((key) => { key.requestCount = 0; key.limited = false; key.resetAt = null; });
        }
        if (route.request().method() === "PUT") {
          saves += 1;
          keyState = { ...keyState, primaryKey: { maskedKey: "…CCCCC", active: true, limited: false, resetAt: null, requestCount: 0 },
            fallbackKeys: keyState.fallbackKeys.map((key) => ({ ...key, active: false })) };
        }
        await route.fulfill({ json: keyState });
      } else if (path === "/api/applicability/cached-brands") {
        await route.fulfill({ json: { brands: [] } });
      } else if (path === "/api/suppliers/sessions") {
        await route.fulfill({ json: { sessions: [] } });
      } else if (path === "/api/garage/vehicles") {
        await route.fulfill({ json: { vehicles: [] } });
      } else {
        await route.fulfill({ json: { articles: [], brandCounts: [], hasMore: false } });
      }
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForLoadState("networkidle");
    await page.locator("#applicability-function-tab").click();
    await page.locator("#applicability-make").fill("FORD");
    await page.getByRole("option", { name: "FORD", exact: true }).click();
    const submit = page.locator("#applicability-submit");
    const toast = page.locator("#applicability-toast");
    const feedback = page.locator("#applicability-feedback");
    for (const sku of ["LIMIT1", "LIMIT2, LIMIT3", "CACHED-1, LIMIT4", "CACHED1, LIMIT5"]) {
      mode = sku.startsWith("CACHED-") ? "mixed-normalized" : sku.startsWith("CACHED1") ? "mixed" : "limit";
      if (mode === "mixed") {
        await page.locator("#applicability-new-tab").click();
        await page.locator("#applicability-make").fill("FORD");
        await page.getByRole("option", { name: "FORD", exact: true }).click();
      }
      await page.locator("#applicability-sku").fill(sku);
      await submit.click();
      await page.waitForFunction(() => !document.querySelector("#applicability-submit").disabled);
      assert.equal(await toast.textContent(), notice);
      assert.equal(await toast.getAttribute("data-tone"), "error");
      assert.equal(await toast.isVisible(), true);
      assert.equal(await feedback.isVisible(), false, JSON.stringify(await feedback.evaluate((node) => ({ text: node.textContent, hidden: node.hidden, display: getComputedStyle(node).display, sku: document.querySelector("#applicability-sku").value }))));
      assert.equal(await toast.evaluate((node) => getComputedStyle(node).backgroundColor), "rgb(255, 245, 244)");
      if (mode.startsWith("mixed")) assert.match(await page.locator("#applicability-results-body").textContent(), /CACHED1/);
    }
    mode = "integration";
    await page.locator("#applicability-sku").fill("BROKEN1");
    await submit.click();
    await page.waitForFunction(() => !document.querySelector("#applicability-submit").disabled);
    assert.equal(await feedback.textContent(), "Applicability search failed");
    assert.equal(await feedback.isVisible(), true);

    // Rotation updates settings, keeps a pending unsaved key and uses only a masked suffix.
    await page.locator("#applicability-settings-toggle").click();
    await page.locator("#applicability-fallback-keys").evaluate((node) => { node.open = true; });
    await page.locator("#applicability-fallback-key-add").click();
    await page.locator('#applicability-fallback-key-list .applicability-key-field:not([data-fallback-key-index]) input').fill("fictional-unsaved-DDDDD");
    await page.locator("#applicability-settings-close").click();
    mode = "rotation";
    await page.locator("#applicability-sku").fill("ROTATE1");
    await submit.click();
    await page.waitForFunction(() => !document.querySelector("#applicability-submit").disabled);
    assert.equal(await toast.textContent(), notice);
    assert.equal(await toast.getAttribute("data-tone"), "error");
    assert.equal(await feedback.isVisible(), false);
    assert.match(await page.locator("#applicability-results-body").textContent(), /ROTATE1/);
    await page.locator("#applicability-settings-toggle").click();
    await page.waitForLoadState("networkidle");
    assert.equal(await page.locator('#applicability-api-key').getAttribute("placeholder"), "…ABCDE");
    assert.equal(await page.locator('#applicability-api-key').evaluate((node) => getComputedStyle(node).borderTopColor), "rgb(217, 45, 32)");
    assert.equal(await page.locator('label[for="applicability-api-key"] > span').first().textContent(), "API-ключ PartsAPI — лимит исчерпан");
    assert.equal(await page.locator('[data-fallback-key-index="0"]').locator('..').locator('span').first().textContent(), "Основной API-ключ PartsAPI");
    assert.match(await page.locator("#applicability-primary-key-controls").textContent(), /Запросов за 24 часа: 1/);
    assert.equal(await page.locator("#applicability-primary-key-controls button").isDisabled(), true);
    assert.match(await page.locator('[data-fallback-key-index="0"]').locator('..').textContent(), /Запросов за 24 часа: 1/);
    assert.equal(await page.locator('#applicability-fallback-key-list .applicability-key-field:not([data-fallback-key-index]) input').inputValue(), "fictional-unsaved-DDDDD");
    assert.equal(await page.locator('#applicability-fallback-key-list .applicability-key-field:not([data-fallback-key-index]) input').count(), 1);

    // A saved original key must not be submitted again by the next search and reset rotation.
    await page.locator("#applicability-api-key").fill("fictional-new-primary-CCCCC");
    await page.locator("#applicability-api-key").press("Enter");
    await page.waitForFunction(() => document.querySelector("#applicability-api-key").value === "");
    assert.equal(saves, 1);
    await page.locator("#applicability-settings-close").click();
    await page.locator("#applicability-sku").fill("ROTATE2");
    await submit.click();
    await page.waitForFunction(() => !document.querySelector("#applicability-submit").disabled);
    assert.equal(saves, 1);
    assert.equal(await toast.textContent(), "Закончились лимиты у ключа PartsAPI …CCCCC.");

    await page.locator("#applicability-settings-toggle").click();
    await page.waitForLoadState("networkidle");
    await page.locator('[data-fallback-key-index="1"]').locator('..').getByRole("button", { name: "Сделать основным" }).click();
    await page.waitForFunction(() => document.querySelector('[data-fallback-key-index="1"]').parentElement.firstChild.textContent === "Основной API-ключ PartsAPI");
    assert.deepEqual(activations, [2]);
    assert.match(await page.locator('[data-fallback-key-index="1"]').locator('..').textContent(), /Запросов за 24 часа: 0/);
    await page.locator("#applicability-settings-close").click();
    mode = "successful";
    await page.locator("#applicability-sku").fill("MANUAL1");
    await submit.click();
    await page.waitForFunction(() => !document.querySelector("#applicability-submit").disabled);
    await page.locator("#applicability-settings-toggle").click();
    await page.waitForLoadState("networkidle");
    assert.match(await page.locator('[data-fallback-key-index="1"]').locator('..').textContent(), /Запросов за 24 часа: 1/);
    assert.match(await page.locator('[data-fallback-key-index="0"]').locator('..').textContent(), /Запросов за 24 часа: 2/);

    // An open drawer refreshes its counters when the next reset boundary passes.
    await page.clock.install();
    const now = Date.now();
    await page.clock.pauseAt(new Date(now));
    [keyState.primaryKey, ...keyState.fallbackKeys].forEach((key) => { key.resetAt = now + 2_000; });
    await page.locator("#applicability-settings-close").click();
    await page.locator("#applicability-settings-toggle").click();
    await page.waitForLoadState("networkidle");
    resetOnNextRead = true;
    await page.clock.fastForward(3_000);
    await page.waitForFunction(() => document.querySelector("#applicability-primary-key-controls").textContent.includes("Запросов за 24 часа: 0"));
    assert.match(await page.locator('[data-fallback-key-index="1"]').locator('..').textContent(), /Запросов за 24 часа: 0/);
    assert.equal(await page.locator('#applicability-api-key').locator('..').getAttribute("data-limited"), "false");
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
