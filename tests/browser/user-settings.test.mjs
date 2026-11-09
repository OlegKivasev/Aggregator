import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";
import { UserAuthService } from "../../src/backend/auth/user-auth-service.ts";
import { createAggregatorServer } from "../../src/backend/http/create-server.ts";

// These accounts and their passwords exist only in the temporary test database.
test("user settings edit accounts, preserve passwords, and hide navigation for a single assigned form", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aggregator-user-settings-"));
  const previousPath = process.env.GARAGE_DB_PATH;
  process.env.GARAGE_DB_PATH = join(directory, "garage.sqlite");
  const auth = new UserAuthService(process.env.GARAGE_DB_PATH, "Администратор", "test-admin-password");
  const server = createAggregatorServer({
    application: { streamSearch: async () => {}, listSupplierSessions: () => [] },
    publicDir: resolve("src/frontend"), auth,
  });
  let browser;
  try {
    await new Promise((resolvePromise, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolvePromise); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.TEST_BROWSER_EXECUTABLE_PATH });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.href === "https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" && process.env.REPAIRS_BOOTSTRAP_CSS_PATH) {
        return route.fulfill({ contentType: "text/css", body: await readFile(process.env.REPAIRS_BOOTSTRAP_CSS_PATH) });
      }
      if (url.origin !== origin) return route.abort();
      if (!url.pathname.startsWith("/api/") || /^\/api\/(?:auth\/|users$|repairs)/.test(url.pathname)) return route.continue();
      const responses = {
        "/api/suppliers/sessions": { sessions: [] },
        "/api/applicability/api-key": { configured: false, persistent: false, maskedKey: null },
        "/api/applicability/proxies": { persistent: false, activeRouteId: null, proxies: [], directLimited: false, usage: { requestCount: 0 }, directUsage: { requestCount: 0, secondsUntilReset: null } },
        "/api/garage/vehicles": { vehicles: [] },
      };
      return route.fulfill({ json: responses[url.pathname] ?? { articles: [], brandCounts: [], hasMore: false } });
    });
    const login = async (fio, password) => {
      const response = await context.request.post(`${origin}/api/auth/login`, { data: { fio, password } });
      assert.equal(response.status(), 200);
    };
    const ready = async () => {
      await page.waitForFunction(() => window.aggregatorAuthState?.ready);
      await page.waitForLoadState("networkidle");
    };
    const openSettings = async () => {
      await page.locator("#settings-toggle").click();
      await page.locator("#users-settings > summary").click();
    };
    const userRow = (fio) => page.locator(".users-list__row").filter({ has: page.locator("summary strong", { hasText: fio }) });
    await login("Администратор", "test-admin-password");
    await page.goto(origin);
    await ready();
    await openSettings();
    const create = page.locator("#user-create-form");
    await create.locator("#user-fio").fill("Иванов Иван Иванович");
    await create.locator("#user-password").fill("original-test-password");
    await create.locator(".password-toggle").click();
    assert.equal(await create.locator("#user-password").getAttribute("type"), "text");
    await create.locator(".password-toggle").click();
    assert.equal(await create.locator("#user-password").getAttribute("type"), "password");
    await create.locator('input[value="repairs"]').check();
    await create.locator('[type="submit"]').click();
    await userRow("Иванов").waitFor();
    const employee = userRow("Иванов");
    assert.equal(await employee.getAttribute("open"), null);
    assert.equal(await employee.locator("form").isVisible(), false);
    await employee.locator("summary").click();
    const fioField = employee.locator('[name="fio"]');
    const passwordField = employee.locator('[name="password"]');
    const eye = employee.locator(".password-toggle");
    assert.equal(await passwordField.inputValue(), "");
    await passwordField.fill("replacement-test-password");
    await eye.click();
    assert.equal(await passwordField.getAttribute("type"), "text");
    assert.equal(await eye.getAttribute("aria-pressed"), "true");
    await eye.click();
    assert.equal(await passwordField.getAttribute("type"), "password");
    await eye.click();
    await fioField.focus();
    assert.equal(await passwordField.getAttribute("type"), "password");
    await fioField.fill("Петров Пётр Петрович");
    await employee.locator('input[value="applicability"]').check();
    await employee.locator('input[value="repairs"]').uncheck();
    const savedEmployee = userRow("Петров");
    await employee.locator('[type="submit"]').click();
    await savedEmployee.getByText("Изменения сохранены.", { exact: true }).waitFor();
    assert.equal(await savedEmployee.locator('[name="password"]').inputValue(), "");
    assert.equal(await savedEmployee.locator(".users-list__delete img").getAttribute("src"), "/recycle-bin.png");
    assert.equal(await savedEmployee.locator(".users-list__delete").evaluate((element) => element.getBoundingClientRect().width), 40);
    assert.equal(await userRow("Администратор").locator(".users-list__delete").count(), 0);
    const oldLogin = await context.request.post(`${origin}/api/auth/login`, {
      data: { fio: "Петров Пётр Петрович", password: "original-test-password" },
    });
    assert.equal(oldLogin.status(), 401);

    // A server rejection keeps entered edits available for correction.
    await savedEmployee.locator('[name="fio"]').fill("Администратор");
    await savedEmployee.locator('[type="submit"]').click();
    await savedEmployee.getByText("User with this FIO already exists", { exact: true }).waitFor();
    assert.equal(await savedEmployee.locator('[name="fio"]').inputValue(), "Администратор");
    await savedEmployee.locator('[name="fio"]').fill("Петров Пётр Петрович");
    await savedEmployee.locator('input[value="markup"]').check();
    await savedEmployee.locator('[type="submit"]').click();
    await savedEmployee.getByText("Изменения сохранены.", { exact: true }).waitFor();
    if (process.env.USER_SETTINGS_SCREENSHOT_DIR) {
      await page.screenshot({ path: join(process.env.USER_SETTINGS_SCREENSHOT_DIR, "user-settings-desktop.png"), fullPage: true });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await savedEmployee.locator("form").evaluate((form) => form.scrollWidth <= form.clientWidth), true);
    if (process.env.USER_SETTINGS_SCREENSHOT_DIR) {
      await page.screenshot({ path: join(process.env.USER_SETTINGS_SCREENSHOT_DIR, "user-settings-mobile.png"), fullPage: true });
    }

    await login("Петров Пётр Петрович", "replacement-test-password");
    await page.goto(origin);
    await ready();
    assert.equal(await page.locator(".function-tabs").isVisible(), true);
    assert.equal(await page.locator("#applicability-function-tab").isVisible(), true);

    // Each sole permission must win over an inaccessible saved section, including empty repairs.
    for (const [permission, section] of [["markup", "markup"], ["applicability", "applicability"], ["repairs", "repairs"], ["testRepairs", "test-repairs"]]) {
      await login("Администратор", "test-admin-password");
      const users = await (await context.request.get(`${origin}/api/users`)).json();
      const user = users.users.find((user) => user.fio === "Петров Пётр Петрович");
      const update = await context.request.patch(`${origin}/api/users`, { data: { id: user.id, fio: user.fio, permissions: [permission] } });
      assert.equal(update.status(), 200);
      await login(user.fio, "replacement-test-password");
      await page.evaluate((value) => localStorage.setItem("autoservice.activeFunction", value), section === "markup" ? "applicability" : "markup");
      await page.reload();
      await ready();
      assert.equal(await page.locator(".function-tabs").isVisible(), false);
      assert.equal(await page.locator(`#${section}-function`).isVisible(), true);
      assert.equal(await page.locator(".function-tab.active").getAttribute("id"), `${section}-function-tab`);
      assert.equal(await page.locator(".function-content").evaluate((element) => getComputedStyle(element).gridColumnStart), "1");
      await page.setViewportSize({ width: 1440, height: 1000 });
      assert.equal(await page.locator(".function-layout").evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length), 1);
      if (section.includes("repairs")) {
        await page.locator(`#${section}-rows`).getByText(section === "repairs" ? "Заказ-нарядов в работе нет." : "Тестовых заказ-нарядов в работе нет.", { exact: true }).waitFor();
        assert.equal(await page.locator(`#${section}-function`).isVisible(), true);
      }
      await page.reload();
      await ready();
      assert.equal(await page.locator(`#${section}-function`).isVisible(), true);
    }

    await login("Администратор", "test-admin-password");
    await page.goto(origin);
    await ready();
    assert.equal(await page.locator(".function-tabs").isVisible(), true);
    await page.locator("#markup-function-tab").click();
    await openSettings();
    await savedEmployee.locator("summary").click();
    page.once("dialog", (dialog) => dialog.dismiss());
    await savedEmployee.locator(".users-list__delete").click();
    assert.equal(await savedEmployee.count(), 1);
    page.once("dialog", (dialog) => dialog.accept());
    await savedEmployee.locator(".users-list__delete").click();
    await page.waitForFunction(() => document.querySelectorAll(".users-list__row").length === 1);
    const deletedLogin = await context.request.post(`${origin}/api/auth/login`, { data: { fio: "Петров Пётр Петрович", password: "replacement-test-password" } });
    assert.equal(deletedLogin.status(), 401);
    const admin = userRow("Администратор");
    await admin.locator("summary").click();
    await admin.locator('[name="fio"]').fill("Главный администратор");
    await admin.locator('[type="submit"]').click();
    await userRow("Главный администратор").getByText("Изменения сохранены.", { exact: true }).waitFor();
    assert.equal(await page.locator("#auth-user-badge").textContent(), "Главный администратор");
    await login("Главный администратор", "test-admin-password");
    await page.reload();
    await ready();
    assert.equal(await page.locator("#auth-user-badge").textContent(), "Главный администратор");
    assert.equal(await page.locator(".function-tabs").isVisible(), true);
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
