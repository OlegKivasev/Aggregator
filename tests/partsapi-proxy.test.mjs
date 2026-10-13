import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, rmdirSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { EncryptedPartsApiProxyStore } from "../src/backend/applicability/encrypted-proxy-store.ts";
import { parsePartsApiProxyConfig, parsePartsApiProxyImport, PartsApiProxyValidationError } from "../src/backend/applicability/partsapi-proxy-config.ts";
import { PartsApiApplicabilityClient } from "../src/backend/applicability/partsapi-client.ts";
import { PartsApiRoutingClient } from "../src/backend/applicability/partsapi-routing-client.ts";
import { PartsApiIpLimitError, PartsApiKeyError } from "../src/backend/applicability/partsapi-key-error.ts";
import { SupplierIntegrationError, SupplierTimeoutError } from "../src/backend/errors.ts";

// Fictional credentials, no requests to real proxies or PartsAPI.
const config = { protocol: "http", host: "8.8.8.8", port: 8000, login: "fictional-proxy-user", password: " fictional-proxy-password " };
const secondConfig = { ...config, host: "9.9.9.9" };
const query = { sku: "TEST1", brand: "FORD", apiKey: "fictional-parts-key-ABCDE" };
const ipQuota = { error_code: 5000, message: "Exceeded the number of requests from the current IP address.", status: 401 };
const success = () => Response.json([{ carId: 1, carName: "Test", carType: "PC", makeName: "FORD", modelName: "Test", yearEnd: null, yearStart: null }]);
const limited = () => Response.json(ipQuota, { status: 401 });
const signal = () => new AbortController().signal;

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "partsapi-proxy-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "proxies.enc.json");
  const key = Buffer.alloc(32, 7);
  const store = new EncryptedPartsApiProxyStore(path, key);
  return { store, path, key };
}

test("proxy settings validate public IPv4, domain names, protocols, ports and credentials before connecting", () => {
  assert.deepEqual(parsePartsApiProxyConfig(config), config);
  const domain = { ...config, protocol: "https", host: "edge-8-8-8-8.proxy.example.org", port: 8443 };
  assert.deepEqual(parsePartsApiProxyConfig({ ...domain, host: domain.host.toUpperCase() }), domain);
  assert.deepEqual(parsePartsApiProxyConfig({ ...config, login: "", password: "" }), { ...config, login: "", password: "" });
  for (const host of ["localhost", "proxy.localhost", "proxy.internal", "https://proxy.example.org", "proxy.example.org:8443", "proxy..example.org", "-proxy.example.org", "proxy-.example.org", "proxy.example.org.", `${"a".repeat(64)}.example.org`, `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}.org`, "127.0.0.1", "0.0.0.0", "10.0.0.1", "172.16.1.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "198.18.0.1", "224.0.0.1", "255.255.255.255", "[::1]", "2130706433", "8.8.8.8@127.0.0.1", "8.8.8.8/path"]) {
    assert.throws(() => parsePartsApiProxyConfig({ ...config, host }), PartsApiProxyValidationError);
  }
  for (const extra of [{ protocol: "socks5" }, { port: 0 }, { port: 65536 }, { port: 8000.5 }, { port: "8000" }, { login: "bad:user" }, { login: "" }, { password: "" }, { password: "bad\r\nvalue" }]) {
    assert.throws(() => parsePartsApiProxyConfig({ ...config, ...extra }), PartsApiProxyValidationError);
  }
});

test("proxies and active selection are encrypted, restored and removed without exposing credentials", (t) => {
  const { store, path, key } = fixture(t);
  store.add(config);
  const id = store.getState().proxies[0].id;
  const plaintext = readFileSync(path, "utf8");
  assert.ok(!plaintext.includes(config.password));
  assert.ok(!plaintext.includes(config.login));
  assert.ok(!JSON.stringify(store.getState()).includes(config.login));
  store.select(id);
  const restored = new EncryptedPartsApiProxyStore(path, key);
  assert.equal(restored.getSelection().proxy.password, config.password);
  assert.equal(restored.getState().activeRouteId, id);
  assert.throws(() => restored.delete(id), /Active/);
  restored.select(null);
  restored.delete(id);
  assert.equal(existsSync(path), false);
  assert.throws(() => store.add(config), /already exists/);
});

test("proxy text import preserves password punctuation and reports safe line errors", () => {
  const configs = parsePartsApiProxyImport({ protocol: "https", text: "\uFEFFproxy.example.org:8443:fictional-user: password:with:@symbols \r\n\r\n8.8.8.8:8080:user:pass" });
  assert.deepEqual(configs[0], { protocol: "https", host: "proxy.example.org", port: 8443, login: "fictional-user", password: " password:with:@symbols " });
  assert.equal(configs.length, 2);
  for (const text of ["", "\n ", "8.8.8.8:8080:user", "8.8.8.8:0:user:secret", "8.8.8.8:8080:user:secret\n127.0.0.1:8080:user:secret", "x".repeat(512 * 1024 + 1), Array(101).fill("8.8.8.8:8080:user:secret").join("\n")]) {
    assert.throws(() => parsePartsApiProxyImport({ protocol: "http", text }), (error) => {
      assert.ok(error instanceof PartsApiProxyValidationError);
      assert.ok(!error.message.includes("secret"));
      return true;
    });
  }
  assert.throws(() => parsePartsApiProxyImport({ protocol: "http", text: "8.8.8.8:8080:user:pass\nwrong" }), /Строка 2/);
});

test("a hundred proxies import atomically, deduplicate and restore from encrypted storage", (t) => {
  const { store, path, key } = fixture(t);
  const configs = Array.from({ length: 100 }, (_, index) => ({ ...config, host: `edge-${index}.proxy.example.org`, password: "fictional-long-password-" + "a".repeat(1600) }));
  const imported = store.import(configs);
  assert.equal(imported.importedCount, 100);
  assert.equal(imported.duplicateCount, 0);
  const id = imported.proxies[99].id;
  store.select(id);
  const encrypted = readFileSync(path, "utf8");
  assert.ok(encrypted.length > 128 * 1024);
  assert.ok(!encrypted.includes(configs[0].password));
  const restored = new EncryptedPartsApiProxyStore(path, key);
  assert.equal(restored.getState().proxies.length, 100);
  assert.equal(restored.getState().activeRouteId, id);
  assert.equal(restored.import(configs).duplicateCount, 100);
  assert.equal(restored.getState().activeRouteId, id);
  assert.throws(() => restored.add(config), /full/);
  const before = readFileSync(path, "utf8");
  assert.throws(() => restored.import([config]), /100/);
  assert.equal(readFileSync(path, "utf8"), before);
  const empty = fixture(t).store;
  assert.throws(() => empty.import([config, { ...config, host: "127.0.0.1" }]), PartsApiProxyValidationError);
  assert.equal(empty.getState().proxies.length, 0);
  assert.equal(empty.import([config, config]).duplicateCount, 1);
});

test("IP-limit rotation traverses all hundred imported proxies without manual selection", async (t) => {
  const { store } = fixture(t);
  store.import(Array.from({ length: 100 }, (_, index) => ({ ...config, host: `edge-${index}.proxy.example.org` })));
  const calls = [];
  const routing = new PartsApiRoutingClient(new PartsApiApplicabilityClient(async () => limited(), async (_url, proxy) => {
    calls.push(proxy.host);
    return proxy.host === "edge-99.proxy.example.org" ? success() : limited();
  }), store);
  assert.equal((await routing.search(query, signal())).length, 1);
  assert.equal(calls.length, 100);
  assert.equal(store.getSelection().proxy.host, "edge-99.proxy.example.org");
  assert.equal(store.getState().usage.requestCount, 101);
  await routing.search(query, signal());
  assert.equal(calls.at(-1), "edge-99.proxy.example.org");
});

test("daily reset keeps its boundary over idle days, restart and late IP-limit replies", (t) => {
  const { path, key } = fixture(t);
  const start = 1_800_000_000_000;
  let now = start;
  const store = new EncryptedPartsApiProxyStore(path, key, () => now);
  store.add(config);
  const oldSelection = store.getSelection();
  const attemptWindow = store.recordAttempt(null);
  now += 3 * 86_400_000 + 1234;
  store.recordOutcome(null, "failed", attemptWindow);
  store.advanceAfterIpLimit(oldSelection, new Set([null]));
  let state = store.getState();
  assert.equal(state.usage.requestCount, 0);
  assert.equal(state.directLimited, false);
  assert.equal(state.usage.windowStartedAt, start + 3 * 86_400_000);
  assert.equal(state.usage.secondsUntilReset, 86_399);
  const restored = new EncryptedPartsApiProxyStore(path, key, () => now);
  assert.equal(restored.getState().usage.resetAt, start + 4 * 86_400_000);
  restored.recordAttempt(null);
  now = start + 4 * 86_400_000;
  state = restored.getState();
  assert.equal(state.usage.requestCount, 0);
  assert.equal(state.usage.secondsUntilReset, 86_400);
});

test("failed imports and daily reset writes preserve previous state for a retry", (t) => {
  const { path, key } = fixture(t);
  let now = 1_800_000_000_000;
  const store = new EncryptedPartsApiProxyStore(path, key, () => now);
  store.add(config);
  store.recordAttempt(null);
  store.advanceAfterIpLimit(store.getSelection(), new Set([null]));
  const saved = readFileSync(path);
  const before = store.getState();
  rmSync(path);
  mkdirSync(path);
  assert.throws(() => store.import([secondConfig]));
  assert.deepEqual(store.getState(), before);
  now += 86_400_000;
  assert.throws(() => store.getState());
  assert.throws(() => store.getState());
  rmdirSync(path);
  writeFileSync(path, saved);
  assert.equal(store.getState().usage.requestCount, 0);
  assert.equal(store.getState().directLimited, false);
  assert.equal(new EncryptedPartsApiProxyStore(path, key, () => now).getState().proxies.length, 1);
});

test("usage counters classify data, empty and failed responses and reset after 24 hours", (t) => {
  const { path, key } = fixture(t);
  let now = 1_800_000_000_000;
  const store = new EncryptedPartsApiProxyStore(path, key, () => now);
  store.add(config);
  const proxyId = store.getState().proxies[0].id;
  const directWindow = store.recordAttempt(null);
  store.recordOutcome(null, "empty", directWindow);
  const proxyWindow = store.recordAttempt(proxyId);
  store.recordOutcome(proxyId, "data", proxyWindow);
  const failedWindow = store.recordAttempt(proxyId);
  store.recordOutcome(proxyId, "failed", failedWindow);
  let state = store.getState();
  assert.equal(state.usage.requestCount, 3);
  assert.equal(state.usage.dataResponseCount, 1);
  assert.equal(state.usage.emptyResponseCount, 1);
  assert.equal(state.usage.failedRequestCount, 1);
  assert.equal(state.directUsage.emptyResponseCount, 1);
  assert.equal(state.proxies[0].usage.dataResponseCount, 1);
  assert.equal(state.proxies[0].usage.failedRequestCount, 1);
  assert.equal(state.usage.secondsUntilReset, 86_400);
  store.advanceAfterIpLimit(store.getSelection(), new Set([null]));
  assert.equal(store.getState().directLimited, true);
  const restoredBeforeReset = new EncryptedPartsApiProxyStore(path, key, () => now);
  assert.equal(restoredBeforeReset.getState().usage.requestCount, 3);
  assert.equal(restoredBeforeReset.getState().directLimited, true);
  assert.equal(restoredBeforeReset.getState().lastSwitchReason, "ip-limit");
  now += 86_400_000 - 1_000;
  assert.equal(store.getState().usage.secondsUntilReset, 1);
  now += 1_000;
  state = store.getState();
  assert.equal(state.usage.requestCount, 0);
  assert.equal(state.usage.resetAt, now + 86_400_000);
  assert.equal(state.usage.secondsUntilReset, 86_400);
  assert.equal(state.directLimited, false);
  assert.equal(state.proxies[0].usage.requestCount, 0);
  const restored = new EncryptedPartsApiProxyStore(path, key, () => now);
  assert.equal(restored.getState().usage.requestCount, 0);
});

test("direct-only usage persists without proxies and drops late outcomes from the expired window", (t) => {
  const { path, key } = fixture(t);
  let now = 1_800_000_000_000;
  const store = new EncryptedPartsApiProxyStore(path, key, () => now);
  const oldSelection = store.getSelection();
  const window = store.recordAttempt(null);
  store.recordOutcome(null, "empty", window);
  assert.equal(new EncryptedPartsApiProxyStore(path, key, () => now).getState().usage.emptyResponseCount, 1);
  now += 86_400_000;
  store.getState();
  store.advanceAfterIpLimit(oldSelection, new Set([null]));
  assert.equal(store.getState().directLimited, false);
  store.recordOutcome(null, "data", window);
  assert.equal(store.getState().usage.dataResponseCount, 0);
  const nextWindow = store.recordAttempt(null);
  assert.notEqual(nextWindow, window);
  store.recordOutcome(null, "data", nextWindow);
  assert.equal(store.getState().usage.requestCount, 1);
});

test("direct usage works in memory when encrypted persistence is not configured", (t) => {
  const { path } = fixture(t);
  const store = new EncryptedPartsApiProxyStore(path, null);
  const window = store.recordAttempt(null);
  store.recordOutcome(null, "data", window);
  assert.equal(store.getState().persistent, false);
  assert.equal(store.getState().usage.dataResponseCount, 1);
  assert.equal(existsSync(path), false);
});

test("startup classifies interrupted attempts as failures without losing the total", (t) => {
  const { store, path, key } = fixture(t);
  store.add(config);
  const proxyId = store.getState().proxies[0].id;
  store.recordAttempt(null);
  store.recordAttempt(proxyId);
  const restored = new EncryptedPartsApiProxyStore(path, key).getState();
  assert.equal(restored.usage.requestCount, 2);
  assert.equal(restored.usage.failedRequestCount, 2);
  assert.equal(restored.directUsage.failedRequestCount, 1);
  assert.equal(restored.proxies[0].usage.failedRequestCount, 1);
});

test("proxy storage rejects a missing key, tampering, invalid selections and write failures", (t) => {
  const { store, path, key } = fixture(t);
  assert.throws(() => new EncryptedPartsApiProxyStore(path, null).add(config), SupplierIntegrationError);
  store.add(config);
  assert.throws(() => new EncryptedPartsApiProxyStore(path, null), /ENCRYPTION_KEY/);
  assert.throws(() => new EncryptedPartsApiProxyStore(path, Buffer.alloc(32, 2)), /decrypted/);
  assert.throws(() => store.select("unknown"), PartsApiProxyValidationError);
  const original = readFileSync(path);
  const data = JSON.parse(original);
  data.authTag = Buffer.alloc(16).toString("base64");
  writeFileSync(path, JSON.stringify(data));
  assert.throws(() => new EncryptedPartsApiProxyStore(path, key), /decrypted/);
  writeFileSync(path, original);
  const before = store.getState();
  rmSync(path);
  mkdirSync(path);
  assert.throws(() => store.add(secondConfig));
  assert.deepEqual(store.getState(), before);
  assert.throws(() => store.select(before.proxies[0].id));
  assert.deepEqual(store.getState(), before);
  assert.throws(() => store.recordAttempt(null));
  assert.deepEqual(store.getState(), before);
});

test("IP quota retries the same request through proxies and keeps the successful route", async (t) => {
  const { store } = fixture(t);
  store.add(config);
  store.add(secondConfig);
  const calls = [];
  const client = new PartsApiApplicabilityClient(async (url) => { calls.push([null, url.href]); return limited(); }, async (url, proxy) => {
    calls.push([proxy.host, url.href]);
    return proxy.host === config.host ? limited() : success();
  });
  const routing = new PartsApiRoutingClient(client, store);
  const result = await routing.search(query, signal());
  assert.equal(result[0].carId, 1);
  assert.deepEqual(calls.map(([host]) => host), [null, config.host, secondConfig.host]);
  assert.equal(new Set(calls.map(([, url]) => url)).size, 1);
  assert.equal(store.getState().directLimited, true);
  assert.equal(store.getState().proxies[0].limited, true);
  assert.equal(store.getState().lastSwitchReason, "ip-limit");
  assert.equal(store.getSelection().proxy.host, secondConfig.host);
  assert.equal(store.getState().usage.requestCount, 3);
  assert.equal(store.getState().usage.failedRequestCount, 2);
  assert.equal(store.getState().proxies[0].usage.failedRequestCount, 1);
  assert.equal(store.getState().proxies[1].usage.dataResponseCount, 1);
  await routing.search(query, signal());
  assert.deepEqual(calls.map(([host]) => host), [null, config.host, secondConfig.host, secondConfig.host]);
  store.select(null);
  assert.equal(store.getState().directLimited, false);
});

test("pool exhaustion attempts each route once and never falls back to direct", async (t) => {
  const { store } = fixture(t);
  store.add(config);
  store.add(secondConfig);
  const calls = [];
  const routing = new PartsApiRoutingClient(new PartsApiApplicabilityClient(async () => { calls.push(null); return limited(); }, async (_url, proxy) => {
    calls.push(proxy.host); return limited();
  }), store);
  await assert.rejects(routing.search(query, signal()), (error) => error instanceof PartsApiIpLimitError && /по IP/.test(error.publicMessage));
  assert.deepEqual(calls, [null, config.host, secondConfig.host]);
  assert.equal(store.getState().proxies.every(({ limited }) => limited), true);
  await assert.rejects(routing.search(query, signal()), PartsApiIpLimitError);
  assert.deepEqual(calls, [null, config.host, secondConfig.host, secondConfig.host]);
});

test("ordinary key rejections, unsupported error bodies and proxy failures cannot rotate routes", async (t) => {
  const { store } = fixture(t);
  store.add(config);
  let proxied = 0;
  for (const response of [Response.json({ ...ipQuota, message: "Invalid key" }, { status: 401 }), Response.json({ ...ipQuota, error_code: 4000 }, { status: 401 }), new Response("Rate limited", { status: 429 }), new Response("x".repeat(17000), { status: 401 }), new Response("<html>failure</html>", { status: 403 })]) {
    const routing = new PartsApiRoutingClient(new PartsApiApplicabilityClient(async () => response, async () => { proxied += 1; return success(); }), store);
    await assert.rejects(routing.search(query, signal()), PartsApiKeyError);
    assert.equal(store.getState().activeRouteId, null);
    assert.equal(store.getState().directLimited, false);
  }
  assert.equal(proxied, 0);
  store.select(store.getState().proxies[0].id);
  const active = store.getState();
  let direct = 0;
  const routing = new PartsApiRoutingClient(new PartsApiApplicabilityClient(async () => { direct += 1; return success(); }, async () => { throw new SupplierIntegrationError("fictional proxy failure"); }), store);
  await assert.rejects(routing.search(query, signal()), SupplierIntegrationError);
  assert.equal(direct, 0);
  const afterFailure = store.getState();
  assert.equal(afterFailure.activeRouteId, active.activeRouteId);
  assert.deepEqual(afterFailure.proxies.map(({ id, host, port, protocol, limited }) => ({ id, host, port, protocol, limited })),
    active.proxies.map(({ id, host, port, protocol, limited }) => ({ id, host, port, protocol, limited })));
  assert.equal(afterFailure.usage.requestCount, active.usage.requestCount + 1);
  assert.equal(afterFailure.usage.failedRequestCount, active.usage.failedRequestCount + 1);
});

test("parallel direct-limit replies reuse the selected proxy instead of skipping it", async (t) => {
  const { store } = fixture(t);
  store.add(config);
  store.add(secondConfig);
  const pending = [];
  const hosts = [];
  const routing = new PartsApiRoutingClient(new PartsApiApplicabilityClient(() => new Promise((resolve) => pending.push(resolve)), async (_url, proxy) => {
    hosts.push(proxy.host); return success();
  }), store);
  const a = routing.search(query, signal());
  const b = routing.search(query, signal());
  for (const finish of pending) finish(limited());
  await Promise.all([a, b]);
  assert.deepEqual(hosts, [config.host, config.host]);
  assert.equal(store.getState().proxies[1].limited, false);
});

test("a late rejection cannot replace a manual route or restore a deleted proxy", async (t) => {
  const { store } = fixture(t);
  store.add(config);
  store.add(secondConfig);
  const [first, second] = store.getState().proxies;
  store.select(first.id);
  let finish;
  const hosts = [];
  const routing = new PartsApiRoutingClient(new PartsApiApplicabilityClient(async () => success(), (_url, proxy) => {
    hosts.push(proxy.host);
    return proxy.host === config.host ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve(success());
  }), store);
  const pending = routing.search(query, signal());
  store.select(second.id);
  store.delete(first.id);
  finish(limited());
  await pending;
  assert.deepEqual(hosts, [config.host, secondConfig.host]);
  assert.equal(store.getState().activeRouteId, second.id);
  assert.equal(store.getState().lastSwitchReason, "manual");
  assert.equal(store.getState().proxies.length, 1);
});

test("cancellation and per-attempt deadlines do not start another route", async (t) => {
  const { store } = fixture(t);
  store.add(config);
  let calls = 0;
  const routing = new PartsApiRoutingClient(new PartsApiApplicabilityClient((_url, { signal }) => {
    calls += 1;
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  }), store);
  await assert.rejects(routing.search(query, AbortSignal.abort()), { name: "AbortError" });
  assert.equal(calls, 0);
  const controller = new AbortController();
  const pending = routing.search(query, controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const timed = routing.search(query, signal());
  t.mock.timers.tick(8000);
  await assert.rejects(timed, SupplierTimeoutError);
  assert.equal(store.getState().directLimited, false);
});

test("response-body timeout keeps its typed error and cannot trigger a proxy switch", async (t) => {
  const { store } = fixture(t);
  store.add(config);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let readerStarted;
  const started = new Promise((resolve) => { readerStarted = resolve; });
  const routing = new PartsApiRoutingClient(new PartsApiApplicabilityClient(async (_url, { signal }) => new Response(new ReadableStream({
    start(controller) { signal.addEventListener("abort", () => controller.error(new Error("fictional stream abort")), { once: true }); },
    pull() { readerStarted(); },
  }), { headers: { "Content-Type": "application/json" } })), store);
  const pending = routing.search(query, signal());
  await started;
  t.mock.timers.tick(8000);
  await assert.rejects(pending, SupplierTimeoutError);
  assert.equal(store.getState().directLimited, false);
});

test("adding a proxy during an IP rejection permits switching without overriding a manual choice", async (t) => {
  const { store } = fixture(t);
  let finish;
  const hosts = [];
  const routing = new PartsApiRoutingClient(new PartsApiApplicabilityClient(() => new Promise((resolve) => { finish = resolve; }), async (_url, proxy) => { hosts.push(proxy.host); return success(); }), store);
  const pending = routing.search(query, signal());
  store.add(config);
  finish(limited());
  await pending;
  assert.deepEqual(hosts, [config.host]);
  const id = store.getState().activeRouteId;
  const selected = store.getSelection();
  store.advanceAfterIpLimit(selected, new Set([id]));
  assert.equal(store.getState().proxies[0].limited, true);
  await routing.search(query, signal());
  assert.equal(store.getState().proxies[0].limited, false);
});

test("proxy rotation is bounded by a single thirty-second deadline", async (t) => {
  const { store } = fixture(t);
  for (let port = 8000; port < 8008; port += 1) store.add({ ...config, port });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const respond = (signal) => new Promise((resolve, reject) => {
    calls += 1;
    const timer = setTimeout(() => resolve(limited()), 6000);
    signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
  const routing = new PartsApiRoutingClient(new PartsApiApplicabilityClient((_url, init) => respond(init.signal), (_url, _proxy, signal) => respond(signal)), store);
  const pending = routing.search(query, signal());
  const rejected = assert.rejects(pending, SupplierTimeoutError);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    t.mock.timers.tick(6000);
    await new Promise((resolve) => setImmediate(resolve));
  }
  await rejected;
  assert.equal(calls, 5);
});
