import assert from "node:assert/strict";
import { test } from "node:test";
import { additionalArticleVariants } from "../src/backend/article-search-variants.ts";
import { SearchApplicationService } from "../src/backend/application/search-application-service.ts";
import { SupplierSessionManager } from "../src/backend/session/session-manager.ts";
import { SupplierAuthError, SupplierIntegrationError } from "../src/backend/suppliers/errors.ts";
import { attachPurchaseReference, getPurchaseReference, samePurchaseArticle } from "../src/backend/purchasing/purchase-offer.ts";
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

test("VAZ article search variants preserve nonzero suffixes and reject unsupported article formats", () => {
  for (const [article, expected, form] of [
    ["21090-6205012-10", "2109-6205012-10", "short"], ["2109-6205012-10", "21090-6205012-10", "full"],
    ["21090620501210", "2109-6205012-10", "short"], ["2109620501210", "21090-6205012-10", "full"],
    [" 2121 1234567 01 ", "21210-1234567-01", "full"],
  ]) assert.deepEqual(additionalArticleVariants(article), [{ article: expected, form }], article);
  for (const article of ["21093-6205012-10", "11194-1234567-10", "21213-1234567-01",
    "21093-6205012-1", "21090-6205012-0", "2109-6205012-101", "2109-620501-10", "1234-6205012-10",
    "3163-6205012-10", "B2109-6205012-10", "2109/6205012/10", "A1", "", "2109-12345678"]) {
    assert.deepEqual(additionalArticleVariants(article), [], article);
  }
});

const zeroSuffixArticles = ["1119-2902712", "11190-2902712", "1119-2902712-00", "11190-2902712-00"];

test("VAZ article search includes exactly four spellings for missing and zero suffixes", () => {
  const [short, full, shortWithSuffix, fullWithSuffix] = zeroSuffixArticles;
  for (const [inputs, expected] of [
    [[short, "11192902712"], [full, shortWithSuffix, fullWithSuffix]],
    [[full, "111902902712"], [short, fullWithSuffix, shortWithSuffix]],
    [[shortWithSuffix, " 1119 2902712 00 "], [fullWithSuffix, short, full]],
    [[fullWithSuffix, "11190.2902712.00", "11190290271200"], [shortWithSuffix, full, short]],
  ]) {
    for (const input of inputs) assert.deepEqual(additionalArticleVariants(input), expected.map((article) => ({
      article, form: article.startsWith("11190-") ? "full" : "short",
    })), input);
  }
  assert.deepEqual(additionalArticleVariants("21100-1234567").map(({ article }) => article),
    ["2110-1234567", "21100-1234567-00", "2110-1234567-00"]);
});

const unexpandedArticles = [
  "8450031032",
  "1119-290271",
  "1119-29027123",
  "11190-290271-00",
  "11190-29027123-00",
  "11196-2902712-01",
  "11196-290271",
  "11196-29027123",
];

test("a five-digit VAZ model ending in a nonzero digit expands only the zero suffix", () => {
  for (const article of ["11196-2902712", "111962902712"]) {
    assert.deepEqual(additionalArticleVariants(article), [{ article: "11196-2902712-00", form: "full" }]);
  }
  for (const article of ["11196-2902712-00", "11196290271200", "11196.2902712.00"]) {
    assert.deepEqual(additionalArticleVariants(article), [{ article: "11196-2902712", form: "full" }]);
  }
  assert.deepEqual(additionalArticleVariants("21214-1234567"), [{ article: "21214-1234567-00", form: "full" }]);
});

test("search queries all applicable article forms even when the first succeeds and emits one lifecycle", async () => {
  for (const [original, expected] of [
    ["2109-6205012-10", ["2109-6205012-10", "21090-6205012-10"]],
    ["21090-6205012-10", ["21090-6205012-10", "2109-6205012-10"]],
    ["1119-2902712", zeroSuffixArticles],
    ["11190-2902712-00", ["11190-2902712-00", "1119-2902712-00", "11190-2902712", "1119-2902712"]],
    ["11196-2902712", ["11196-2902712", "11196-2902712-00"]],
    ["11196-2902712-00", ["11196-2902712-00", "11196-2902712"]],
  ]) {
    const calls = [];
    const results = [];
    let activeCalls = 0;
    const service = setup(async (query, _context, onResult) => {
      assert.equal(++activeCalls, 1, "one spelling at a time per supplier");
      calls.push(query.article);
      await Promise.resolve();
      const result = offer(query.article, String(100 + calls.length));
      results.push(result);
      onResult(result);
      activeCalls--;
    });
    const events = [];
    await service.streamSearch({ article: original }, (event) => events.push(event), new AbortController().signal);
    assert.deepEqual(calls, expected);
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
    onResult(offer("11196-2902712-00", "101"));
  });
  const events = [];
  await service.streamSearch({ article: "1119-2902712" }, (event) => events.push(event), new AbortController().signal);
  assert.deepEqual(events.filter((event) => event.type === "result").map((event) => event.result.article),
    ["1119-2902712", "1119-2902712", "1119-2902712", "11196-2902712-00"]);
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
  const service = setup(async (query, _context, onResult) => {
    calls.push(query.article);
    onResult(offer(query.article));
  });
  const originals = ["A1", "21093-6205012-10", ...unexpandedArticles];
  for (const article of originals) {
    const events = [];
    await service.streamSearch({ article }, (event) => events.push(event), new AbortController().signal);
    assert.equal(events[0].articleVariants, undefined);
    assert.deepEqual(events.filter((event) => event.type === "result").map((event) => event.result.article), [article]);
  }
  assert.deepEqual(calls, originals);
  for (const mode of ["brands", "analogs"]) {
    const events = [];
    await service.streamSearch({ mode, article: "1119-2902712", brand: "TEST" }, (event) => events.push(event), new AbortController().signal);
    assert.equal(events[0].articleVariants, undefined);
    assert.deepEqual(events[0].suppliers, []);
  }
});

test("variant notice validates cached or streamed values and lists the additional articles", () => {
  assert.equal(articleVariantNotice(additionalArticleVariants("2109-6205012-10")), "Также ищем по артикулу 21090-6205012-10.");
  assert.equal(articleVariantNotice(additionalArticleVariants("21090-6205012-10")), "Также ищем по артикулу 2109-6205012-10.");
  assert.equal(articleVariantNotice(additionalArticleVariants("11196-2902712")), "Также ищем по артикулу 11196-2902712-00.");
  const variants = additionalArticleVariants("1119-2902712");
  assert.deepEqual(readArticleVariants(variants), variants);
  assert.equal(articleVariantNotice(variants), "Также ищем по артикулам 11190-2902712, 1119-2902712-00, 11190-2902712-00.");
  for (const value of [null, {}, [], [null], [...variants, variants[0]], [...variants.slice(0, 2), null],
    [{ form: "other", article: "A1" }], [{ form: "short", article: "\n" }],
    [{ form: "full", article: "x".repeat(129) }], [{ form: "full", article: "A1" }, { form: "short", article: "A1" }]]) {
    assert.deepEqual(readArticleVariants(value), []);
    assert.equal(articleVariantNotice(value), "");
  }
});

test("offer refresh preserves the stored suffix and purchase matching stays strict", async () => {
  const calls = [];
  const service = setup(async (query) => calls.push(query.article));
  for (const original of ["1119-2902712", "1119-2902712-00"]) {
    const events = [];
    await service.streamSearch({ article: original, preserveArticleSuffix: true },
      (event) => events.push(event), new AbortController().signal);
    assert.equal(events[0].articleVariants.length, 1);
  }
  const events = [];
  await service.streamSearch({ article: "11196-2902712", preserveArticleSuffix: true },
    (event) => events.push(event), new AbortController().signal);
  assert.equal(events[0].articleVariants, undefined);
  assert.deepEqual(calls, [...zeroSuffixArticles, "11196-2902712"]);
  assert.equal(samePurchaseArticle("1119-2902712", "11190-2902712"), true);
  assert.equal(samePurchaseArticle("1119-2902712-00", "11190-2902712-00"), true);
  assert.equal(samePurchaseArticle("1119-2902712", "11190-2902712-00"), false);
  assert.equal(samePurchaseArticle("1119-2902712-00", "11190-2902712"), false);
  assert.equal(samePurchaseArticle("11196-2902712", "11196-2902712-00"), false);
  assert.equal(samePurchaseArticle("11196-2902712-00", "11190-2902712-00"), false);
});
