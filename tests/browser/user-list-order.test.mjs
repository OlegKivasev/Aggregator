import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";
import { UserAuthService } from "../../src/backend/auth/user-auth-service.ts";
import { createAggregatorServer } from "../../src/backend/http/create-server.ts";

test("user cards reorder only by their handles, preserve text selection and edits, persist and roll back failed saves", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aggregator-user-order-browser-"));
  const previousPath = process.env.GARAGE_DB_PATH;
  process.env.GARAGE_DB_PATH = join(directory, "garage.sqlite");
  const auth = new UserAuthService(process.env.GARAGE_DB_PATH, "Администратор", "test-admin-password");
  const server = createAggregatorServer({ application: { streamSearch: async () => {}, listSupplierSessions: () => [] },
    publicDir: resolve("src/frontend"), auth });
  let browser;
  try {
    await new Promise((resolvePromise, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolvePromise); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.TEST_BROWSER_EXECUTABLE_PATH });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, hasTouch: true });
    assert.equal((await context.request.post(`${origin}/api/auth/login`, { data: { fio: "Администратор", password: "test-admin-password" } })).status(), 200);
    for (const fio of ["Альфа Сотрудник", "Бета Сотрудник"]) {
      assert.equal((await context.request.post(`${origin}/api/users`, { data: { fio, password: "test-employee-password", permissions: ["repairs"] } })).status(), 201);
    }
    const page = await context.newPage();
    const errors = [];
    let rejectOrder = false;
    let orderRequests = 0;
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.href === "https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" && process.env.REPAIRS_BOOTSTRAP_CSS_PATH) {
        return route.fulfill({ contentType: "text/css", body: await readFile(process.env.REPAIRS_BOOTSTRAP_CSS_PATH) });
      }
      if (url.origin !== origin) return route.abort();
      if (url.pathname === "/api/users/order") {
        orderRequests++;
        if (rejectOrder) return route.fulfill({ status: 500, json: { message: "Тестовая ошибка сохранения" } });
      }
      if (!url.pathname.startsWith("/api/") || /^\/api\/(?:auth\/|users|repairs)/.test(url.pathname)) return route.continue();
      const responses = {
        "/api/suppliers/sessions": { sessions: [] },
        "/api/applicability/api-key": { configured: false, persistent: false, maskedKey: null },
        "/api/applicability/proxies": { persistent: false, activeRouteId: null, proxies: [], directLimited: false, usage: { requestCount: 0 }, directUsage: { requestCount: 0, secondsUntilReset: null } },
        "/api/garage/vehicles": { vehicles: [] },
      };
      return route.fulfill({ json: responses[url.pathname] ?? { articles: [], brandCounts: [], hasMore: false } });
    });
    const showSettings = async () => {
      await page.waitForFunction(() => window.aggregatorAuthState?.ready);
      await page.waitForLoadState("networkidle");
      await page.locator("#settings-toggle").click();
      await page.locator("#users-settings > summary").click();
    };
    const names = () => page.locator(".users-list__summary strong").allTextContents();
    const row = (name) => page.locator(".users-list__row").filter({ has: page.locator("summary strong", { hasText: name }) });
    const saved = () => page.waitForResponse((response) => new URL(response.url()).pathname === "/api/users/order");
    const dragBefore = async (name, target) => {
      const start = await row(name).locator(".users-list__handle").boundingBox();
      const end = await row(target).boundingBox();
      await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
      await page.mouse.down();
      await page.mouse.move(start.x + start.width / 2, end.y + 2, { steps: 12 });
      await page.mouse.up();
    };
    await page.goto(origin);
    await showSettings();
    assert.deepEqual(await names(), ["Администратор", "Альфа Сотрудник", "Бета Сотрудник"]);
    await row("Альфа").locator("summary").click();
    await row("Альфа").locator('[name="fio"]').fill("Несохранённая правка");
    const nameBounds = await row("Альфа").locator("strong").evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const bounds = range.getBoundingClientRect();
      return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
    });
    await page.mouse.move(nameBounds.x + 1, nameBounds.y + nameBounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(nameBounds.x + nameBounds.width + 1, nameBounds.y + nameBounds.height / 2, { steps: 10 });
    await page.mouse.up();
    assert.equal(await page.evaluate(() => getSelection().toString()), "Альфа Сотрудник");
    assert.equal(await row("Альфа").evaluate((element) => element.open), true);
    // Observe the copy event without replacing the user's system clipboard.
    await page.evaluate(() => document.addEventListener("copy", (event) => {
      window.copiedUserText = getSelection().toString();
      event.preventDefault();
    }, { once: true }));
    await page.keyboard.press("Control+c");
    assert.equal(await page.evaluate(() => window.copiedUserText), "Альфа Сотрудник");
    assert.equal(orderRequests, 0);

    let response = saved();
    await dragBefore("Бета", "Администратор");
    assert.equal((await response).status(), 200);
    await page.waitForFunction(() => !document.querySelector("#users-list").hasAttribute("aria-busy"));
    assert.deepEqual(await names(), ["Бета Сотрудник", "Администратор", "Альфа Сотрудник"]);
    assert.equal(await row("Альфа").locator('[name="fio"]').inputValue(), "Несохранённая правка");
    assert.equal(await row("Альфа").evaluate((element) => element.open), true);
    response = saved();
    await row("Администратор").locator(".users-list__handle").focus();
    await page.keyboard.press("ArrowDown");
    assert.equal((await response).status(), 200);
    await page.waitForFunction(() => !document.querySelector("#users-list").hasAttribute("aria-busy"));
    assert.deepEqual(await names(), ["Бета Сотрудник", "Альфа Сотрудник", "Администратор"]);

    rejectOrder = true;
    response = saved();
    await dragBefore("Администратор", "Бета");
    assert.equal((await response).status(), 500);
    await page.locator("#users-feedback").getByText("Тестовая ошибка сохранения", { exact: true }).waitFor();
    assert.deepEqual(await names(), ["Бета Сотрудник", "Альфа Сотрудник", "Администратор"]);
    assert.equal(await row("Альфа").locator('[name="fio"]').inputValue(), "Несохранённая правка");
    rejectOrder = false;
    const beforeCancel = orderRequests;
    const handle = await row("Бета").locator(".users-list__handle").boundingBox();
    await page.mouse.move(handle.x + 10, handle.y + 10);
    await page.mouse.down();
    await page.mouse.move(handle.x + 10, handle.y + 35, { steps: 5 });
    await page.keyboard.press("Escape");
    await page.mouse.up();
    assert.equal(orderRequests, beforeCancel);
    assert.equal(await page.locator(".is-user-dragging, .is-user-drop-before, .is-user-drop-after").count(), 0);

    await page.reload();
    await showSettings();
    assert.deepEqual(await names(), ["Бета Сотрудник", "Альфа Сотрудник", "Администратор"]);
    if (process.env.USER_SETTINGS_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.USER_SETTINGS_SCREENSHOT_DIR, "user-order-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.locator("#users-list").evaluate((element) => element.scrollWidth <= element.clientWidth), true);
    assert.equal(await row("Бета").locator(".users-list__handle").isVisible(), true);
    const touch = await context.newCDPSession(page);
    const touchStart = await row("Администратор").locator(".users-list__handle").boundingBox();
    const touchEnd = await row("Бета").boundingBox();
    response = saved();
    await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: touchStart.x + 14, y: touchStart.y + 18 }] });
    await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: touchStart.x + 14, y: touchEnd.y + 2 }] });
    await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    assert.equal((await response).status(), 200);
    await page.waitForFunction(() => !document.querySelector("#users-list").hasAttribute("aria-busy"));
    assert.deepEqual(await names(), ["Администратор", "Бета Сотрудник", "Альфа Сотрудник"]);
    await touch.detach();
    if (process.env.USER_SETTINGS_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.USER_SETTINGS_SCREENSHOT_DIR, "user-order-mobile.png"), fullPage: true });

    await context.clearCookies();
    await page.goto(origin);
    await page.locator("#auth-screen").waitFor();
    await page.locator("#auth-fio").fill("Альфа");
    await page.locator("#auth-fio-options").waitFor();
    assert.equal(await page.locator('#auth-fio-options [role="option"]').textContent(), "Альфа Сотрудник");
    await page.locator("#auth-fio").fill("НетТакогоПользователя");
    assert.equal(await page.locator("#auth-fio-options").isVisible(), false);
    assert.equal(await page.locator("#auth-fio").getAttribute("aria-expanded"), "false");
    await page.locator("#auth-fio-toggle").click();
    assert.equal(await page.locator("#auth-fio-options").isVisible(), false);
    await page.locator("#auth-fio").press("ArrowDown");
    assert.equal(await page.locator("#auth-fio-options").isVisible(), false);
    assert.equal(await page.getByText("Совпадений нет", { exact: true }).count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise((resolvePromise) => server.close(resolvePromise));
    if (previousPath === undefined) delete process.env.GARAGE_DB_PATH;
    else process.env.GARAGE_DB_PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
});
