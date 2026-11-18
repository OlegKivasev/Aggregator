import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";
import { UserAuthService } from "../../src/backend/auth/user-auth-service.ts";
import { createAggregatorServer } from "../../src/backend/http/create-server.ts";

const secret = "isolated-repair-form-browser-secret";
const workerHeader = { Authorization: `Bearer ${secret}` };
const card = {
  documentId: randomUUID(), number: "НФНФ-002327", date: "2026-11-16T09:46:51", vehicleName: "Chevrolet Niva 2123",
  status: "В работе", responsibleFio: "Тестовый мастер", contactPhone: "+7 900 000 00 00",
  goodsReadiness: { totalPositions: 2, availablePositions: 1 }, paymentStatus: "partially_paid", amountDue: 5700,
};
const stock = {
  name: "Комплект ГРМ 21214, Шеви Нива", article: "101006001BGC", productId: randomUUID(), stock: 0, quantity: 1,
  price: 6453, original: 3, replacement: 2, returnDays: 0, discountPercent: 5, discountAmount: 322.65,
  total: 6130.35, seller: "Тестовый продавец",
};
const details = {
  customer: "Chevrolet Niva 2123 | У994СМ163", contract: "ТО автомобиля", mileage: 123456, vin: "XTA21230000012345",
  keySlot: 3, cashPayment: true, total: 8400, cashTotal: 8400, discountAmount: 322.65, discountPercent: 5,
  goods: [stock, { ...stock, name: "Очиститель тормозов", article: "2105", productId: randomUUID(), stock: 19, quantity: 2,
    original: 0, replacement: 0, returnDays: null, discountAmount: 0, discountPercent: 0, price: 341, total: 682 }],
  work: [{ name: "Замена ремня ГРМ", performer: "Тестовый механик", price: 1400, hours: 1.5, multiplier: 1, total: 2100, seller: "Тестовый продавец" }],
};

test("employee opens a single fresh repair order and its allowed supplier orders on desktop and mobile", async () => {
  const dir = await mkdtemp(join(tmpdir(), "repair-order-browser-"));
  const previous = [process.env.GARAGE_DB_PATH, process.env.ONEC_REPAIRS_INTEGRATION_SECRET];
  process.env.GARAGE_DB_PATH = join(dir, "garage.sqlite");
  process.env.ONEC_REPAIRS_INTEGRATION_SECRET = secret;
  const auth = new UserAuthService(process.env.GARAGE_DB_PATH, "Администратор", "test-admin-password");
  const server = createAggregatorServer({ application: { streamSearch: async () => {}, listSupplierSessions: () => [] }, publicDir: resolve("src/frontend"), auth });
  let browser;
  try {
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const post = (path, data, headers = {}) => fetch(`${origin}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(data) });
    const admin = (await post("/api/auth/login", { fio: "Администратор", password: "test-admin-password" })).headers.get("set-cookie").split(";", 1)[0];
    for (const fio of [card.responsibleFio, "Другой мастер"]) {
      const user = await post("/api/users", { fio, permissions: ["repairs"], password: "test-user-password" }, { Cookie: admin });
      assert.equal(user.status, 201);
    }
    const other = (await post("/api/auth/login", { fio: "Другой мастер", password: "test-user-password" })).headers.get("set-cookie").split(";", 1)[0];
    const token = (await (await post("/api/nomenclature/connection", {}, { Cookie: admin })).json()).token;
    const nomenclatureHeader = { Authorization: `Bearer ${token}` };
    const claim = async (kind, waitSeconds) => {
      const repairs = kind === "repair";
      const path = repairs ? "/api/integration/1c/repairs/refresh/requests?testPlatform=false" : "/api/integration/1c/nomenclature/requests?stock=8";
      const response = await fetch(`${origin}${path}&waitSeconds=${waitSeconds}`, { headers: repairs ? workerHeader : nomenclatureHeader });
      assert.equal(response.status, 200);
      return (await response.json()).request;
    };
    await claim("repair", 0);
    await claim("stock", 0);
    assert.equal((await post("/api/integration/1c/repairs", card, workerHeader)).status, 200);
    assert.equal((await post("/api/integration/1c/repairs", { ...card, documentId: randomUUID(), responsibleFio: "Другой мастер" }, workerHeader)).status, 200);

    browser = await chromium.launch({ headless: true, executablePath: process.env.TEST_BROWSER_EXECUTABLE_PATH });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, timezoneId: "America/Los_Angeles" });
    await page.request.post(`${origin}/api/auth/login`, { data: { fio: card.responsibleFio, password: "test-user-password" } });
    const pageErrors = [];
    const jobs = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("request", (req) => {
      if (req.method() === "POST" && new URL(req.url()).pathname === "/api/repairs/refresh") jobs.push(req.postDataJSON());
    });
    await page.route("**/*", async (route) => {
      const url = route.request().url();
      if (url === "https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" && process.env.REPAIRS_BOOTSTRAP_CSS_PATH) {
        return route.fulfill({ contentType: "text/css", body: await readFile(process.env.REPAIRS_BOOTSTRAP_CSS_PATH) });
      }
      return url.startsWith(origin) ? route.continue() : route.abort();
    });
    await page.goto(origin);
    await page.waitForLoadState("networkidle");
    const trigger = page.getByRole("button", { name: /Открыть заказ-наряд НФНФ-002327/ });
    const dialog = page.getByRole("dialog", { name: "Заказ-наряд 2327 от 16.11.2026" });
    const open = async (value, currentCard) => {
      await trigger.click();
      const job = await claim("repair", 5);
      assert.deepEqual(job.documentIds, [card.documentId]);
      assert.equal(job.includeDetails, true);
      const reply = { requestId: job.id, leaseId: job.leaseId, testPlatform: false, status: "success", repairs: [currentCard], removedDocumentIds: [], details: value };
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await post("/api/integration/1c/repairs/refresh/results", reply, workerHeader);
        assert.equal((await response.json()).status, "completed");
      }
      await dialog.getByRole("tab", { name: "Товары (2)" }).waitFor();
      return job.id;
    };
    const requestId = await open(details, card);
    assert.equal(await dialog.getByText("№ НФНФ-002327").isVisible(), true);
    assert.equal(await dialog.getByText("ТО автомобиля").isVisible(), true);
    assert.equal(await dialog.getByText(details.vin).isVisible(), true);
    assert.equal(await dialog.getByText(card.contactPhone).isVisible(), true);
    assert.equal(await dialog.getByText("Ячейка для ключей").isVisible(), true);
    assert.equal(await dialog.getByText("Организация").count(), 0);
    assert.equal(await dialog.getByRole("columnheader", { name: "Дней до возврата" }).count(), 1);
    assert.match(await dialog.getByRole("row", { name: /Комплект ГРМ/ }).innerText(), /0/);
    assert.equal(await dialog.getByText("Доплатить наличными").isVisible(), true);
    assert.equal(await dialog.getByText("Ручная скидка").isVisible(), true);
    assert.equal(await dialog.getByRole("columnheader", { name: "Скидка" }).count(), 1);

    const supplyPath = `/api/repairs/refresh/${requestId}/incoming?testPlatform=false&side=original&product=`;
    assert.equal((await fetch(`${origin}${supplyPath}${stock.productId}`, { headers: { Cookie: other } })).status, 404);
    assert.equal((await page.request.get(`${origin}${supplyPath}${randomUUID()}`)).status(), 404);
    assert.equal((await page.request.get(`${origin}/api/nomenclature/incoming?side=original&product=${stock.productId}`)).status(), 403);
    for (const [width, side] of [[1440, "original"], [390, "replacement"], [320, "original"]]) {
      await page.setViewportSize({ width, height: 844 });
      const scroll = await dialog.locator(".repair-order-scroll").evaluate((node) => ({ outer: node.clientWidth, content: node.scrollWidth }));
      assert.ok(scroll.content <= scroll.outer, `Видимая ширина ${scroll.outer}px, содержимое ${scroll.content}px при окне ${width}px`);
      await dialog.getByRole("button", { name: side === "original" ? /Поставки оригинала/ : /Поставки замен/ }).click();
      const job = await claim("stock", 5);
      assert.deepEqual(job.options.incomingDetails, { productId: stock.productId, side });
      assert.equal((await post("/api/integration/1c/nomenclature/stock-results", {
        requestId: job.id, leaseId: job.leaseId, status: "completed", products: [], hasMore: false,
        incomingDetails: { orders: [{ orderId: randomUUID(), productId: side === "original" ? stock.productId : randomUUID(),
          supplier: "Тестовый поставщик", number: "001", name: stock.name, article: stock.article,
          ordered: 3, quantity: 2, expectedDate: "2026-11-19" }], hasMore: false },
      }, nomenclatureHeader)).status, 200);
      const popover = dialog.locator("#repair-order-incoming");
      await popover.getByText(/Тестовый поставщик/).waitFor();
      const box = await popover.boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= width);
      await popover.getByRole("button", { name: "Закрыть поставки" }).click();
    }
    await dialog.getByRole("tab", { name: "Работы (1)" }).click();
    assert.equal(await dialog.getByText("Тестовый механик").isVisible(), true);
    assert.equal(await dialog.getByText("1,5 н·ч").isVisible(), true);
    assert.equal(await dialog.getByRole("columnheader", { name: "Скидка" }).count(), 0);
    await dialog.getByRole("button", { name: "К заказ-нарядам" }).click();
    assert.equal(await dialog.isVisible(), false);
    await open({ ...details, contract: "", vin: "", keySlot: 0, cashPayment: false, discountAmount: 0, discountPercent: 0,
      goods: details.goods.map((row) => ({ ...row, returnDays: null, discountAmount: 0, discountPercent: 0 })) }, { ...card, contactPhone: undefined });
    for (const label of ["Договор", "VIN", "Телефон контрагента", "Ячейка для ключей", "Дней до возврата", "Скидка", "Ручная скидка"]) {
      assert.equal(await dialog.getByText(label, { exact: true }).count(), 0);
    }
    assert.equal(await dialog.getByText("Доплатить картой").isVisible(), true);
    assert.equal(jobs.length, 2);
    assert.deepEqual(pageErrors, []);
    const list = (await (await page.request.get(`${origin}/api/repairs?testPlatform=false`)).json()).repairs;
    assert.equal(list.length, 1);
    assert.equal(list[0].details, undefined);
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    for (const [index, key] of ["GARAGE_DB_PATH", "ONEC_REPAIRS_INTEGRATION_SECRET"].entries()) {
      if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index];
    }
    await rm(dir, { recursive: true, force: true });
  }
});
