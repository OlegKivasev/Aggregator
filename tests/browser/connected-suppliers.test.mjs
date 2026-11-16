import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";
import { UserAuthService } from "../../src/backend/auth/user-auth-service.ts";
import { createAggregatorServer } from "../../src/backend/http/create-server.ts";
import { SearchApplicationService } from "../../src/backend/application/search-application-service.ts";
import { SupplierSessionManager } from "../../src/backend/session/session-manager.ts";

// Real HTTP, permissions and search orchestration; supplier responses are fictional.
test("employees search every shared connection despite old local settings and changes on an open page", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "aggregator-connected-suppliers-"));
  const previousPath = process.env.GARAGE_DB_PATH;
  process.env.GARAGE_DB_PATH = join(directory, "garage.sqlite");
  const auth = new UserAuthService(process.env.GARAGE_DB_PATH, "Администратор", "test-admin-password");
  const sessions = new SupplierSessionManager();
  sessions.markAuthorized("rossko");
  const calls = [];
  const adapters = ["rossko", "autopiter", "armtek"].map((supplier) => ({
    id: supplier, displayName: supplier, timeoutMs: 1000,
    async ensureSession() { return sessions.getSession(supplier); },
    async search(query, _context, onResult) {
      calls.push({ supplier, article: query.article });
      onResult({ supplier, article: query.article, brand: "TEST", title: `${supplier} товар`,
        price: 100, quantity: 2, warehouse: null, deliveryDate: null, deliveryDateApproximate: false,
        isReturnable: true, link: "https://example.com/offer" });
    },
  }));
  const search = new SearchApplicationService(adapters, sessions, (supplier) => sessions.markUnauthorized(supplier));
  const server = createAggregatorServer({ application: {
    listSupplierSessions: () => sessions.getAllSessions(), streamSearch: search.streamSearch.bind(search),
  }, publicDir: resolve("src/frontend"), auth });
  let browser;
  try {
    await new Promise((resolvePromise, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolvePromise); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.TEST_BROWSER_EXECUTABLE_PATH });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const login = async (fio, password) => assert.equal((await context.request.post(`${origin}/api/auth/login`, { data: { fio, password } })).status(), 200);
    await login("Администратор", "test-admin-password");
    assert.equal((await context.request.post(`${origin}/api/users`, {
      data: { fio: "Сотрудник", password: "test-employee-password", permissions: ["markup"] },
    })).status(), 201);
    await login("Сотрудник", "test-employee-password");
    const page = await context.newPage();
    const errors = [];
    const requests = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => { if (new URL(request.url()).pathname.startsWith("/api/")) requests.push(new URL(request.url())); });
    await page.addInitScript(() => {
      if (sessionStorage.getItem("seeded")) return;
      sessionStorage.setItem("seeded", "1");
      localStorage.setItem("autoservice.supplierVisibility", JSON.stringify(["rossko"]));
      localStorage.setItem("autoservice.searchState", JSON.stringify({ activeTabId: "old", tabs: [
        { id: "old", article: "ABC123", enabledSuppliers: ["rossko"], results: [] },
        { id: "other", article: "OLD", enabledSuppliers: [], results: [] },
      ] }));
    });
    await page.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (!url.pathname.startsWith("/api/") || /^\/api\/(?:auth\/|users$|suppliers\/|search$)/.test(url.pathname)) return route.continue();
      return route.fulfill({ json: { vehicles: [], articles: [], brandCounts: [], hasMore: false } });
    });
    await page.goto(origin);
    await page.waitForFunction(() => window.aggregatorAuthState?.ready);
    await page.locator('#rossko-auth-form[data-authorized="true"]').waitFor({ state: "attached" });
    assert.equal(await page.locator("#settings-toggle").isVisible(), false);
    assert.equal(await page.locator(".supplier-enabled-input, .supplier-visibility-input").count(), 0);
    const run = async () => {
      await page.locator("#article-input").fill("ABC123");
      await page.locator("#submit-button").click();
      await page.waitForFunction(() => !document.querySelector("#submit-button").disabled);
    };
    const participants = () => page.evaluate(() => {
      const saved = JSON.parse(localStorage.getItem("autoservice.searchState"));
      return saved.tabs.find((tab) => tab.id === saved.activeTabId).enabledSuppliers;
    });
    await run();
    assert.deepEqual(await participants(), ["rossko"]);
    await page.getByText("rossko товар", { exact: true }).waitFor();
    // The employee does not reload or re-read sessions after the admin connects Autopiter.
    sessions.markAuthorized("autopiter");
    await run();
    await page.getByText("autopiter товар", { exact: true }).waitFor();
    assert.deepEqual(await participants(), ["rossko", "autopiter"]);
    const searchCount = requests.filter((url) => url.pathname === "/api/search").length;
    await page.locator('[data-filter-values="supplier"] button').getByText("Rossko", { exact: true }).click();
    assert.equal(await page.locator("#results-body .main-result-row").count(), 1);
    assert.equal(requests.filter((url) => url.pathname === "/api/search").length, searchCount);
    await run(); // Table filters never narrow the following search.
    await page.getByText("autopiter товар", { exact: true }).waitFor();
    await page.locator('[data-tab-id="other"]').click();
    await run(); // A tab with an old empty supplier list works too.
    await page.getByText("autopiter товар", { exact: true }).waitFor();
    await page.reload();
    await page.getByText("autopiter товар", { exact: true }).waitFor();
    await run();
    assert.deepEqual(await participants(), ["rossko", "autopiter"]);
    sessions.markUnauthorized("rossko");
    sessions.markUnauthorized("autopiter");
    await run();
    await page.locator("#global-status").getByText("Нет подключённых поставщиков. Обратитесь к администратору.", { exact: true }).waitFor();
    assert.equal(await page.locator("#article-analogs-modal").isVisible(), false);
    assert.equal(calls.length, 9); // 1 + 2 + 2 + 2 + 2 + 0 supplier searches.
    assert.ok(calls.every(({ supplier }) => supplier !== "armtek"));
    const searches = requests.filter((url) => url.pathname === "/api/search");
    assert.equal(searches.length, 6);
    assert.ok(searches.every((url) => !url.searchParams.has("supplier")));
    assert.equal(requests.filter((url) => url.pathname === "/api/suppliers/sessions/validate").length, 0);
    assert.equal(requests.filter((url) => url.pathname === "/api/suppliers/sessions").length, 2); // One per page load.
    assert.deepEqual(errors, []);
    t.diagnostic("6 browser searches, 9 supplier calls, 0 validation preflights; local result filtering makes 0 HTTP requests");
  } finally {
    await browser?.close(); server.closeAllConnections();
    await new Promise((resolvePromise) => server.close(resolvePromise));
    if (previousPath === undefined) delete process.env.GARAGE_DB_PATH; else process.env.GARAGE_DB_PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
});
