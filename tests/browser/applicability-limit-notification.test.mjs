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
    const notice = "Закончились лимиты у ключа PartsAPI …ABCDE. Ошибка PartsAPI (HTTP 401): Лимит исчерпан";
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/applicability/search") {
        const { sku } = route.request().postDataJSON();
        if (mode.startsWith("mixed") && sku === "CACHED1") {
          await route.fulfill({ json: { results: [{ carId: 1, makeName: "FORD", modelName: "TEST", carName: "2.0", carType: "PC", yearStart: null, yearEnd: null }], cacheHit: true } });
        } else if (mode === "mixed-normalized" && sku === "CACHED-1") {
          await route.fulfill({ json: { results: [], cacheHit: false } });
        } else {
          await route.fulfill({ status: mode === "integration" ? 502 : 401, json: { message: mode === "integration" ? "Applicability search failed" : notice } });
        }
      } else if (path === "/api/applicability/api-key") {
        await route.fulfill({ json: { configured: true, fallbackKeyCount: 0, persistent: true } });
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
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
