import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve, sep } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";

// All stored results and API responses below are fictional browser test fixtures.
const vehicle = { carId: 1, makeName: "FORD", modelName: "TEST", carName: "2.0", carType: "PC", yearStart: null, yearEnd: null };
const tab = (id, name, results = [vehicle]) => ({ id, name, searches: [{ id: `entry-${id}`, sku: `OEM-${id}`, makeName: "FORD", results, hasSearched: true }] });

async function withGroupsPage(state, check) {
  const frontendDir = resolve("src/frontend");
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, "http://127.0.0.1").pathname;
    const file = resolve(frontendDir, `.${path === "/" ? "/index.html" : path}`);
    if (!file.startsWith(`${frontendDir}${sep}`)) return response.writeHead(404).end();
    try {
      const content = await readFile(file);
      const type = file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : file.endsWith(".json") ? "application/json" : file.endsWith(".png") ? "image/png" : "text/html";
      response.writeHead(200, { "Content-Type": type }).end(content);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.TEST_BROWSER_EXECUTABLE_PATH });
    const page = await browser.newPage({ viewport: { width: 1800, height: 900 } });
    const errors = [];
    const searches = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript((storedState) => {
      if (!localStorage.getItem("autoservice.applicabilityState")) localStorage.setItem("autoservice.applicabilityState", JSON.stringify(storedState));
      localStorage.setItem("autoservice.activeFunction", "applicability");
    }, state);
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (!url.pathname.startsWith("/api/")) return route.continue();
      if (url.pathname === "/api/applicability/search") {
        searches.push(route.request().postDataJSON());
        return route.fulfill({ json: { results: [vehicle], cacheHit: true } });
      }
      if (url.pathname === "/api/applicability/api-key") return route.fulfill({ json: { configured: true, persistent: false, maskedKey: "…TEST1" } });
      if (url.pathname === "/api/applicability/cached-brands") return route.fulfill({ json: { brands: [] } });
      if (url.pathname === "/api/suppliers/sessions") return route.fulfill({ json: { sessions: [] } });
      if (url.pathname === "/api/garage/vehicles") return route.fulfill({ json: { vehicles: [] } });
      return route.fulfill({ json: { articles: [], brandCounts: [], hasMore: false } });
    });
    await page.goto(origin);
    await page.waitForLoadState("networkidle");
    await check(page);
    assert.deepEqual(errors, []);
    assert.deepEqual(searches, [], "Grouping and generating documents must not repeat supplier searches");
  } finally {
    await browser?.close();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

const storedState = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("autoservice.applicabilityState")));
const tabButton = (page, id) => page.locator(`#applicability-tabs-list [data-tab-id="${id}"]`);
const groupHeader = (page, name) => page.locator(".applicability-tab-group__header").filter({ hasText: name });

async function dragWithPreview(page, source, target, message) {
  const from = await source.boundingBox();
  const to = await target.boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2, { steps: 4 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 16 });
  await page.mouse.move(to.x + to.width / 2 + 1, to.y + to.height / 2);
  await page.waitForFunction(() => !document.querySelector("#applicability-tab-drop-feedback").hidden);
  assert.match(await page.locator("#applicability-tab-drop-feedback").textContent(), message);
  assert.ok(await target.evaluate((element) => element.classList.contains("is-group-drop-target") || element.classList.contains("is-reorder-target")));
  if (process.env.TEST_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.TEST_SCREENSHOT_DIR, "applicability-group-drop-preview.png") });
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector("#applicability-tab-drop-feedback").hidden);
}

async function dragToPart(page, source, target, fraction = 0.2) {
  const from = await source.boundingBox();
  const to = await target.boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2, { steps: 4 });
  await page.mouse.move(to.x + to.width * fraction, to.y + to.height / 2, { steps: 16 });
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector("#applicability-tab-drop-feedback").hidden);
}

test("dragging tabs creates and moves groups, renames folders and forms only the active group's list", async () => {
  await withGroupsPage({ activeTabId: "a", tabs: [tab("a", "Деталь A"), tab("b", "Деталь B", []), tab("c", "Деталь C"), tab("d", "Деталь D"), tab("e", "Деталь E")] }, async (page) => {
    const multiList = page.locator("#applicability-multi-list-button");
    assert.equal(await multiList.isVisible(), false);
    await dragWithPreview(page, tabButton(page, "a"), tabButton(page, "b"), /создать группу/);
    assert.equal(await groupHeader(page, "Группа 1").count(), 1);
    const firstGroup = page.locator(".applicability-tab-group");
    assert.deepEqual(await firstGroup.locator("[data-tab-id]").evaluateAll((buttons) => buttons.map((button) => button.dataset.tabId)), ["b", "a"]);
    assert.ok(await firstGroup.locator("img").evaluate((image) => image.complete && image.naturalWidth > 0));
    assert.equal(await multiList.isVisible(), true);
    assert.equal(await multiList.isEnabled(), true);

    await groupHeader(page, "Группа 1").click({ button: "right" });
    await page.locator("#applicability-rename-tab-button").click();
    assert.equal(await page.locator("#applicability-article-name-title").textContent(), "Название группы");
    await page.locator("#applicability-article-name-input").fill("  Детали   двигателя  ");
    await page.locator('#applicability-article-name-form button[type="submit"]').click();
    assert.equal(await groupHeader(page, "Детали двигателя").count(), 1);
    assert.match(await multiList.getAttribute("title"), /Детали двигателя/);
    await multiList.click();
    const documentText = page.locator("#applicability-document-text");
    assert.match(await documentText.inputValue(), /Артикул: Деталь B\n\nOEM-артикул: OEM-b \| FORD/);
    assert.match(await documentText.inputValue(), /Артикул: Деталь A/);
    assert.doesNotMatch(await documentText.inputValue(), /Деталь C|OEM-c/);
    assert.equal(await page.locator("#applicability-multi-list-modal").count(), 0);
    await page.locator("#applicability-document-modal button[data-close-applicability-document]").click();
    await tabButton(page, "c").click();
    assert.equal(await multiList.isVisible(), false);
    await dragWithPreview(page, tabButton(page, "c"), groupHeader(page, "Детали двигателя"), /Добавить вкладку в группу/);
    assert.equal(await multiList.isVisible(), true);
    if (process.env.TEST_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.TEST_SCREENSHOT_DIR, "applicability-tab-groups.png") });
    await tabButton(page, "d").dragTo(tabButton(page, "e"));
    assert.equal(await groupHeader(page, "Группа 2").count(), 1);
    await dragToPart(page, groupHeader(page, "Группа 2"), groupHeader(page, "Детали двигателя"), 0.15);
    assert.deepEqual((await storedState(page)).groups.map((group) => group.name), ["Группа 2", "Детали двигателя"]);
    await tabButton(page, "c").dragTo(tabButton(page, "e"));
    const state = await storedState(page);
    const group2Id = state.groups.find((group) => group.name === "Группа 2").id;
    assert.deepEqual(state.tabs.filter((item) => item.groupId === group2Id).map((item) => item.id), ["e", "d", "c"]);
    assert.equal(state.tabs.find((item) => item.id === "a").searches.length, 1);
    await tabButton(page, "c").dragTo(tabButton(page, "e"));
    assert.equal((await storedState(page)).groups.length, 2);
    assert.deepEqual((await storedState(page)).tabs.filter((item) => item.groupId === group2Id).map((item) => item.id), ["c", "e", "d"]);
    await page.reload();
    await page.waitForLoadState("networkidle");
    assert.equal(await groupHeader(page, "Детали двигателя").count(), 1);
    assert.equal(await groupHeader(page, "Группа 2").count(), 1);
    await multiList.click();
    assert.deepEqual([...(await documentText.inputValue()).matchAll(/^Артикул: (.+)$/gm)].map((match) => match[1]), ["Деталь C", "Деталь E", "Деталь D"]);
    await page.keyboard.press("Escape");

    await tabButton(page, "b").click({ button: "right" });
    await page.locator("#applicability-remove-from-group").click();
    await tabButton(page, "b").click();
    assert.equal(await multiList.isVisible(), false);
    assert.equal(await page.locator("#applicability-results-body tr").count(), 1);
    await groupHeader(page, "Детали двигателя").click({ button: "right" });
    await page.locator("#applicability-dissolve-group").click();
    assert.equal(await groupHeader(page, "Детали двигателя").count(), 0);
    assert.equal(await tabButton(page, "a").count(), 1);
    for (const id of ["e", "d", "c"]) await page.locator(`[data-close-tab-id="${id}"]`).click();
    assert.equal(await page.locator(".applicability-tab-group").count(), 0);
    await page.locator("#applicability-new-tab").click();
    const unnamed = page.locator("#applicability-tabs-list [data-tab-id]").last();
    await unnamed.dragTo(tabButton(page, "a"));
    assert.equal(await groupHeader(page, "Группа 1").count(), 1);
  });
});

test("dragging tab edges reorders tabs without grouping them", async () => {
  await withGroupsPage({ activeTabId: "a", tabs: [tab("a", "Деталь A"), tab("b", "Деталь B"), tab("c", "Деталь C")] }, async (page) => {
    await dragToPart(page, tabButton(page, "c"), tabButton(page, "a"), 0.15);
    assert.deepEqual((await storedState(page)).tabs.map((item) => item.id), ["c", "a", "b"]);
    assert.deepEqual((await storedState(page)).tabs.map((item) => item.groupId), [null, null, null]);
    assert.equal(await page.locator(".applicability-tab-group").count(), 0);
    assert.match(await page.locator("#applicability-tab-drop-feedback").textContent(), /^$/);

    await dragToPart(page, tabButton(page, "a"), tabButton(page, "b"), 0.85);
    assert.deepEqual((await storedState(page)).tabs.map((item) => item.id), ["c", "b", "a"]);
    await tabButton(page, "a").click();
    assert.match(await page.locator("#applicability-results-body").textContent(), /OEM-a/);
  });
});

test("group lists handle unnamed and empty tabs immediately and render untrusted folder names as text", async () => {
  const groupName = '<img src=x onerror="window.groupXss=1">';
  await withGroupsPage({ activeTabId: "a", groups: [{ id: "g", name: groupName }, { id: "empty", name: "Без результатов" }], tabs: [
    { ...tab("a", ""), groupId: "g" }, { ...tab("b", "", []), groupId: "g", sku: "Исходный B" },
    { id: "c", groupId: "g", searches: [] }, { id: "d", groupId: "empty", searches: [] }, tab("e", "Отдельно"),
  ] }, async (page) => {
    const multiList = page.locator("#applicability-multi-list-button");
    const header = groupHeader(page, "onerror");
    assert.equal(await header.textContent(), groupName);
    assert.equal(await header.locator("img").count(), 1);
    assert.equal(await page.evaluate(() => window.groupXss), undefined);
    await page.locator("#applicability-list-button").click();
    assert.equal(await page.locator("#applicability-article-name-input").inputValue(), "Новая применимость 1");
    await page.keyboard.press("Escape");
    await multiList.click();
    assert.equal(await page.locator("#applicability-article-name-modal").isVisible(), false);
    const text = await page.locator("#applicability-document-text").inputValue();
    assert.match(text, /Артикул: Новая применимость 1/);
    assert.match(text, /Артикул: Исходный B/);
    assert.doesNotMatch(text, /Новая применимость 3|Отдельно/);
    await page.keyboard.press("Escape");
    await tabButton(page, "c").click();
    assert.equal(await multiList.isEnabled(), true);
    await tabButton(page, "d").click();
    assert.equal(await multiList.isVisible(), true);
    assert.equal(await multiList.isDisabled(), true);
    await tabButton(page, "e").click();
    assert.equal(await multiList.isVisible(), false);
    await header.dblclick();
    assert.equal(await page.locator("#applicability-article-name-modal").isVisible(), true);
    await page.locator("#applicability-article-name-input").fill("Двойной щелчок");
    await page.locator('#applicability-article-name-form button[type="submit"]').click();
    const renamedHeader = groupHeader(page, "Двойной щелчок");
    assert.equal(await renamedHeader.count(), 1);
    await renamedHeader.focus();
    await page.keyboard.press("Shift+F10");
    await page.locator("#applicability-rename-tab-button").click();
    await page.locator("#applicability-article-name-input").fill("Новое имя");
    await page.locator('#applicability-article-name-form button[type="submit"]').click();
    assert.equal(await groupHeader(page, "Новое имя").count(), 1);
    for (const width of [320, 640]) {
      await page.setViewportSize({ width, height: 760 });
      for (const id of ["applicability-file-toggle", "applicability-settings-toggle", "applicability-submit"]) {
        const button = page.locator(`#${id}`);
        assert.ok(await button.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
          return bounds.x >= 0 && bounds.right <= window.innerWidth && element.contains(hit);
        }), `${id} is obscured at ${width}px`);
      }
    }
  });
});

test("dragging tabs out of a group preserves searches, removes empty folders and persists membership", async () => {
  await withGroupsPage({ activeTabId: "a", groups: [{ id: "g", name: "Детали" }], tabs: [
    { ...tab("a", "Деталь A"), groupId: "g" }, { ...tab("b", "Деталь B", []), groupId: "g" }, tab("c", "Деталь C"),
  ] }, async (page) => {
    const dropZone = page.locator("#applicability-tab-ungroup-drop");
    const multiList = page.locator("#applicability-multi-list-button");
    const feedback = page.locator("#applicability-tab-drop-feedback");
    const beginDragOut = async (id) => {
      const source = tabButton(page, id);
      await source.evaluate((element) => element.scrollIntoView({ block: "nearest", inline: "center" }));
      const from = await source.boundingBox();
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2, { steps: 4 });
      await dropZone.waitFor({ state: "visible" });
      const to = await dropZone.boundingBox();
      await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 16 });
      await page.mouse.move(to.x + to.width / 2 + 1, to.y + to.height / 2);
      await feedback.waitFor({ state: "visible" });
      assert.match(await feedback.textContent(), /вынести вкладку из группы/i);
      assert.equal(await dropZone.evaluate((element) => element.classList.contains("is-group-drop-target")), true);
      assert.equal((await storedState(page)).tabs.find((item) => item.id === id).groupId, "g", "Preview does not change membership");
    };
    assert.equal(await dropZone.isVisible(), false);
    await tabButton(page, "c").click();
    await tabButton(page, "a").click();
    const originalSearches = (await storedState(page)).tabs.map((item) => [item.id, item.searches]);
    await beginDragOut("a");
    await page.mouse.move(30, 650, { steps: 12 });
    await page.mouse.up();
    assert.equal(await feedback.isVisible(), false);
    assert.equal(await dropZone.isVisible(), false);
    assert.equal((await storedState(page)).tabs.find((item) => item.id === "a").groupId, "g", "Dropping outside the tab strip cancels the operation");

    await beginDragOut("a");
    await page.mouse.up();
    assert.equal(await feedback.isVisible(), false);
    assert.equal(await dropZone.isVisible(), false);
    let state = await storedState(page);
    assert.deepEqual(state.tabs.map((item) => item.id), ["b", "c", "a"]);
    assert.equal(state.tabs.find((item) => item.id === "a").groupId, null);
    assert.equal(state.activeTabId, "a");
    assert.equal(state.groups.length, 1, "The remaining one-tab group stays intact");
    assert.equal(await multiList.isVisible(), false);
    assert.deepEqual(await page.locator("#applicability-results-summary dd").allTextContents(), ["1", "1", "0"]);
    await page.locator("#applicability-list-button").click();
    assert.match(await page.locator("#applicability-document-text").inputValue(), /OEM-артикул: OEM-a/);
    await page.keyboard.press("Escape");
    await page.reload();
    await page.waitForLoadState("networkidle");
    assert.equal(await multiList.isVisible(), false);
    assert.equal(await groupHeader(page, "Детали").count(), 1);

    await tabButton(page, "b").click();
    assert.equal(await multiList.isVisible(), true);
    await page.setViewportSize({ width: 320, height: 760 });
    await beginDragOut("b");
    assert.ok(await dropZone.evaluate((element) => element.getBoundingClientRect().right <= window.innerWidth));
    await page.mouse.up();
    state = await storedState(page);
    assert.deepEqual(state.groups, []);
    assert.equal(await page.locator(".applicability-tab-group").count(), 0);
    assert.equal(await multiList.isVisible(), false);
    assert.match(await page.locator("#applicability-results-body").textContent(), /OEM-bFORDНе найдено/);
    for (const [id, searches] of originalSearches) assert.deepEqual(state.tabs.find((item) => item.id === id).searches, searches);
    await page.reload();
    await page.waitForLoadState("networkidle");
    assert.deepEqual((await storedState(page)).groups, []);
    assert.equal(await dropZone.isVisible(), false);
    await page.setViewportSize({ width: 1800, height: 900 });
    await tabButton(page, "a").dragTo(tabButton(page, "c"));
    assert.equal(await groupHeader(page, "Группа 1").count(), 1, "Ungrouped tabs can be grouped again");
    const snapshot = await storedState(page);
    await dropZone.dispatchEvent("drop", { dataTransfer: await page.evaluateHandle(() => new DataTransfer()) });
    assert.deepEqual(await storedState(page), snapshot, "External drops cannot remove tabs from groups");
  });
});
