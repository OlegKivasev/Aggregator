import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { NomenclatureService } from "../src/backend/nomenclature/nomenclature-service.ts";
import { parseStockOptions } from "../src/backend/nomenclature/stock-options.ts";
import { parseStockNavigation } from "../src/backend/nomenclature/stock-navigation.ts";
import { parseStockQuery, parseStockResult } from "../src/backend/nomenclature/stock-contract.ts";

const sort = { field: "id", direction: "asc" };
const options = (values = {}) => parseStockOptions("all", null, new URLSearchParams({ searchMode: "text", ...values }));
const navigation = { categories: [{ id: randomUUID(), name: "Фильтры", parentId: null, isFolder: true }], groups: [], oemBrands: [{ id: randomUUID(), name: "Toyota" }] };
const poll = (service, token, version = 6) => service.claim(token, ...[1, 2, 3, 4, 5, 6].map((minimum) => version >= minimum));
const result = (job, extra = {}) => ({ requestId: job.id, leaseId: job.leaseId, status: "completed", hasMore: false, products: [], totalCount: 0, priceTypes: [], ...extra });
async function fixture(check, version = 6) {
  const directory = await mkdtemp(join(tmpdir(), "nomenclature-navigation-"));
  const service = new NomenclatureService(join(directory, "database.sqlite"));
  const token = service.rotateKey();
  try { poll(service, token, version); await check(service, token); }
  finally { service.close(); await rm(directory, { recursive: true, force: true }); }
}
test("navigation validates bounded trees, duplicate identities, cycles and unsafe labels", () => {
  assert.deepEqual(parseStockNavigation(navigation), navigation);
  const root = navigation.categories[0]; const child = { ...root, id: randomUUID(), parentId: root.id };
  for (const categories of [[root, root], [{ ...root, parentId: root.id }], [{ ...root, parentId: child.id }, child], [{ ...root, name: "Фильтр\n" }], Array(5001).fill(root)]) {
    assert.throws(() => parseStockNavigation({ ...navigation, categories }));
  }
  assert.equal(parseStockQuery("Тормозная жидкость", true), "тормозная жидкость", "preserve multiword synonym order");
  assert.equal(parseStockQuery("L30914-248", true), "l30914-248");
  for (const values of [{ searchMode: "sql" }, { category: "none" }, { oemBrand: randomUUID() }, { navigation: "true" }]) assert.throws(() => options(values));
});
test("advanced searches require version six and keep category, group and OEM-brand jobs separate", async () => fixture(async (service, token) => {
  const category = navigation.categories[0].id; const group = randomUUID(); const oemBrand = navigation.oemBrands[0].id;
  const selections = [options({ category }), options({ group }), options({ searchMode: "oem", oemBrand }), options({ searchMode: "oem" })];
  const reads = selections.map((selection) => service.loadStock(null, new AbortController().signal, "l30914-248", sort, selection));
  assert.equal(poll(service, token, 5), null, "older worker must not consume the new filters");
  const jobs = selections.map(() => poll(service, token));
  assert.deepEqual(new Set(jobs.map((job) => JSON.stringify(job.options))), new Set(selections.map((selection) => JSON.stringify(selection))));
  for (const job of jobs) service.completeStock(token, parseStockResult(result(job), true));
  await Promise.all(reads);
}));
test("an online v5 worker rejects navigation immediately, then a v6 poll enables it", async () => fixture(async (service, token) => {
  await assert.rejects(async () => service.loadStock(null, new AbortController().signal, "", sort, options()), { code: "stock_unsupported" });
  assert.equal(poll(service, token, 5), null);
  poll(service, token);
  const read = service.loadStock(null, new AbortController().signal, "", sort, options());
  const job = poll(service, token); service.completeStock(token, result(job)); await read;
}, 5));
test("navigation cursors retain the selection and reject changed trees or continuation metadata", async () => fixture(async (service, token) => {
  const selection = options({ category: navigation.categories[0].id, navigation: "1" });
  const read = service.loadStock(null, new AbortController().signal, "фильтр", sort, selection);
  const job = poll(service, token);
  const products = Array.from({ length: 100 }, () => ({ id: randomUUID(), name: "Фильтр", article: "L309-14-248", quantity: 1 }));
  service.completeStock(token, result(job, { products, hasMore: true, totalCount: 101, navigation }));
  const page = await read;
  for (const wrong of [options({ navigation: "1" }), options({ category: selection.category, navigation: "0" }), options({ group: randomUUID(), navigation: "1" })]) {
    await assert.rejects(async () => service.loadStock(page.nextCursor, new AbortController().signal, "фильтр", sort, wrong), { code: "invalid_stock_sort" });
  }
  const more = service.loadStock(page.nextCursor, new AbortController().signal, "фильтр", sort, selection);
  const next = poll(service, token);
  assert.throws(() => service.completeStock(token, result(next, { totalCount: undefined, priceTypes: undefined, navigation })), /отбору/);
  service.completeStock(token, result(next, { totalCount: undefined, priceTypes: undefined }));
  assert.equal((await more).navigation, undefined);
}));
test("100 simultaneous readers share the navigation request and refresh reads it again", async () => fixture(async (service, token) => {
  const selection = options({ navigation: "1" }); const started = performance.now();
  const reads = Array.from({ length: 100 }, () => service.loadStock(null, new AbortController().signal, "", sort, selection));
  const job = poll(service, token); assert.equal(poll(service, token), null);
  assert.throws(() => service.completeStock(token, result(job)), /отбору/);
  service.completeStock(token, parseStockResult(result(job, { navigation }), true));
  for (const page of await Promise.all(reads)) assert.deepEqual(page.navigation, navigation);
  const refresh = service.loadStock(null, new AbortController().signal, "", sort, selection);
  const next = poll(service, token); assert.notEqual(next.id, job.id);
  service.completeStock(token, parseStockResult(result(next, { navigation }), true)); await refresh;
  console.log(`Navigation: 100 concurrent readers, one shared worker job; refresh one fresh job; ${(performance.now() - started).toFixed(1)} ms locally.`);
}));
