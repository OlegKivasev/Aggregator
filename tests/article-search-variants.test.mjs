import assert from "node:assert/strict";
import { test } from "node:test";
import { additionalArticleVariants } from "../src/backend/article-search-variants.ts";
import { SearchApplicationService } from "../src/backend/application/search-application-service.ts";
import { SupplierSessionManager } from "../src/backend/session/session-manager.ts";
import { SupplierAuthError, SupplierIntegrationError } from "../src/backend/suppliers/errors.ts";
import { attachPurchaseReference, getPurchaseReference } from "../src/backend/purchasing/purchase-offer.ts";
import { articleVariantNotice, readArticleVariants } from "../src/frontend/article-search-notice.js";

// Fictional supplier offers; these tests make no external requests.
const offer = (article, provider = "101") => attachPurchaseReference({ supplier: "part-kom", brand: "TEST", article,
  title: "Тестовый замок двери", price: 100, quantity: 4, warehouse: "Тестовый склад", deliveryDate: null,
  deliveryDateApproximate: false, link: "https://www.part-kom.ru/" }, { supplier: "part-kom", makerId: "202", providerId: provider });

const setup = (search, timeoutMs = 1000) => {
  const sessions = new SupplierSessionManager();
  sessions.markAuthorized("part-kom");
  const adapter = { id: "part-kom", displayName: "PartKOM", timeoutMs, ensureSession: async () => sessions.getSession("part-kom"), search };
  return new SearchApplicationService([adapter], sessions, () => sessions.markUnauthorized("part-kom"));
};

test("VAZ article search variants add or remove only the model index's terminal zero in either direction", () => {
  for (const [article, expected, form] of [
    ["21090-6205012-10", "2109-6205012-10", "short"], ["2109-6205012-10", "21090-6205012-10", "full"],
    ["21090620501210", "2109-6205012-10", "short"], ["2109620501210", "21090-6205012-10", "full"],
    ["21100-1234567", "2110-1234567", "short"], ["2110-1234567", "21100-1234567", "full"],
    ["11180.1234567.00", "1118-1234567-00", "short"], [" 2121 1234567 01 ", "21210-1234567-01", "full"],
    ["210906205012", "2109-6205012", "short"], ["21096205012", "21090-6205012", "full"],
  ]) assert.deepEqual(additionalArticleVariants(article), [{ article: expected, form }], article);
  for (const article of ["21093-6205012-10", "21214-1234567", "11194-1234567-10", "21213-1234567-01",
    "21093-6205012-1", "21090-6205012-0", "2109-6205012-101", "2109-620501-10", "1234-6205012-10",
    "3163-6205012-10", "B2109-6205012-10", "2109/6205012/10", "A1", "", "2109-12345678"]) {
    assert.deepEqual(additionalArticleVariants(article), [], article);
  }
});

test("search queries both article forms even when the first succeeds, preserves offers and emits one lifecycle", async () => {
  for (const original of ["2109-6205012-10", "21090-6205012-10"]) {
    const calls = [];
    const results = [];
    const service = setup(async (query, _context, onResult) => {
      calls.push(query.article);
      const result = offer(query.article, calls.length === 1 ? "101" : "102");
      results.push(result); onResult(result);
    });
    const events = [];
    await service.streamSearch({ article: original }, (event) => events.push(event), new AbortController().signal);
    assert.deepEqual(calls, [original, additionalArticleVariants(original)[0].article]);
    assert.deepEqual(events[0].articleVariants, additionalArticleVariants(original));
    assert.deepEqual(events.filter((event) => event.type === "result").map((event) => event.result), results);
    assert.deepEqual(getPurchaseReference(events.find((event) => event.type === "result").result), { supplier: "part-kom", makerId: "202", providerId: "101" });
    assert.deepEqual(events.filter((event) => event.type === "supplier_status").map((event) => event.status), ["searching", "completed"]);
    assert.equal(events.filter((event) => event.type === "search_started").length, 1);
    assert.equal(events.filter((event) => event.type === "search_completed").length, 1);
  }
});

test("cross-query duplicates are removed while different order references and stock remain distinct", async () => {
  const service = setup(async (query, _context, onResult) => {
    onResult(offer(query.article, "101"));
    onResult(offer(query.article, "102"));
    const differentStock = offer(query.article, "101"); differentStock.quantity = 3; onResult(differentStock);
  });
  const events = [];
  await service.streamSearch({ article: "2109-6205012-10" }, (event) => events.push(event), new AbortController().signal);
  assert.equal(events.filter((event) => event.type === "result").length, 3);
});

test("variant search preserves partial results and reports failure rather than an incomplete success", async () => {
  for (const invalidData of [false, true]) {
    const calls = [];
    const service = setup(async (query, _context, onResult) => {
      calls.push(query.article);
      if (query.article === "2109-6205012-10") onResult(offer(query.article));
      else if (invalidData) onResult({ ...offer(query.article), price: Number.NaN });
      else throw new SupplierIntegrationError("private upstream detail");
    });
    const events = [];
    await service.streamSearch({ article: "2109-6205012-10" }, (event) => events.push(event), new AbortController().signal);
    assert.equal(calls.length, 2);
    assert.equal(events.filter((event) => event.type === "result").length, 1);
    assert.equal(events.filter((event) => event.type === "supplier_status").at(-1).status, "error");
    assert.doesNotMatch(JSON.stringify(events), /private upstream/);
  }
  const calls = [];
  const service = setup(async (query, _context, onResult) => {
    calls.push(query.article);
    if (calls.length === 1) throw new SupplierIntegrationError("first spelling rejected");
    onResult(offer(query.article));
  });
  const events = [];
  await service.streamSearch({ article: "2109-6205012-10" }, (event) => events.push(event), new AbortController().signal);
  assert.equal(calls.length, 2);
  assert.equal(events.filter((event) => event.type === "result").length, 1);
  assert.equal(events.filter((event) => event.type === "supplier_status").at(-1).status, "error");
});

test("abort, auth failure and the shared timeout prevent a second query and late results", async () => {
  for (const failure of ["abort", "auth", "timeout"]) {
    const controller = new AbortController();
    let calls = 0;
    const service = setup(async (_query, context, onResult) => {
      calls++;
      if (failure === "abort") controller.abort(new Error("cancelled"));
      if (failure === "auth") throw new SupplierAuthError("secret authorization detail");
      if (failure === "timeout") await new Promise((resolve) => context.signal.addEventListener("abort", resolve, { once: true }));
      onResult(offer("2109-6205012-10"));
    }, failure === "timeout" ? 20 : 1000);
    const events = [];
    await service.streamSearch({ article: "2109-6205012-10" }, (event) => events.push(event), controller.signal);
    assert.equal(calls, 1);
    assert.equal(events.filter((event) => event.type === "result").length, 0);
    if (failure !== "abort") assert.equal(events.filter((event) => event.type === "supplier_status").at(-1).status, failure === "auth" ? "auth_error" : "timeout");
  }
});

test("ordinary articles and selected analog or brand searches keep their existing query count", async () => {
  const calls = [];
  const service = setup(async (query) => calls.push(query.article));
  for (const article of ["A1", "21093-6205012-10"]) {
    const events = [];
    await service.streamSearch({ article }, (event) => events.push(event), new AbortController().signal);
    assert.equal(events[0].articleVariants, undefined);
  }
  assert.deepEqual(calls, ["A1", "21093-6205012-10"]);
  for (const mode of ["brands", "analogs"]) {
    const events = [];
    await service.streamSearch({ mode, article: "2109-6205012-10", brand: "TEST" }, (event) => events.push(event), new AbortController().signal);
    assert.equal(events[0].articleVariants, undefined);
    assert.deepEqual(events[0].suppliers, []);
  }
});

test("variant notice validates cached or streamed values and describes both directions", () => {
  assert.match(articleVariantNotice(additionalArticleVariants("2109-6205012-10")), /полному.*21090-6205012-10/);
  assert.match(articleVariantNotice(additionalArticleVariants("21090-6205012-10")), /сокращённому.*2109-6205012-10/);
  for (const value of [null, {}, [], [null], [{ form: "other", article: "A1" }], [{ form: "short", article: "\n" }],
    [{ form: "full", article: "x".repeat(129) }], [{ form: "full", article: "A1" }, { form: "short", article: "A1" }]]) {
    assert.deepEqual(readArticleVariants(value), []);
    assert.equal(articleVariantNotice(value), "");
  }
});
