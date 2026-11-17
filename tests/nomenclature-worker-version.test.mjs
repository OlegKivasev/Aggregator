import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { NomenclatureService } from "../src/backend/nomenclature/nomenclature-service.ts";

const options = { availability: "available", priceType: null };
const sort = { field: "id", direction: "asc" };
const poll = (service, token, version) => service.claim(token, ...[1, 2, 3, 4, 5].map((minimum) => version >= minimum));
const unsupported = (error) => error.statusCode === 503 && error.code === "stock_unsupported" && /Обновите расширение/.test(error.message);
async function fixture(check) {
  const directory = await mkdtemp(join(tmpdir(), "nomenclature-worker-version-"));
  const path = join(directory, "stock.sqlite");
  let now = Date.now();
  const service = new NomenclatureService(path, () => now);
  const token = service.rotateKey(); service.heartbeat(token);
  try { await check({ service, token, path, advance: (ms) => { now += ms; } }); }
  finally { service.close(); await rm(directory, { recursive: true, force: true }); }
}

test("an online barcode-only worker rejects filtered stock immediately without filling the queue", async () => {
  await fixture(async ({ service, token, path }) => {
    poll(service, token, 0);
    assert.equal(service.state().online, true);
    const abort = new AbortController();
    const started = performance.now();
    try {
      const read = Promise.resolve().then(() => service.loadStock(null, abort.signal, "", sort, options));
      const outcome = await Promise.race([read.then(() => "completed", (error) => error), new Promise((done) => setTimeout(() => done("waiting"), 100))]);
      assert.ok(unsupported(outcome), `Expected incompatibility, got ${String(outcome)}`);
      for (let index = 0; index < 100; index += 1) {
        await assert.rejects(async () => service.loadStock(null, abort.signal, "", sort, options), unsupported);
      }
    } finally { abort.abort(); }
    const database = new DatabaseSync(path);
    try { assert.equal(database.prepare("SELECT COUNT(*) AS count FROM nomenclature_stock_requests").get().count, 0); }
    finally { database.close(); }
    console.log(`Incompatible worker: 101 reads rejected in ${(performance.now() - started).toFixed(1)} ms; 0 queued jobs (previously a 30-second timeout).`);
    const lookup = service.create("000123", "employee");
    assert.equal(poll(service, token, 0).id, lookup.id, "barcode search remains available");
  });
});

test("the first worker poll releases a browser already waiting after server restart", async () => {
  await fixture(async ({ service, token, path }) => {
    const abort = new AbortController();
    const read = service.loadStock(null, abort.signal, "", sort, options);
    const rejected = assert.rejects(read, unsupported);
    try {
      assert.equal(poll(service, token, 0), null);
      await Promise.race([rejected, new Promise((_, reject) => setTimeout(() => reject(new Error("Browser still waiting for an incompatible worker")), 100))]);
    } finally { abort.abort(); }
    const database = new DatabaseSync(path);
    try { assert.equal(database.prepare("SELECT COUNT(*) AS count FROM nomenclature_stock_requests WHERE status IN ('pending','leased')").get().count, 0); }
    finally { database.close(); }
    poll(service, token, 5);
    const retry = service.loadStock(null, new AbortController().signal, "", sort, options);
    const job = poll(service, token, 5);
    service.completeStock(token, { requestId: job.id, leaseId: job.leaseId, status: "completed", products: [], hasMore: false, totalCount: 0, priceTypes: [] });
    assert.equal((await retry).totalCount, 0, "refresh succeeds after an updated worker connects");
  });
});

test("capability gates preserve legacy reads, handle mixed workers and expire old capabilities", async () => {
  await fixture(async ({ service, token, advance }) => {
    for (let version = 1; version <= 4; version += 1) {
      poll(service, token, version);
      await assert.rejects(async () => service.loadStock(null, new AbortController().signal, "", sort, options), unsupported);
      const read = service.loadStock(null, new AbortController().signal);
      const job = poll(service, token, version);
      service.completeStock(token, { requestId: job.id, leaseId: job.leaseId, status: "completed", products: [], hasMore: false });
      await read;
    }
    poll(service, token, 5); poll(service, token, 0);
    assert.equal(service.stockVersion(), 5);
    const read = service.loadStock(null, new AbortController().signal, "", sort, options);
    assert.equal(poll(service, token, 0), null);
    const job = poll(service, token, 5);
    service.completeStock(token, { requestId: job.id, leaseId: job.leaseId, status: "completed", products: [], hasMore: false, totalCount: 0, priceTypes: [] });
    await read;
    advance(90_000); poll(service, token, 0);
    assert.equal(service.stockVersion(), 0);
    await assert.rejects(async () => service.loadStock(null, new AbortController().signal, "", sort, options), unsupported);
    const replacement = service.rotateKey();
    assert.equal(service.stockVersion(), null);
    assert.throws(() => poll(service, token, 5), (error) => error.statusCode === 401);
    poll(service, replacement, 0);
    assert.equal(service.stockVersion(), 0, "revoked workers cannot advertise capabilities");
  });
});

test("capability expiry wakes pending browsers even when a status read noticed it first", async () => {
  await fixture(async ({ service, token, advance }) => {
    poll(service, token, 5);
    advance(89_000); poll(service, token, 0);
    const abort = new AbortController();
    const read = service.loadStock(null, abort.signal, "", sort, options);
    const rejected = assert.rejects(read, unsupported);
    try {
      advance(1_000);
      assert.equal(service.stockVersion(), 0);
      poll(service, token, 0);
      await Promise.race([rejected, new Promise((_, reject) => setTimeout(() => reject(new Error("Capability expiry did not wake browser")), 100))]);
    } finally { abort.abort(); }
  });
});
