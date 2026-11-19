import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";
import { UserAuthService } from "../../src/backend/auth/user-auth-service.ts";
import { createAggregatorServer } from "../../src/backend/http/create-server.ts";

const path = "/api/purchasing/supplier-orders";
const integration = "/api/integration/1c/nomenclature";
const password = "test-password";
const market = { id: randomUUID(), number: "НФНФ-000534", date: "2026-11-16T17:04:27", supplier: "Глушители", buyer: "", amount: null, currency: "643" };
const other = { id: randomUUID(), number: "НФНФ-000545", date: "2026-11-15T15:03:20", supplier: "«Автопитер» ООО",
  buyer: "Chevrolet Cruze | Р555ОХ63", amount: 1943, currency: "643" };
const goods = { name: "Радиатор отопителя ГАЗель 3302 (с 2003 г.в.) d=20 мм | АвтоРад", article: "3302810106010", quantity: 2 };
const marketGoods = { name: "Глушитель 2217,2752, УМЗ 4216, дв. Cummins, Евро-3 | Автоглушитель", article: "AK27527-1201008-10", quantity: 1 };

test("supplier orders search and sort across pages with one 1C job per action and fit narrow screens", { timeout: 90000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "supplier-orders-browser-"));
  const original = process.env.GARAGE_DB_PATH;
  process.env.GARAGE_DB_PATH = join(directory, "garage.sqlite");
  const auth = new UserAuthService(process.env.GARAGE_DB_PATH, "Администратор", password);
  const server = createAggregatorServer({ application: { streamSearch: async () => {}, listSupplierSessions: () => [] }, publicDir: resolve("src/frontend"), auth });
  let browser;
  try {
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const request = (url, options) => fetch(origin + url, options);
    const post = (url, data, headers = {}) => request(url, { method: "POST", body: JSON.stringify(data),
      headers: { "Content-Type": "application/json", ...headers } });
    const login = async (fio) => (await post("/api/auth/login", { fio, password })).headers.get("set-cookie").split(";", 1)[0];
    const admin = await login("Администратор");
    for (const [fio, permissions] of [["Специалист по закупкам", ["purchasing"]], ["Другой сотрудник", ["nomenclature"]]]) {
      assert.equal((await post("/api/users", { fio, password, permissions }, { Cookie: admin })).status, 201);
    }
    const blocked = await login("Другой сотрудник");
    assert.equal((await request(path)).status, 401);
    assert.equal((await request(path + "?q=рынок", { headers: { Cookie: blocked } })).status, 403);
    assert.equal((await request(`${path}/${other.id}`, { headers: { Cookie: blocked } })).status, 403);
    const token = (await (await post("/api/nomenclature/connection", {}, { Cookie: admin })).json()).token;
    const worker = { Authorization: `Bearer ${token}` };
    const claim = async (version, waitSeconds = 0) => {
      const response = await request(`${integration}/requests?stock=${version}&waitSeconds=${waitSeconds}`, { headers: worker });
      assert.equal(response.status, 200);
      return (await response.json()).request;
    };
    const reply = (job, result) => post(integration + "/stock-results", { requestId: job.id, leaseId: job.leaseId,
      status: "completed", products: [], hasMore: false, lastSortValue: null, supplierOrders: result }, worker);
    assert.equal(await claim(8), null);
    assert.equal((await request(path, { headers: { Cookie: admin } })).status, 503);
    assert.equal(await claim(9), null);
    assert.equal((await request(path + "?after=broken", { headers: { Cookie: admin } })).status, 400);
    assert.equal((await request(path + "?sort=amount", { headers: { Cookie: admin } })).status, 503);
    assert.equal((await request(`${path}/${market.id}/preview`, { headers: { Cookie: admin } })).status, 404);

    browser = await chromium.launch({ headless: true, executablePath: process.env.TEST_BROWSER_EXECUTABLE_PATH });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, hasTouch: true });
    await page.route("**/*", async (route) => {
      const url = route.request().url();
      if (url === "https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" && process.env.REPAIRS_BOOTSTRAP_CSS_PATH) {
        return route.fulfill({ contentType: "text/css", body: await readFile(process.env.REPAIRS_BOOTSTRAP_CSS_PATH) });
      }
      return url.startsWith(origin) ? route.continue() : route.abort();
    });
    const requests = [];
    const errors = [];
    page.on("request", (event) => { if (new URL(event.url()).pathname.startsWith(path)) requests.push(event.url()); });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.request.post(origin + "/api/auth/login", { data: { fio: "Специалист по закупкам", password } });
    await page.goto(origin);
    const table = page.locator("#supplier-orders-table");
    const sortBy = (field) => table.locator(`[data-supplier-sort="${field}"]`);
    const search = page.getByRole("searchbox", { name: "Поиск заказов поставщикам" });
    const refresh = page.getByRole("button", { name: "Обновить список" });
    const supplier = (number) => page.getByRole("button", { name: `Открыть заказ № ${number}` });
    const dialog = page.locator("#supplier-order-dialog");
    const listJob = await claim(9, 5);
    assert.deepEqual(listJob.options.supplierOrders, { view: "list", after: null });
    assert.equal(await claim(8), null);
    const many = Array.from({ length: 48 }, (_, index) => ({ ...other, id: randomUUID(), number: `НФНФ-01${index}`, date: "2026-11-13T15:00:00" }));
    const list = { view: "list", orders: [market, other, ...many], hasMore: true };
    const delivered = await reply(listJob, list);
    assert.equal(delivered.status, 200);
    assert.equal((await reply(listJob, list)).status, 200);
    await page.waitForLoadState("networkidle");
    await table.waitFor();
    assert.equal(await table.locator("tbody tr").count(), 50);
    assert.match(await table.locator("tbody").innerText(), /Глушители/);
    assert.deepEqual(await table.getByRole("columnheader").allTextContents(), ["Дата", "Номер", "Поставщик", "Покупатель", "Сумма"]);
    assert.equal(await table.getByRole("button", { name: /Быстрый просмотр/ }).count(), 0);
    assert.equal(await table.locator("..").evaluate((node) => getComputedStyle(node).borderRadius), "10px");
    assert.ok((await refresh.boundingBox()).x > (await search.boundingBox()).x);
    assert.equal(requests.length, 1, "No prefetch or per-row requests");
    await page.getByRole("button", { name: "Показать ещё" }).click();
    const next = await claim(9, 5);
    const last = many.at(-1);
    assert.deepEqual(next.options.supplierOrders, { view: "list", after: { id: last.id, date: last.date } });
    assert.equal((await reply(next, { view: "list", orders: [last], hasMore: false })).status, 400);
    assert.equal((await reply(next, { view: "list", orders: [{ ...last, date: "2026-11-12T00:00:00", id: randomUUID() }], hasMore: false })).status, 200);
    await page.getByRole("button", { name: "Показать ещё" }).waitFor({ state: "hidden" });
    assert.equal(await table.locator("tbody tr").count(), 51);

    await supplier(market.number).click();
    const marketJob = await claim(9, 5);
    assert.deepEqual(marketJob.options.supplierOrders, { view: "order", id: market.id });
    assert.equal((await reply(marketJob, { view: "order", id: other.id, order: null })).status, 400);
    assert.equal((await reply(marketJob, { view: "order", id: market.id, order: {
      ...market, supplier: "Рынок", contract: "Глушители", market: true,
      products: [{ ...marketGoods, stock: 0, receipt: "Не пришёл", price: null, amount: null, returnDays: 0, expectedDate: null }],
    } })).status, 200);
    await dialog.getByText("Не пришёл", { exact: true }).waitFor();
    assert.equal(await dialog.getByText("Договор", { exact: true }).isVisible(), true);
    assert.equal(await dialog.getByRole("columnheader", { name: "Цена" }).count(), 0);
    assert.equal(await dialog.locator("#supplier-order-footer").isVisible(), false);
    assert.equal(requests.length, 3);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    assert.equal(await supplier(market.number).evaluate((node) => node === document.activeElement), true);

    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 760 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await supplier(other.number).click();
      const job = await claim(9, 5);
      assert.deepEqual(job.options.supplierOrders, { view: "order", id: other.id });
      assert.equal((await reply(job, { view: "order", id: other.id, order: { ...other, contract: "", market: false,
        products: [{ ...goods, stock: 7, stockDetails: { original: 0, replacements: [{ name: "Радиатор-замена", article: "R7", quantity: 7 }] },
          receipt: "Пришло 1 из 2", price: 971.5, amount: 1943, returnDays: 14, expectedDate: "2026-11-20" }],
      } })).status, 200);
      await dialog.getByText("Пришло 1 из 2", { exact: true }).waitFor();
      assert.equal(await dialog.getByText(other.buyer, { exact: true }).isVisible(), true);
      assert.match(await dialog.locator("#supplier-order-total").innerText(), /1\s943,00\s*₽/);
      assert.equal(await dialog.getByText("20.11.2026", { exact: true }).isVisible(), true);
      assert.equal(await dialog.locator("#supplier-order-content").evaluate((node) => node.scrollWidth <= node.clientWidth), true);
      const stockButton = dialog.getByRole("button", { name: /Остаток 7/ });
      assert.equal(await dialog.locator(".supplier-order-no-stock").count(), 0);
      await stockButton.click();
      const stockDetails = dialog.getByRole("dialog", { name: "Остаток с учётом заказов" });
      assert.equal(await stockDetails.getByText("Радиатор-замена").isVisible(), true);
      assert.equal(await stockDetails.getByText("Всего 7").isVisible(), true);
      assert.equal(await stockDetails.getByRole("region", { name: "Оригинал" }).count(), 0);
      assert.equal(await stockDetails.evaluate((node) => node.scrollWidth <= node.clientWidth), true);
      await stockDetails.getByRole("button", { name: "Закрыть расшифровку остатка" }).click();
      assert.equal(await dialog.isVisible(), true);
      if (width < 500) assert.ok((await dialog.getByRole("button", { name: "К списку" }).boundingBox()).height >= 44);
      await dialog.getByRole("button", { name: "К списку" }).click();
      await dialog.waitFor({ state: "hidden" });
    }
    assert.equal(requests.length, 6, "One HTTP request per read, with no reload when the card closes");

    assert.equal(await claim(10), null);
    const sortableFields = ["date", "number", "supplier", "buyer", "amount"];
    for (const sort of sortableFields) {
      for (const direction of ["asc", "desc"]) {
        const beforeSort = requests.length;
        await sortBy(sort).click();
        assert.equal(await sortBy(sort).locator("..").getAttribute("aria-sort"), direction === "asc" ? "ascending" : "descending");
        const read = await claim(10, 5);
        const standard = sort === "date" && direction === "desc";
        const view = standard ? "list" : "listPage";
        assert.deepEqual(read.options.supplierOrders, standard ? { view, after: null } : { view, sort, direction, query: "", after: null });
        const sorted = sort === "date" && direction === "asc" ? [other, market] : [market, other];
        const orders = sort === "amount" ? [other, market] : sorted;
        assert.equal((await reply(read, { view, orders, hasMore: false })).status, 200);
        await supplier(market.number).waitFor();
        assert.equal(requests.length, beforeSort + 1);
      }
    }
    assert.ok((await sortBy("buyer").boundingBox()).height >= 44, "Phone sort controls have touch targets");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

    const beforeSearch = requests.length;
    await search.fill("А");
    await search.fill("Автопитер");
    await search.fill("АВТОПИТЕР   НФНФ");
    await page.getByRole("button", { name: "Найти заказы" }).click();
    await search.press("Enter");
    assert.equal(await claim(9), null, "Older workers cannot consume filtered requests");
    const searched = await claim(10, 5);
    assert.deepEqual(searched.options.supplierOrders, { view: "listPage", sort: "amount", direction: "desc",
      query: "автопитер нфнф", after: null });
    const withoutPrice = many.map((order) => ({ ...order, amount: null }));
    const unpricedLast = { ...last, id: randomUUID(), number: "НФНФ-01099", amount: null };
    assert.equal((await reply(searched, { view: "listPage", orders: [...withoutPrice, unpricedLast, other], hasMore: true, lastValue: other.amount })).status, 400);
    assert.equal((await reply(searched, { view: "listPage", orders: [other, ...withoutPrice, unpricedLast], hasMore: true, lastValue: null })).status, 200);
    await supplier(other.number).waitFor();
    assert.equal(requests.length, beforeSearch + 1, "Rapid input and Enter share one request");
    await page.getByRole("button", { name: "Показать ещё" }).click();
    const continuation = await claim(10, 5);
    assert.deepEqual(continuation.options.supplierOrders, { ...searched.options.supplierOrders, after: { id: unpricedLast.id, value: null } });
    const nextUrl = new URL(requests.at(-1));
    nextUrl.searchParams.set("direction", "asc");
    assert.equal((await request(path + nextUrl.search, { headers: { Cookie: admin } })).status, 400);
    assert.equal((await reply(continuation, { view: "listPage", orders: [{ ...other, id: randomUUID() }], hasMore: false })).status, 400);
    assert.equal((await reply(continuation, { view: "listPage", orders: [], hasMore: false })).status, 200);
    await page.getByRole("button", { name: "Показать ещё" }).waitFor({ state: "hidden" });
    await refresh.click();
    const refreshed = await claim(10, 5);
    assert.deepEqual(refreshed.options.supplierOrders, searched.options.supplierOrders);
    assert.equal((await reply(refreshed, { view: "listPage", orders: [other], hasMore: false })).status, 200);
    await supplier(other.number).waitFor();
    assert.equal(requests.length, beforeSearch + 3);

    await search.fill("");
    const cleared = await claim(10, 5);
    assert.equal(cleared.options.supplierOrders.query, "");
    assert.equal((await reply(cleared, { view: "listPage", orders: [other, market], hasMore: false })).status, 200);
    await supplier(market.number).waitFor();
    assert.equal(requests.length, beforeSearch + 4);
    assert.equal(await claim(10), null);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    if (original === undefined) delete process.env.GARAGE_DB_PATH; else process.env.GARAGE_DB_PATH = original;
    await rm(directory, { recursive: true, force: true });
  }
});
