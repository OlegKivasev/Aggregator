import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { CartApplicationService } from "../src/backend/purchasing/cart-application-service.ts";
import { SqliteCartRepository } from "../src/backend/purchasing/sqlite-cart-repository.ts";
import { attachPurchaseReference } from "../src/backend/purchasing/purchase-offer.ts";
import { createAggregatorServer } from "../src/backend/http/create-server.ts";

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const tab = (n, itemIds = [], excludeFromAll = false) => ({ id: `custom-${id(n)}`, name: `Вкладка ${n}`, excludeFromAll, itemIds });
const withCart = async (check) => {
  const directory = mkdtempSync(join(tmpdir(), "shared-cart-tabs-"));
  const path = join(directory, "cart.sqlite");
  let cart = new CartApplicationService(new SqliteCartRepository(path), async () => []);
  try {
    const offer = attachPurchaseReference({ supplier: "armtek", brand: "TEST", article: "A1", title: "Тестовая деталь",
      quantity: 5, price: 100, warehouse: null, deliveryDate: null, deliveryDateApproximate: false,
      link: "https://etp.armtek.ru/" }, { supplier: "armtek", keyzak: "TEST01" });
    cart.registerOffer(id(1), offer);
    cart.mutate("add", { revision: 0, offerId: id(1), quantity: 1 });
    await check(cart, () => { cart.close(); cart = new CartApplicationService(new SqliteCartRepository(path), async () => []); return cart; });
  } finally { cart.close(); rmSync(directory, { recursive: true, force: true }); }
};

test("shared cart tabs persist independently of cart revision and reject stale profile changes", async () => {
  await withCart((cart, reopen) => {
    const before = cart.view();
    const tabs = [tab(2, [before.items[0].id], true), tab(3)];
    assert.deepEqual(cart.tabs(), { revision: 0, tabs: [] });
    assert.deepEqual(cart.saveTabs({ revision: 0, tabs }), { revision: 1, tabs });
    assert.deepEqual(cart.view(), before);
    assert.throws(() => cart.saveTabs({ revision: 0, tabs: [] }), (error) => error.statusCode === 409);
    assert.deepEqual(reopen().tabs(), { revision: 1, tabs });
  });
});

test("legacy cart tabs merge once without replacing shared names, moving assigned goods or resurrecting closed tabs", async () => {
  await withCart((cart, reopen) => {
    const itemId = cart.view().items[0].id;
    const current = { ...tab(2, [itemId], true), name: "Общая версия" };
    cart.saveTabs({ revision: 0, tabs: [current] });
    const legacy = { version: 1, tabs: [tab(2), tab(3, [itemId, id(99)], true)] };
    const imported = cart.importTabs(legacy);
    assert.deepEqual(imported.tabs, [current, tab(3, [], true)]);
    assert.deepEqual(cart.importTabs(legacy), imported, "retries are idempotent");
    cart.saveTabs({ revision: imported.revision, tabs: [] });
    const restored = reopen();
    assert.deepEqual(restored.importTabs(legacy).tabs, [], "another old browser cannot restore a closed imported tab");
    assert.equal(restored.view().count, 1);
  });
});

test("shared cart tabs validate boundaries and discard memberships of removed goods while preserving empty tabs", async () => {
  await withCart((cart) => {
    const currentId = cart.view().items[0].id;
    const invalid = [null, {}, [null], [tab(2), tab(2)], [{ ...tab(2), id: "all" }],
      [{ ...tab(2), name: " " }], [{ ...tab(2), name: "x".repeat(101) }],
      [{ ...tab(2), excludeFromAll: "true" }], [tab(2, ["bad"])], [tab(2, [currentId, currentId])],
      [tab(2, [currentId]), tab(3, [currentId])], Array.from({ length: 101 }, (_, i) => tab(i))];
    for (const tabs of invalid) assert.throws(() => cart.saveTabs({ revision: 0, tabs }), (error) => error.statusCode === 400);
    for (const revision of [undefined, null, "0", -1, .5, Infinity, Number.MAX_SAFE_INTEGER]) {
      assert.throws(() => cart.saveTabs({ revision, tabs: [] }), (error) => error.statusCode === 400);
    }
    assert.deepEqual(cart.saveTabs({ revision: 0, tabs: [tab(2, [currentId, id(99)])] }).tabs, [tab(2, [currentId])]);
    cart.mutate("remove", { revision: cart.view().revision, id: currentId });
    assert.deepEqual(cart.tabs().tabs, [tab(2)]);
  });
});

test("legacy import hitting the shared tab limit leaves all shared data and import markers unchanged", async () => {
  await withCart((cart) => {
    const tabs = Array.from({ length: 100 }, (_, i) => tab(i + 2));
    const saved = cart.saveTabs({ revision: 0, tabs });
    const incoming = { version: 1, tabs: [tab(200), tab(201)] };
    assert.throws(() => cart.importTabs(incoming), (error) => error.statusCode === 409);
    assert.deepEqual(cart.tabs(), saved);
    cart.saveTabs({ revision: saved.revision, tabs: tabs.slice(2) });
    assert.deepEqual(cart.importTabs(incoming).tabs.slice(-2), incoming.tabs);
  });
});

test("shared cart tab HTTP endpoints validate requests, guard revisions and retain data across server restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "shared-cart-tabs-http-"));
  const previous = process.env.GARAGE_DB_PATH;
  process.env.GARAGE_DB_PATH = join(directory, "cart.sqlite");
  let server;
  const start = async () => {
    server = createAggregatorServer({ application: { streamSearch: async () => {} }, publicDir: resolve("src/frontend") });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}/api/cart/tabs`;
  };
  const stop = async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); };
  try {
    let url = await start();
    const send = (method, value, suffix = "") => fetch(url + suffix, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
    assert.deepEqual(await (await fetch(url)).json(), { revision: 0, tabs: [] });
    const saved = await send("PUT", { revision: 0, tabs: [tab(2)] });
    assert.equal(saved.status, 200);
    assert.equal(saved.headers.get("cache-control"), "no-store");
    assert.equal((await send("PUT", { revision: 0, tabs: [] })).status, 409);
    assert.equal((await send("PUT", null)).status, 400);
    assert.equal((await send("PUT", { revision: 1, tabs: [tab(2, ["invalid"])] })).status, 400);
    assert.equal((await send("POST", { version: 1, tabs: [tab(3)] }, "/import")).status, 200);
    assert.equal((await fetch(url, { method: "DELETE" })).status, 405);
    assert.equal((await fetch(url, { method: "PUT", body: "{" })).status, 400);
    assert.equal((await send("PUT", { large: "x".repeat(256 * 1024) })).status, 413);
    await stop();
    url = await start();
    assert.deepEqual((await (await fetch(url)).json()).tabs, [tab(2), tab(3)]);
  } finally {
    if (server?.listening) await stop();
    if (previous === undefined) delete process.env.GARAGE_DB_PATH; else process.env.GARAGE_DB_PATH = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});
