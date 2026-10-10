import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve, sep } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";

// Explicit browser regression test. Stored searches and API responses are fictional fixtures.
test("applicability lists retain empty OEM blocks at the end of each article section", async () => {
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
    const vehicle = { carId: 1, makeName: "FORD", modelName: "TEST седан (ABC)", carName: "2.0", carType: "PC", yearStart: "2001", yearEnd: "2003" };
    const entry = (sku, results = [], makeName = "FORD", hasSearched = true) => ({
      id: `${sku}-${makeName}`, sku, makeName, results, hasSearched,
    });
    const state = {
      activeTabId: "empty",
      tabs: [
        { id: "mixed", name: "Деталь A", searches: [
          entry("MISS-A1"),
          entry("FULL-A1", [vehicle, { ...vehicle, carId: 2 }]),
          entry("MISS-A2"),
          entry("FULL-A2", [{ ...vehicle, carId: 3, modelName: "OTHER седан (DEF)" }]),
          entry("FULL-A1", [], "VW"),
          entry("PENDING-A", [], "FORD", false),
        ] },
        { id: "empty", name: "Деталь B", searches: [entry("ONLY-A"), entry("ONLY-B")] },
        { id: "other", name: "Деталь C", searches: [
          entry("MISS-C"), entry("FULL-C", [vehicle]),
        ] },
        { id: "failed", name: "Ошибка", searches: [entry("FAILED", [], "FORD", false)] },
      ],
    };
    await page.addInitScript((storedState) => {
      localStorage.setItem("autoservice.applicabilityState", JSON.stringify(storedState));
      localStorage.setItem("autoservice.activeFunction", "applicability");
    }, state);
    const origin = `http://127.0.0.1:${server.address().port}`;
    const requests = [];
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (!url.pathname.startsWith("/api/")) return route.continue();
      requests.push(url.pathname);
      if (url.pathname === "/api/applicability/api-key") {
        return route.fulfill({ json: { configured: true, persistent: false, maskedKey: "…ABCDE" } });
      }
      if (url.pathname === "/api/applicability/search") {
        const { sku } = route.request().postDataJSON();
        return sku === "ERROR1"
          ? route.fulfill({ status: 502, json: { message: "Applicability search failed" } })
          : route.fulfill({ json: { results: [], cacheHit: false } });
      }
      if (url.pathname === "/api/applicability/cached-brands") return route.fulfill({ json: { brands: [] } });
      if (url.pathname === "/api/suppliers/sessions") return route.fulfill({ json: { sessions: [] } });
      if (url.pathname === "/api/garage/vehicles") return route.fulfill({ json: { vehicles: [] } });
      return route.fulfill({ json: { articles: [], brandCounts: [], hasMore: false } });
    });
    await page.goto(origin);
    await page.waitForLoadState("networkidle");
    const listButton = page.locator("#applicability-list-button");
    const documentText = page.locator("#applicability-document-text");
    const documentCount = page.locator("#applicability-document-count");
    const oemSkus = (text) => [...text.matchAll(/^OEM-артикул: ([^ |\n]+)/gm)].map((match) => match[1]);
    const closeDocument = () => page.locator("#applicability-document-modal button[data-close-applicability-document]").click();

    // A list containing only successful empty searches remains available.
    assert.equal(await listButton.isEnabled(), true);
    await listButton.click();
    const emptyText = await documentText.inputValue();
    assert.deepEqual(oemSkus(emptyText), ["ONLY-A", "ONLY-B"]);
    assert.deepEqual(emptyText.split("\n").filter((line) => line.trim()), [
      "Артикул: Деталь B", "OEM-артикул: ONLY-A | FORD", "OEM-артикул: ONLY-B | FORD",
    ]);
    assert.equal(await documentCount.textContent(), "Строк с автомобилями: 0");
    await closeDocument();

    // Deduplication, brand grouping and stable ordering of nonempty blocks are preserved.
    await page.locator('[data-tab-id="mixed"]').click();
    await listButton.click();
    const mixedText = await documentText.inputValue();
    assert.deepEqual(oemSkus(mixedText), ["FULL-A1", "FULL-A2", "MISS-A1", "MISS-A2"]);
    assert.match(mixedText, /OEM-артикул: FULL-A1 \| FORD, VW/);
    assert.doesNotMatch(mixedText, /PENDING-A/);
    assert.match(mixedText, /OEM-артикул: MISS-A1 \| FORD\n\s*OEM-артикул: MISS-A2 \| FORD\s*$/);
    assert.equal(await documentCount.textContent(), "Строк с автомобилями: 2");

    // Changing columns and switching back from raw data keep the same empty-block order.
    await page.locator("#applicability-document-columns > summary").click();
    await page.locator('[data-applicability-document-column="carName"]').uncheck();
    assert.deepEqual(oemSkus(await documentText.inputValue()), oemSkus(mixedText));
    await page.locator("#applicability-document-format > summary").click();
    await page.locator('[data-applicability-document-format="raw"]').click();
    const rawText = await documentText.inputValue();
    assert.deepEqual(oemSkus(rawText), ["MISS-A1", "FULL-A1", "MISS-A2", "FULL-A2", "FULL-A1"]);
    assert.match(rawText, /OEM-артикул: MISS-A1 \| FORD\n\[\]/);
    assert.equal(await documentCount.textContent(), "Строк с автомобилями: 3");
    await page.locator("#applicability-document-format > summary").click();
    await page.locator('[data-applicability-document-format="structured"]').click();
    assert.deepEqual(oemSkus(await documentText.inputValue()), oemSkus(mixedText));
    await closeDocument();

    // Empty-only tabs can be selected, with empty blocks at the end of their own section.
    await page.locator("#applicability-multi-list-button").click();
    const choices = page.locator('#applicability-multi-list-tabs input[type="checkbox"]');
    assert.deepEqual(await choices.evaluateAll((inputs) => inputs.map((input) => input.value)), ["mixed", "empty", "other"]);
    for (const id of ["mixed", "empty", "other"]) await page.locator(`#applicability-multi-list-tabs input[value="${id}"]`).check();
    await page.locator("#applicability-multi-list-submit").click();
    const multiText = await documentText.inputValue();
    assert.deepEqual(oemSkus(multiText), ["FULL-A1", "FULL-A2", "MISS-A1", "MISS-A2", "ONLY-A", "ONLY-B", "FULL-C", "MISS-C"]);
    assert.match(multiText, /OEM-артикул: MISS-A2 \| FORD\s*Артикул: Деталь B/);
    assert.match(multiText, /OEM-артикул: ONLY-B \| FORD\s*Артикул: Деталь C/);
    assert.equal(await documentCount.textContent(), "Строк с автомобилями: 3");
    assert.equal(requests.includes("/api/applicability/search"), false);
    await closeDocument();

    // Failed searches do not enable a list; a real successful empty response does.
    await page.locator('[data-tab-id="failed"]').click();
    assert.equal(await listButton.isDisabled(), true);
    await page.locator("#applicability-make").fill("FORD");
    await page.getByRole("option", { name: "FORD", exact: true }).click();
    await page.locator("#applicability-sku").fill("ERROR1");
    await page.locator("#applicability-submit").click();
    await page.waitForFunction(() => !document.querySelector("#applicability-submit").disabled);
    assert.equal(await listButton.isDisabled(), true);
    assert.equal(await page.locator("#applicability-feedback").textContent(), "Applicability search failed");
    await page.locator("#applicability-sku").fill("NOTFOUND1");
    await page.locator("#applicability-submit").click();
    await page.waitForFunction(() => !document.querySelector("#applicability-submit").disabled);
    assert.equal(await listButton.isEnabled(), true);
    await listButton.click();
    assert.deepEqual(oemSkus(await documentText.inputValue()), ["NOTFOUND1"]);
    assert.equal(await documentCount.textContent(), "Строк с автомобилями: 0");
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
