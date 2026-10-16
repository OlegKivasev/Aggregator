import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SqliteOrderCancellationRepository } from "../src/backend/purchasing/sqlite-order-cancellation-repository.ts";
import { OrderCancellationService, CancellationInputError } from "../src/backend/purchasing/order-cancellation-service.ts";
import { createAggregatorServer } from "../src/backend/http/create-server.ts";
import { SupplierAuthError } from "../src/backend/errors.ts";

const item = (fields = {}) => ({ article: "A1", brand: "TEST", title: "Тестовая деталь", quantity: 10, price: 100,
  status: null, fulfillment: "cancelled", expectedDate: "2026-10-20", guaranteedDate: null, warehouse: "Склад", ...fields });
const history = (items = [item()], number = "ORDER-FIXTURE") => ({ orders: [{ number, date: "2026-10-16", items }], limited: false });
const acknowledgement = (page) => ({ notices: page.notices.map(({ id, revision }) => ({ id, revision })) });
const store = (path = ":memory:") => new OrderCancellationService(new SqliteOrderCancellationRepository(path));

test("cancellations include existing full and partial cancellations from all supported histories without guessing from text", () => {
  const service = store();
  try {
    for (const supplier of ["part-kom", "armtek", "forum-auto", "rossko"]) service.observe(supplier, history());
    service.observe("part-kom", history([item({ fulfillment: "partially_cancelled", fulfillmentQuantities: { delivered: 4, cancelled: 6 } }),
      item({ article: "B1", fulfillment: "processing" })], "MIXED"));
    service.observe("armtek", history([item({ fulfillment: "partial", cancelledQuantity: 2 })], "PENDING"));
    for (const fulfillment of ["returned", "unknown", "partial", "processing", "delivered"]) {
      service.observe("rossko", history([item({ fulfillment, status: "Отменено 2 шт." })], fulfillment));
    }
    const page = service.unread();
    assert.equal(page.total, 6);
    assert.equal(new Set(page.notices.filter(({ order }) => order.number === "ORDER-FIXTURE").map(({ supplier }) => supplier)).size, 4);
    const mixed = page.notices.find(({ order }) => order.number === "MIXED").order;
    assert.equal(mixed.items.length, 1);
    assert.equal(mixed.items[0].quantity, 6);
    assert.equal(mixed.items[0].fulfillment, "cancelled");
    assert.equal(mixed.items[0].fulfillmentQuantities, undefined);
    assert.equal(mixed.items[0].price, 100);
    assert.equal(page.notices.find(({ order }) => order.number === "PENDING").order.items[0].quantity, 2);
  } finally { service.close(); }
});

test("seen cancellations do not reappear for reordered rows, changed descriptions or incomplete supplier responses", () => {
  const service = store();
  try {
    service.observe("part-kom", history([item({ quantity: 2, price: 100 }), item({ quantity: 3, price: 200 })]));
    service.acknowledge(acknowledgement(service.unread()));
    service.observe("part-kom", history([item({ quantity: 3, price: 210, title: "Новое описание", warehouse: "Новый склад" }), item({ quantity: 2 })]));
    service.observe("part-kom", history([item({ quantity: 2 })]));
    service.observe("part-kom", { orders: [], limited: true });
    assert.equal(service.unread().total, 0);
    service.observe("part-kom", history([item({ quantity: 6 })]));
    const page = service.unread();
    assert.equal(page.total, 1);
    assert.equal(page.notices[0].revision, 2);
    assert.equal(page.notices[0].order.items[0].quantity, 6);
  } finally { service.close(); }
});

test("acknowledging an older revision never hides a newer cancellation and future revisions are ignored", () => {
  const service = store();
  try {
    service.observe("armtek", history([item({ quantity: 10, fulfillment: "partial", cancelledQuantity: 2, positionId: "10" })]));
    const old = service.unread();
    service.observe("armtek", history([item({ quantity: 10, fulfillment: "partial", cancelledQuantity: 4, positionId: "10" })]));
    service.acknowledge(acknowledgement(old));
    const fresh = service.unread();
    assert.equal(fresh.total, 1);
    assert.equal(fresh.notices[0].id, old.notices[0].id);
    assert.equal(fresh.notices[0].revision, 2);
    assert.equal(fresh.notices[0].order.items[0].quantity, 4);
    service.acknowledge({ notices: [{ id: fresh.notices[0].id, revision: 999 }] });
    assert.equal(service.unread().total, 1);
    service.acknowledge(acknowledgement(fresh));
    service.acknowledge(acknowledgement(fresh));
    assert.equal(service.unread().total, 0);
  } finally { service.close(); }
});

test("cancellation snapshots and seen revisions survive reopening and are shared by separate connections", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aggregator-cancellations-"));
  const path = join(directory, "orders.sqlite");
  let first = store(path);
  let second;
  try {
    first.observe("rossko", history());
    const initial = first.unread();
    first.close(); first = store(path);
    assert.deepEqual(first.unread(), initial);
    second = store(path);
    second.acknowledge(acknowledgement(second.unread()));
    assert.equal(first.unread().total, 0);
    first.close(); first = store(path);
    first.observe("rossko", history());
    assert.equal(first.unread().total, 0);
  } finally { first.close(); second?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("only the displayed page is acknowledged when the inbox contains more than 100 orders", () => {
  const service = store();
  try {
    for (let index = 0; index < 101; index++) service.observe("rossko", history([item()], `ORDER-${index}`));
    const first = service.unread();
    assert.equal(first.total, 101);
    assert.equal(first.notices.length, 100);
    assert.equal(service.acknowledge(acknowledgement(first)).total, 1);
    service.acknowledge(acknowledgement(service.unread()));
    assert.equal(service.unread().total, 0);
  } finally { service.close(); }
});

test("invalid acknowledgements are rejected atomically and cannot clear unviewed cancellations", () => {
  const service = store();
  try {
    service.observe("part-kom", history());
    const [valid] = acknowledgement(service.unread()).notices;
    for (const value of [null, [], {}, { notices: [] }, { notices: [valid, valid] }, { notices: [valid, { id: "bad", revision: 1 }] },
      { notices: [{ ...valid, revision: 0 }] }, { notices: [{ ...valid, revision: 1.5 }] },
      { notices: [{ ...valid, revision: "1" }] }, { notices: Array(101).fill(valid) }]) {
      assert.throws(() => service.acknowledge(value), CancellationInputError);
      assert.equal(service.unread().total, 1);
    }
  } finally { service.close(); }
});

async function withServer(check, loadHistory = async () => history()) {
  const directory = await mkdtemp(join(tmpdir(), "aggregator-cancellation-http-"));
  const previous = process.env.GARAGE_DB_PATH;
  process.env.GARAGE_DB_PATH = join(directory, "orders.sqlite");
  const server = createAggregatorServer({ publicDir: resolve("src/frontend"), application: {
    streamSearch: async () => {}, partKomOrderHistory: (_archive, signal) => loadHistory(signal),
    supplierOrderHistory: (_query, signal) => loadHistory(signal),
  } });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    await check(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    if (previous === undefined) delete process.env.GARAGE_DB_PATH; else process.env.GARAGE_DB_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

test("history reads record cancellations and inbox HTTP routes validate methods, bodies and acknowledgements", async () => {
  await withServer(async (origin) => {
    assert.equal((await (await fetch(`${origin}/api/order-cancellations`)).json()).total, 0);
    assert.equal((await fetch(`${origin}/api/order-history/part-kom`)).status, 200);
    const response = await fetch(`${origin}/api/order-cancellations`);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const page = await response.json();
    assert.equal(page.total, 1);
    assert.equal((await fetch(`${origin}/api/order-cancellations/seen`)).status, 405);
    assert.equal((await fetch(`${origin}/api/order-cancellations?all=1`)).status, 400);
    for (const [body, status] of [["broken", 400], ["{}", 400], ["x".repeat(17000), 413]]) {
      const response = await fetch(`${origin}/api/order-cancellations/seen`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
      assert.equal(response.status, status);
      assert.equal((await (await fetch(`${origin}/api/order-cancellations`)).json()).total, 1);
    }
    const seen = await fetch(`${origin}/api/order-cancellations/seen`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(acknowledgement(page)) });
    assert.equal((await seen.json()).total, 0);
    await fetch(`${origin}/api/order-history/part-kom`);
    assert.equal((await (await fetch(`${origin}/api/order-cancellations`)).json()).total, 0);
  });
});

test("failed and aborted supplier reads do not discard saved cancellations or record late responses", async () => {
  let fail = false;
  await withServer(async (origin) => {
    await fetch(`${origin}/api/order-history/part-kom`);
    fail = true;
    assert.equal((await fetch(`${origin}/api/order-history/part-kom`)).status, 401);
    assert.equal((await (await fetch(`${origin}/api/order-cancellations`)).json()).total, 1);
  }, async () => { if (fail) throw new SupplierAuthError(); return history(); });
  let started, aborted, release;
  const ready = new Promise((resolve) => { started = resolve; });
  const disconnected = new Promise((resolve) => { aborted = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  await withServer(async (origin) => {
    const controller = new AbortController();
    const pending = fetch(`${origin}/api/order-history/part-kom`, { signal: controller.signal });
    await ready;
    controller.abort();
    await assert.rejects(pending);
    await disconnected;
    release();
    assert.equal((await (await fetch(`${origin}/api/order-cancellations`)).json()).total, 0);
  }, async (signal) => { signal.addEventListener("abort", aborted, { once: true }); started(); await gate; return history(); });
});
