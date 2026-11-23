import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";
import { UserAuthService } from "../../src/backend/auth/user-auth-service.ts";
import { createAggregatorServer } from "../../src/backend/http/create-server.ts";
import { productCardFixture } from "../fixtures/product-card.mjs";

const secret = "isolated-repair-form-browser-secret";
const workerHeader = { Authorization: `Bearer ${secret}` };
const card = {
  documentId: randomUUID(), number: "НФНФ-002327", date: "2026-11-16T09:46:51", vehicleName: "Chevrolet Niva 2123",
  status: "В работе", responsibleFio: "Тестовый мастер", contactPhone: "+7 900 000 00 00",
  goodsReadiness: { totalPositions: 2, availablePositions: 1 }, paymentStatus: "partially_paid", amountDue: 5700,
};
const stock = {
  name: "Комплект ГРМ 21214, Шеви Нива", article: "101006001BGC", productId: randomUUID(), stock: 0, quantity: 1,
  price: 6453, original: 3, replacement: 2, returnDays: 5, discountPercent: 5, discountAmount: 322.65,
  total: 6130.35, seller: "Тестовый продавец",
};
const details = {
  customer: "Chevrolet Niva 2123 | У994СМ163", contract: "ТО автомобиля", mileage: 123456, vin: "XTA21230000012345",
  keySlot: 3, cashPayment: true, total: 8400, cashTotal: 8400, cardTotal: 9200, paidAmount: 2700, discountAmount: 322.65, discountPercent: 5,
  goods: [stock, { ...stock, name: "Очиститель тормозов", article: "", productId: randomUUID(), stock: 19, quantity: 2,
    original: 0, replacement: 0, returnDays: null, discountAmount: 0, discountPercent: 0, price: 341, total: 682 }],
  work: [{ name: "Замена ремня ГРМ", performer: "Тестовый механик", price: 1400, hours: 1.5, multiplier: 1, total: 2100, seller: "Тестовый продавец" }],
};
const awaitingPart = { ...details.goods[1], name: "Подшипник под заказ", productId: randomUUID(), stock: 0, original: 2, awaitingDelivery: true };
const money = new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB" });

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
      const user = await post("/api/users", { fio, permissions: ["repairs", "nomenclature"], password: "test-user-password" }, { Cookie: admin });
      assert.equal(user.status, 201);
    }
    const other = (await post("/api/auth/login", { fio: "Другой мастер", password: "test-user-password" })).headers.get("set-cookie").split(";", 1)[0];
    const token = (await (await post("/api/nomenclature/connection", {}, { Cookie: admin })).json()).token;
    const nomenclatureHeader = { Authorization: `Bearer ${token}` };
    const claim = async (kind, waitSeconds, testPlatform = false, version = 11) => {
      const repairs = kind === "repair";
      const path = repairs ? "/api/integration/1c/repairs/refresh/requests?testPlatform=false" : `/api/integration/1c/nomenclature/requests?stock=${version}&testPlatform=${testPlatform}`;
      const response = await fetch(`${origin}${path}&waitSeconds=${waitSeconds}`, { headers: repairs ? workerHeader : nomenclatureHeader });
      assert.equal(response.status, 200);
      return (await response.json()).request;
    };
    await claim("repair", 0);
    await claim("stock", 0);
    assert.equal((await post("/api/integration/1c/repairs", { ...card, urgentReturnDays: 5 }, workerHeader)).status, 200);
    assert.equal((await post("/api/integration/1c/repairs", { ...card, documentId: randomUUID(), responsibleFio: "Другой мастер" }, workerHeader)).status, 200);

    browser = await chromium.launch({ headless: true, executablePath: process.env.TEST_BROWSER_EXECUTABLE_PATH });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, hasTouch: true, timezoneId: "America/Los_Angeles" });
    await page.addInitScript(() => localStorage.setItem("autoservice.activeFunction", "repairs"));
    await page.request.post(`${origin}/api/auth/login`, { data: { fio: card.responsibleFio, password: "test-user-password" } });
    const pageErrors = [];
    const jobs = [];
    const apiRequests = [];
    const repairRequests = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("request", (req) => {
      const path = new URL(req.url()).pathname;
      if (path.startsWith("/api/")) apiRequests.push(path);
      if (path.startsWith("/api/repairs/refresh")) repairRequests.push(path);
      if (req.method() === "POST" && path === "/api/repairs/refresh") jobs.push(req.postDataJSON());
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
    const readiness = page.locator(".repairs-readiness-facts");
    assert.equal(await readiness.getByText("В наличии 1 из 2 позиций").isVisible(), true);
    assert.equal(await readiness.getByText("Возврат · 5 дн.").isVisible(), true);
    const trigger = page.getByRole("button", { name: /Открыть заказ-наряд НФНФ-002327/ });
    const dialog = page.getByRole("dialog", { name: "Заказ-наряд 2327 от 16.11.2026" });
    const open = async (value, currentCard, beforeReply) => {
      const waiting = beforeReply ? page.waitForRequest((request) => request.method() === "GET"
        && request.url().includes("/api/repairs/refresh/") && request.url().includes("waitSeconds=")) : null;
      await trigger.click();
      const job = await claim("repair", 5);
      assert.deepEqual(job.documentIds, [card.documentId]);
      assert.equal(job.includeDetails, true);
      if (waiting) { await waiting; await beforeReply(); }
      const reply = { requestId: job.id, leaseId: job.leaseId, testPlatform: false, status: "success", repairs: [currentCard], removedDocumentIds: [], details: value };
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await post("/api/integration/1c/repairs/refresh/results", reply, workerHeader);
        assert.equal((await response.json()).status, "completed");
      }
      await dialog.getByRole("group", { name: "Способ оплаты" }).waitFor();
      return job.id;
    };
    const stockDetails = { original: 5, replacements: [{ name: "Комплект-замена | Закрытый бренд", article: "PRIVATE-REPLACEMENT", quantity: 15 }] };
    const requestId = await open({ ...details,
      goods: [{ ...stock, stock: 20, stockDetails }, details.goods[1], awaitingPart,
        { ...awaitingPart, name: "Нет на складе", productId: randomUUID(), original: 0, awaitingDelivery: false },
        ...[4, 3, 2, 1, 0, -3, 6].map((returnDays) => ({ ...details.goods[1], returnDays, awaitingDelivery: returnDays === 2 }))],
      work: [...details.work, { ...details.work[0], name: "Замена фильтра", hours: 1, multiplier: 2 }],
    }, { ...card, urgentReturnDays: 0 });
    assert.equal(await page.evaluate(() => document.activeElement.id), "repair-order-title");
    const cash = dialog.getByRole("button", { name: "Наличными", exact: true });
    const bankCard = dialog.getByRole("button", { name: "Картой", exact: true });
    const footerValue = (label) => dialog.locator("footer dl > div").filter({ has: page.getByText(label, { exact: true }) }).locator("dd");
    assert.equal(await cash.getAttribute("aria-pressed"), "true");
    assert.equal(await footerValue("Всего").textContent(), money.format(8400));
    assert.equal(await footerValue("Доплатить наличными").textContent(), money.format(5700));
    const beforePreview = repairRequests.length;
    await bankCard.click();
    assert.equal(await bankCard.getAttribute("aria-pressed"), "true");
    assert.equal(await footerValue("Всего").textContent(), money.format(9200));
    assert.equal(await footerValue("Доплатить картой").textContent(), money.format(6500));
    assert.equal(await footerValue("Доплатить наличными").count(), 0);
    assert.equal(await dialog.locator("footer dt").filter({ hasText: /^Наличными$/ }).count(), 0);
    assert.equal(repairRequests.length, beforePreview, "switching payment makes no API request");
    assert.equal(await dialog.getByText("№ НФНФ-002327").isVisible(), true);
    assert.equal(await dialog.getByText("ТО автомобиля").isVisible(), true);
    assert.equal(await dialog.getByText(details.vin).isVisible(), true);
    assert.equal(await dialog.getByText(card.contactPhone).isVisible(), true);
    assert.equal(await dialog.getByText("Ячейка для ключей").isVisible(), true);
    assert.equal(await dialog.getByText("Организация").count(), 0);
    assert.equal(await dialog.getByRole("columnheader", { name: "Возврат, дн." }).count(), 1);
    assert.deepEqual(await dialog.locator(".repair-order-return-urgent .repair-order-return-days").allTextContents(), ["5", "4", "3", "2", "1", "0", "0"]);
    assert.equal(await dialog.locator(".repair-order-return-urgent").first().evaluate((row) => getComputedStyle(row).outlineStyle), "solid");
    const goodsTable = dialog.getByRole("table", { name: "Товары" });
    const stockButton = goodsTable.getByRole("button", { name: /Остаток 20/ });
    const stockPopover = dialog.getByRole("dialog", { name: "Остаток с учётом заказов" });
    async function checkStockPopover(width, open) {
      const before = apiRequests.length;
      await open();
      await stockPopover.waitFor();
      assert.equal(await stockPopover.getAttribute("id"), "repair-order-incoming");
      assert.equal(await stockPopover.getByText("PRIVATE-REPLACEMENT").isVisible(), true);
      assert.equal(await stockPopover.getByText("Всего 20").isVisible(), true);
      assert.equal(await stockButton.getAttribute("aria-expanded"), "true");
      assert.equal(await stockPopover.getByRole("region", { name: "Оригинал" }).locator("dd").textContent(), "5");
      assert.equal(await stockPopover.getByRole("region", { name: "Замена" }).locator("dd").textContent(), "15");
      const box = await stockPopover.boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= width);
      assert.equal(apiRequests.length, before, "stock details use the order snapshot");
    }
    await checkStockPopover(1440, () => stockButton.press("Enter"));
    await page.keyboard.press("Escape");
    assert.equal(await stockPopover.isVisible(), false);
    assert.equal(await stockButton.getAttribute("aria-expanded"), "false");
    assert.equal(await stockButton.evaluate((node) => document.activeElement === node), true);
    assert.equal(await dialog.isVisible(), true);
    const cardUrl = (id, productId) => `${origin}/api/repairs/refresh/${id}/products/${productId}?testPlatform=false`;
    assert.equal((await page.request.get(cardUrl(requestId, randomUUID()))).status(), 404);
    const publishCard = (job, product, overrides) => post("/api/integration/1c/nomenclature/stock-results", {
      requestId: job.id, leaseId: job.leaseId, status: "completed", products: [], hasMore: false,
      productCard: { id: product.productId, view: "card", data: productCardFixture(product, overrides) },
    }, nomenclatureHeader);
    const openProduct = async (name, product, overrides) => {
      const response = page.waitForResponse((reply) => new URL(reply.url()).pathname.endsWith(`/products/${product.productId}`));
      await goodsTable.getByRole("button", { name, exact: true }).click();
      assert.equal(await claim("stock", 0, true), null, "test workers cannot claim a production repair's product");
      const job = await claim("stock", 5);
      assert.deepEqual(job.options.productCard, { id: product.productId, testPlatform: false, view: "card" });
      assert.equal((await publishCard(job, product, overrides)).status, 200);
      return (await response).json();
    };
    const unrestrictedProduct = await openProduct(stock.name, stock);
    assert.equal(unrestrictedProduct.article, stock.article);
    const productDialog = page.getByRole("dialog", { name: stock.name, exact: true });
    await productDialog.getByText("Рекомендованная закупка").waitFor();
    await productDialog.getByRole("button", { name: "Закрыть", exact: true }).click();
    assert.equal(await dialog.isVisible(), true);
    const waitingRow = goodsTable.getByRole("row", { name: /Подшипник под заказ/ });
    const waitStyles = (row) => row.evaluate((node) => ({
      color: getComputedStyle(node).outlineColor,
      shadow: getComputedStyle(node).boxShadow,
    }));
    assert.equal(await goodsTable.locator(".repair-order-awaiting-delivery").count(), 2);
    assert.equal((await waitStyles(waitingRow)).color, "rgb(187, 137, 9)");
    assert.equal(await waitingRow.getByRole("button", { name: "Поставки оригинала, 2" }).isVisible(), true);
    assert.equal(await waitingRow.getByRole("rowheader").getAttribute("title"), "Ожидает поставки по заказ-наряду");
    assert.doesNotMatch(await goodsTable.getByRole("row", { name: /Нет на складе/ }).getAttribute("class") ?? "", /awaiting-delivery/);
    assert.doesNotMatch(await goodsTable.getByRole("row", { name: /Комплект ГРМ/ }).getAttribute("class") ?? "", /awaiting-delivery/);
    const dual = goodsTable.locator(".repair-order-awaiting-delivery.repair-order-return-urgent");
    assert.equal(await dual.locator(".repair-order-return-days").textContent(), "2");
    assert.match((await waitStyles(dual)).shadow, /rgb\(177, 38, 32\)/);
    for (const heading of ["Остаток", "Цена", "Кол-во", "Возврат, дн.", "Сумма"]) {
      const column = goodsTable.getByRole("columnheader", { name: heading, exact: true });
      assert.equal(await column.evaluate((node) => getComputedStyle(node).textAlign), "center");
    }
    assert.doesNotMatch(await goodsTable.innerText(), /₽/);
    assert.equal(await dialog.getByText("Ручная скидка").isVisible(), true);
    assert.equal(await dialog.getByRole("columnheader", { name: "Скидка" }).count(), 1);

    const supplyPath = `/api/repairs/refresh/${requestId}/incoming?testPlatform=false&side=original&product=`;
    assert.equal((await fetch(`${origin}${supplyPath}${stock.productId}`, { headers: { Cookie: other } })).status, 404);
    assert.equal((await page.request.get(`${origin}${supplyPath}${randomUUID()}`)).status(), 404);
    const engineRow = goodsTable.getByRole("row", { name: /Комплект ГРМ/ });
    async function checkSupply(row, product, side, width, mobile = false) {
      const button = row.getByRole("button", { name: side === "original" ? /Поставки оригинала/ : /Поставки замен/ });
      if (mobile) assert.ok((await button.boundingBox()).height >= 44);
      const before = repairRequests.length;
      await button[mobile ? "tap" : "click"]();
      const job = await claim("stock", 5);
      assert.deepEqual(job.options.incomingDetails, { productId: product.productId, side, testPlatform: false });
      assert.equal((await post("/api/integration/1c/nomenclature/stock-results", {
        requestId: job.id, leaseId: job.leaseId, status: "completed", products: [], hasMore: false,
        incomingDetails: { orders: [{ orderId: randomUUID(), productId: side === "original" ? product.productId : randomUUID(),
          supplier: "Тестовый поставщик", number: "001", name: product.name, article: product.article,
          ordered: 3, quantity: 2, expectedDate: "2026-11-19" }], hasMore: false },
      }, nomenclatureHeader)).status, 200);
      const popover = dialog.locator("#repair-order-incoming");
      await popover.getByText(/Тестовый поставщик/).waitFor();
      assert.match(await popover.getByRole("listitem").innerText(), /19 нояб\. 2026/);
      const box = await popover.boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= width);
      await popover.getByRole("button", { name: "Закрыть поставки" })[mobile ? "tap" : "click"]();
      assert.equal(await popover.isVisible(), false);
      assert.equal(await button.getAttribute("aria-expanded"), "false");
      assert.equal(repairRequests.length - before, 1, "one request for the tapped shipment details");
    }
    const desktopScroll = await dialog.locator(".repair-order-scroll").evaluate((node) => ({ outer: node.clientWidth, content: node.scrollWidth }));
    assert.ok(desktopScroll.content <= desktopScroll.outer);
    for (const side of ["original", "replacement"]) {
      await checkSupply(engineRow, stock, side, 1440);
    }

    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      const scroll = await dialog.locator(".repair-order-scroll").evaluate((node) => ({ outer: node.clientWidth, content: node.scrollWidth }));
      assert.ok(scroll.content <= scroll.outer, `Мобильная карточка помещается при ширине ${width}px`);
      const firstRow = goodsTable.locator("tbody tr").nth(0);
      const emptyOptionals = goodsTable.locator("tbody tr").nth(1);
      const labels = (row) => row.locator(".repair-order-cell-label:visible").allTextContents();
      assert.deepEqual(await labels(firstRow), ["Артикул", "Остаток", "Цена", "Кол-во", "К поступлению", "Возврат, дн.", "Скидка", "Сумма"]);
      assert.deepEqual(await labels(emptyOptionals), ["Остаток", "Цена", "Кол-во", "Сумма"]);
      assert.equal(await goodsTable.locator("[data-incoming-side]:visible").count(), 3);
      assert.equal(await emptyOptionals.getByText("К поступлению", { exact: true }).isVisible(), false);
      assert.equal((await waitStyles(waitingRow)).color, "rgb(187, 137, 9)");
      await checkStockPopover(width, () => stockButton.tap());
      await stockPopover.getByRole("button", { name: "Закрыть расшифровку остатка" }).tap();
      assert.equal(await stockPopover.isVisible(), false);
      await checkSupply(waitingRow, awaitingPart, "original", width, true);
      await checkSupply(firstRow, stock, "replacement", width, true);
      const productName = firstRow.getByRole("rowheader");
      assert.equal(await productName.evaluate((node) => getComputedStyle(node).webkitTapHighlightColor), "rgba(0, 0, 0, 0)");
      const product = await openProduct(stock.name, stock);
      assert.equal(product.article, stock.article);
      await productDialog.getByRole("button", { name: "Закрыть", exact: true }).tap();
    }
    await dialog.getByRole("tab", { name: "Работы (2)" }).click();
    assert.equal(await dialog.getByText("Тестовый механик").first().isVisible(), true);
    assert.equal(await dialog.getByRole("columnheader", { name: "Норма времени" }).count(), 1);
    assert.equal(await dialog.getByRole("columnheader", { name: "Кратность" }).count(), 1);
    assert.doesNotMatch(await dialog.getByRole("table", { name: "Работы" }).innerText(), /₽/);
    assert.equal(await dialog.getByRole("columnheader", { name: "Скидка" }).count(), 0);
    assert.equal(await dialog.locator("#repair-order-work .repair-order-desktop-only:visible").count(), 0);
    await dialog.getByRole("button", { name: "К заказ-нарядам" }).click();
    assert.equal(await dialog.isVisible(), false);
    await open({ ...details, contract: "", vin: "", mileage: 0, keySlot: 0, cashPayment: false, total: 9200, discountAmount: 0, discountPercent: 0, work: [],
      goods: [...details.goods.map((row) => ({ ...row, original: 0, replacement: 0, returnDays: null, discountAmount: 0, discountPercent: 0 })),
        { ...awaitingPart, stock: 2, original: 0, awaitingDelivery: false }] },
    { ...card, amountDue: 6500, contactPhone: undefined });
    const fields = dialog.locator(".repair-order-details, .repair-order-footer");
    for (const label of ["Договор", "VIN", "Пробег", "Телефон контрагента", "Ячейка для ключей", "К поступлению", "Возврат, дн.", "Скидка", "Ручная скидка"]) {
      assert.equal(await fields.getByText(label, { exact: true }).count(), 0, `Скрытое поле ${label}`);
    }
    assert.equal(await dialog.getByRole("tablist").count(), 0);
    assert.equal(await goodsTable.isVisible(), true);
    assert.equal(await goodsTable.locator(".repair-order-awaiting-delivery").count(), 0);
    assert.equal(await bankCard.getAttribute("aria-pressed"), "true");
    assert.equal(await footerValue("Доплатить картой").textContent(), money.format(6500));
    await cash.click();
    assert.equal(await footerValue("Доплатить наличными").textContent(), money.format(5700));
    await dialog.getByRole("button", { name: "Закрыть заказ-наряд" }).click();
    assert.equal(await dialog.isVisible(), false);

    const settledCard = { ...card, paymentStatus: "paid", amountDue: 0 };
    await page.setViewportSize({ width: 1440, height: 900 });
    await open({ ...details, goods: [], work: [{ ...details.work[0], hours: 1, multiplier: 2 }], paidAmount: 8400 }, settledCard);
    assert.equal(await dialog.getByRole("tablist").count(), 0);
    assert.equal(await goodsTable.count(), 0);
    assert.equal(await dialog.getByRole("table", { name: "Работы" }).isVisible(), true);
    assert.equal(await dialog.getByRole("columnheader", { name: "Норма времени" }).count(), 0);
    assert.equal(await dialog.getByRole("columnheader", { name: "Кратность" }).count(), 1);
    assert.equal(await footerValue("Доплатить наличными").count(), 0);
    await bankCard.click();
    assert.equal(await footerValue("Доплатить картой").textContent(), money.format(800));
    await page.mouse.click(2, 2);
    assert.equal(await dialog.isVisible(), false);

    await page.setViewportSize({ width: 390, height: 844 });
    await open({ ...details, goods: [], cashPayment: false, cashTotal: null, cardTotal: undefined, paidAmount: undefined }, settledCard);
    assert.equal(await cash.isDisabled(), true);
    assert.equal(await bankCard.getAttribute("aria-pressed"), "true");
    assert.equal(await dialog.getByRole("columnheader", { name: "Норма времени" }).count(), 1);
    assert.equal(await dialog.getByRole("columnheader", { name: "Кратность" }).count(), 0);
    await page.mouse.click(2, 2);
    assert.equal(await dialog.isVisible(), false);
    assert.equal(jobs.length, 4);
    assert.deepEqual(pageErrors, []);
    const list = (await (await page.request.get(`${origin}/api/repairs?testPlatform=false`)).json()).repairs;
    assert.equal(list.length, 1);
    assert.equal(list[0].details, undefined);
    assert.equal(list[0].urgentReturnDays, undefined);
    await page.reload();
    await page.waitForLoadState("networkidle");
    assert.equal(await readiness.getByText("В наличии 1 из 2 позиций").isVisible(), true);
    assert.equal(await readiness.locator(".repairs-urgent-return").count(), 0);

    const createPosition = await post("/api/users/positions", { name: "Механик", hideArticle: true, hideBrand: true }, { Cookie: admin });
    assert.equal(createPosition.status, 201);
    const { position } = await createPosition.json();
    const userList = await (await fetch(`${origin}/api/users`, { headers: { Cookie: admin } })).json();
    const employee = userList.users.find((user) => user.fio === card.responsibleFio);
    const adminEdit = (path, data) => fetch(`${origin}${path}`, {
      method: "PATCH", headers: { Cookie: admin, "Content-Type": "application/json" }, body: JSON.stringify(data),
    });
    const assign = (positionId) => adminEdit("/api/users", { id: employee.id, fio: employee.fio, permissions: employee.permissions, positionId });
    const branded = { ...stock, name: "Комплект ГРМ | Закрытый бренд | Серия", article: "PRIVATE-ARTICLE", stock: 20, stockDetails };
    await page.setViewportSize({ width: 1440, height: 900 });
    const restrictedId = await open({ ...details, goods: [branded] }, card, async () => {
      assert.equal((await assign(position.id)).status, 200);
    });
    const rawSnapshot = async () => (await (await page.request.get(`${origin}/api/repairs/refresh/${restrictedId}?testPlatform=false`)).json()).refresh.details;
    const restricted = await rawSnapshot();
    assert.equal(restricted.hideArticles, true);
    assert.deepEqual(restricted.goods[0].stockDetails.replacements, [{ name: "Комплект-замена", article: "", quantity: 15 }]);
    assert.equal(restricted.goods[0].name, "Комплект ГРМ");
    assert.equal(restricted.goods[0].article, "");
    assert.equal(await goodsTable.getByRole("columnheader", { name: "Артикул" }).count(), 0);
    assert.equal(await goodsTable.getByRole("rowheader", { name: "Комплект ГРМ", exact: true }).isVisible(), true);
    assert.equal((await fetch(cardUrl(restrictedId, branded.productId), { headers: { Cookie: other } })).status, 404);
    const related = { id: randomUUID(), name: "Комплект-замена | Закрытый бренд", article: "PRIVATE-REPLACEMENT", brand: "Закрытый бренд" };
    const limitedProduct = await openProduct("Комплект ГРМ", branded, {
      brand: "Закрытый бренд", stock: 20, stockDetails, replacements: [related],
    });
    assert.equal(limitedProduct.name, "Комплект ГРМ");
    assert.equal(limitedProduct.article, "");
    assert.equal(limitedProduct.brand, "");
    assert.equal(limitedProduct.image, null);
    assert.deepEqual(limitedProduct.oem, []);
    assert.doesNotMatch(JSON.stringify(limitedProduct), /Закрытый бренд|PRIVATE-ARTICLE|PRIVATE-REPLACEMENT/);
    const signedRelated = limitedProduct.replacements[0];
    assert.equal((await page.request.get(cardUrl(restrictedId, related.id))).status(), 404, "unseen UUID is not granted");
    assert.equal((await page.request.get(cardUrl(restrictedId, randomUUID()) + "&grant=" + signedRelated.cardProof)).status(), 404, "grant cannot open a different product");
    assert.equal((await fetch(cardUrl(restrictedId, related.id) + "&grant=" + signedRelated.cardProof, { headers: { Cookie: other } })).status, 404);
    const limitedDialog = page.getByRole("dialog", { name: "Комплект ГРМ", exact: true });
    await limitedDialog.getByRole("region", { name: "Взаимозаменяемые товары" }).getByRole("button", { name: "Комплект-замена", exact: true }).click();
    const linked = await claim("stock", 5);
    assert.deepEqual(linked.options.productCard, { id: related.id, testPlatform: false, view: "card" });
    assert.equal((await publishCard(linked, { ...related, productId: related.id }, { brand: related.brand })).status, 200);
    const relatedDialog = page.getByRole("dialog", { name: "Комплект-замена", exact: true });
    await relatedDialog.getByText("Рекомендованная закупка").waitFor();
    assert.doesNotMatch(await relatedDialog.innerText(), /Закрытый бренд|PRIVATE-REPLACEMENT/);
    await relatedDialog.getByRole("button", { name: "Закрыть", exact: true }).click();
    await claim("stock", 0, false, 12);
    const detailsUrl = cardUrl(restrictedId, branded.productId) + "&details=1";
    assert.equal((await fetch(detailsUrl, { headers: { Cookie: other } })).status, 404);
    const productDetailsResponse = page.request.get(detailsUrl);
    const productDetailsJob = await claim("stock", 5, false, 12);
    assert.deepEqual(productDetailsJob.options.productCard, { id: branded.productId, testPlatform: false, view: "details" });
    const { image, incoming, monthlySales, average, recommendation } = productCardFixture(branded);
    assert.equal((await post("/api/integration/1c/nomenclature/stock-results", {
      requestId: productDetailsJob.id, leaseId: productDetailsJob.leaseId, status: "completed", hasMore: false, products: [],
      productCard: { id: branded.productId, view: "details", data: { image, incoming, monthlySales, average, recommendation } },
    }, nomenclatureHeader)).status, 200);
    const restrictedDetails = await (await productDetailsResponse).json();
    assert.equal(restrictedDetails.image, null);
    assert.equal(restrictedDetails.recommendation, recommendation);

    const receipt = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith(`/refresh/${restrictedId}/incoming`));
    await dialog.getByRole("button", { name: /Поставки оригинала/ }).click();
    const supplyJob = await claim("stock", 5);
    assert.equal((await post("/api/integration/1c/nomenclature/stock-results", {
      requestId: supplyJob.id, leaseId: supplyJob.leaseId, status: "completed", products: [], hasMore: false,
      incomingDetails: { orders: [{ orderId: randomUUID(), productId: branded.productId,
        supplier: "Тестовый поставщик", number: "002", name: "Комплект ГРМ | Закрытый бренд", article: branded.article,
        ordered: 3, quantity: 2, expectedDate: "2026-11-19" }], hasMore: false },
    }, nomenclatureHeader)).status, 200);
    const supply = (await (await receipt).json()).orders[0];
    assert.equal(supply.name, "Комплект ГРМ");
    assert.equal(supply.article, "");
    assert.equal(supply.expectedDate, "2026-11-19");
    const popover = dialog.locator("#repair-order-incoming");
    await popover.getByText(/Тестовый поставщик/).waitFor();
    assert.doesNotMatch(await popover.innerText(), /Закрытый бренд|PRIVATE-ARTICLE/);

    assert.equal((await adminEdit("/api/users/positions", { ...position, hideArticle: false })).status, 200);
    const brandOnly = await rawSnapshot();
    assert.equal(brandOnly.hideArticles, undefined);
    assert.equal(brandOnly.goods[0].article, branded.article);
    assert.equal(brandOnly.goods[0].name, "Комплект ГРМ");
    assert.equal((await assign(null)).status, 200);
    const unrestricted = await rawSnapshot();
    assert.equal(unrestricted.goods[0].name, branded.name);
    assert.equal(unrestricted.goods[0].article, branded.article);

    // Revoking nomenclature access blocks even a product request already waiting on 1C.
    const pendingProduct = page.request.get(detailsUrl).catch((error) => error);
    const pendingProductJob = await claim("stock", 5, false, 12);
    assert.ok(pendingProductJob, "the authorized request reaches the worker");
    assert.equal((await adminEdit("/api/users", { id: employee.id, fio: employee.fio, permissions: ["repairs"] })).status, 200);
    assert.equal((await post("/api/integration/1c/nomenclature/stock-results", {
      requestId: pendingProductJob.id, leaseId: pendingProductJob.leaseId, status: "completed", hasMore: false, products: [],
      productCard: { id: branded.productId, view: "details", data: { image, incoming, monthlySales, average, recommendation } },
    }, nomenclatureHeader)).status, 200);
    assert.equal((await pendingProduct).status(), 403);
    for (const url of [cardUrl(restrictedId, branded.productId), detailsUrl,
      cardUrl(restrictedId, related.id) + "&grant=" + signedRelated.cardProof,
      `${origin}/api/nomenclature/products/${branded.productId}`]) {
      assert.equal((await page.request.get(url)).status(), 403);
    }
    assert.equal(await claim("stock", 0), null, "denied card requests do not create 1C jobs");

    await page.reload();
    await page.waitForLoadState("networkidle");
    assert.equal(await page.locator("#nomenclature-function-tab").isVisible(), false);
    const deniedCardDetails = { ...branded, stockDetails: { original: 5, replacements: [{ ...stockDetails.replacements[0], id: related.id }] } };
    await open({ ...details, goods: [deniedCardDetails] }, card);
    assert.equal(await goodsTable.getByRole("rowheader", { name: branded.name, exact: true }).isVisible(), true);
    assert.equal(await goodsTable.locator(".product-card-link").count(), 0);
    await goodsTable.getByRole("button", { name: /Остаток 20/ }).click();
    await popover.getByRole("region", { name: "Замена" }).getByText(related.name).waitFor();
    assert.equal(await popover.locator(".product-card-link").count(), 0);
    await popover.getByRole("button", { name: "Закрыть расшифровку остатка" }).click();

    const deniedSupply = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith("/incoming"));
    await dialog.getByRole("button", { name: /Поставки замен/ }).click();
    const deniedSupplyJob = await claim("stock", 5);
    assert.equal((await post("/api/integration/1c/nomenclature/stock-results", {
      requestId: deniedSupplyJob.id, leaseId: deniedSupplyJob.leaseId, status: "completed", products: [], hasMore: false,
      incomingDetails: { orders: [{ orderId: randomUUID(), productId: related.id,
        supplier: "Тестовый поставщик", number: "003", name: related.name, article: related.article,
        ordered: 3, quantity: 2, expectedDate: "2026-11-19" }], hasMore: false },
    }, nomenclatureHeader)).status, 200);
    assert.equal((await (await deniedSupply).json()).orders[0].cardProof, undefined);
    await popover.getByRole("listitem").getByText(related.name).waitFor();
    assert.equal(await popover.locator(".product-card-link").count(), 0);
    assert.deepEqual(pageErrors, []);
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
