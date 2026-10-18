import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { ImageSearchKey } from "../src/backend/images/image-search-key.ts";
import { PartImageSearch, parsePartImages, partImageQuery } from "../src/backend/images/part-image-search.ts";
import { servePartImages } from "../src/backend/http/part-images.ts";

const token = "fictional_image_search_key_123456";
const row = { title: "Тестовый фильтр <img src=x>", thumbnail: "https://encrypted-tbn0.gstatic.com/images?q=fixture",
  original: "https://parts.example/filter.jpg", link: "https://parts.example/filter", source: "Каталог" };
const payload = (rows = [row]) => ({ images_results: rows });
const response = (value = payload()) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
const query = { brand: "TEST", article: "A/1 +&", page: 0 };
const signal = () => new AbortController().signal;

async function fixture(t, request = async () => response(), encrypted = false) {
  const directory = await mkdtemp(join(tmpdir(), "aggregator-images-"));
  const path = join(directory, "key.enc.json");
  const encryptionKey = encrypted ? Buffer.alloc(32, 23) : null;
  const key = new ImageSearchKey(path, encryptionKey);
  const service = new PartImageSearch(key, request);
  t.after(async () => { service.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, path, key, service, encryptionKey };
}

test("image search keys persist only with authenticated encryption and never appear in public state", async (t) => {
  const f = await fixture(t, undefined, true);
  f.service.configure(token);
  assert.deepEqual(f.service.state(), { configured: true, persistent: true });
  const contents = await readFile(f.path, "utf8"); assert.equal(contents.includes(token), false);
  assert.equal(new ImageSearchKey(f.path, f.encryptionKey).get(), token);
  assert.throws(() => new ImageSearchKey(f.path, Buffer.alloc(32, 24)), /could not be decrypted/);
  assert.throws(() => new ImageSearchKey(f.path, null), /Encryption is required/);
  const envelope = JSON.parse(contents); envelope.authTag = Buffer.alloc(16).toString("base64");
  await writeFile(f.path, JSON.stringify(envelope));
  assert.throws(() => new ImageSearchKey(f.path, f.encryptionKey), /could not be decrypted/);
  f.service.disconnect(); assert.equal(existsSync(f.path), false);
  assert.deepEqual(f.service.state(), { configured: false, persistent: true });
});

test("without a master key image search credentials stay in memory and invalid configuration is rejected", async (t) => {
  const f = await fixture(t);
  assert.throws(() => f.service.configure("bad key"), { status: 400 });
  f.service.configure(token); assert.deepEqual(f.service.state(), { configured: true, persistent: false });
  assert.equal(existsSync(f.path), false);
  assert.equal(new ImageSearchKey(f.path, null).get(), null);
  f.service.disconnect(); await assert.rejects(f.service.search(query, signal()), { status: 503 });
});

test("image queries preserve exact brand and article, reject invalid input and never accept arbitrary endpoints", () => {
  assert.deepEqual(partImageQuery(" A/1 +& ", " TEST ", 0), query);
  for (const [article, brand, page] of [["", "TEST", 0], ["A1", null, 0], ["x".repeat(129), "TEST", 0],
    ["A1\n", "TEST", 0], ["A1", "TEST", -1], ["A1", "TEST", 1.2], ["A1", "TEST", "0"], ["A1", "TEST", 10]]) {
    assert.throws(() => partImageQuery(article, brand, page), { status: 400 });
  }
});

test("image parsing rejects malformed responses, filters unsafe URLs, keeps real titles and deduplicates thumbnails", () => {
  const result = parsePartImages({ ...payload([row, row, { ...row, thumbnail: "javascript:alert(1)" }]),
    serpapi_pagination: { next: "https://serpapi.com/search.json?api_key=untrusted" } }, 0);
  assert.deepEqual(result, { images: [{ title: row.title, thumbnail: row.thumbnail, image: row.original, source: row.source, link: row.link }], nextPage: 1 });
  assert.deepEqual(parsePartImages(payload([]), 0), { images: [], nextPage: null });
  assert.equal(parsePartImages(payload([{ ...row, link: "http://catalog.example/part" }]), 0).images[0].link, "http://catalog.example/part");
  assert.equal(parsePartImages({ ...payload(), serpapi_pagination: { next: "anything" } }, 9).nextPage, null);
  for (const value of [null, [], {}, { error: "raw upstream payload" }, payload([null]), payload([{ ...row, title: "" }])]) {
    assert.throws(() => parsePartImages(value, 0), { status: 502 });
  }
  for (const url of ["http://parts.example/a.jpg", "https://127.0.0.1/a", "https://[::1]/a", "https://localhost./a", "https://host.local/a", "https://user:secret@parts.example/a"]) {
    assert.throws(() => parsePartImages(payload([{ ...row, thumbnail: url }]), 0), { status: 502 });
    assert.equal(parsePartImages(payload([{ ...row, original: url }]), 0).images[0].image, row.thumbnail);
  }
});

test("image search uses only the fixed HTTPS API, bounds IO and caches pages independently without exposing provider metadata", async (t) => {
  const calls = [];
  const f = await fixture(t, async (url, options) => {
    calls.push({ url, options }); return response({ ...payload(), serpapi_pagination: { next: "https://untrusted.example/steal-key" }, secret: token });
  });
  f.service.configure(token);
  const first = await f.service.search(query, signal());
  first.images[0].title = "changed by caller";
  const cached = await f.service.search(query, signal()); assert.equal(cached.images[0].title, row.title);
  await f.service.search({ ...query, page: 1 }, signal());
  assert.equal(calls.length, 2);
  for (const { url, options } of calls) {
    assert.equal(url.origin, "https://serpapi.com"); assert.equal(url.pathname, "/search.json");
    assert.equal(url.searchParams.get("q"), "TEST A/1 +&"); assert.equal(url.searchParams.get("engine"), "google_images");
    assert.equal(url.searchParams.get("api_key"), token); assert.equal(options.redirect, "error"); assert.ok(options.signal);
  }
  assert.equal(JSON.stringify(cached).includes(token), false);
  f.service.configure(`${token}_new`); await f.service.search(query, signal()); assert.equal(calls.length, 3);
});

test("image API HTTP errors, invalid JSON, content type, oversized bodies and network failures remain safe errors", async (t) => {
  const cases = [
    [() => new Response(token, { status: 401 }), 401], [() => new Response(token, { status: 403 }), 401],
    [() => new Response(token, { status: 429 }), 429], [() => new Response(token, { status: 500 }), 502],
    [() => new Response("not-json", { headers: { "Content-Type": "application/json" } }), 502],
    [() => new Response("<html>secret</html>", { headers: { "Content-Type": "text/html" } }), 502],
    [() => new Response("{}", { headers: { "Content-Type": "application/json", "Content-Length": "3000000" } }), 502],
    [() => new Response("x".repeat(2 * 1024 * 1024 + 1), { headers: { "Content-Type": "application/json" } }), 502],
    [() => { throw new Error(`network details ${token}`); }, 502],
  ];
  for (const [result, status] of cases) {
    const f = await fixture(t, async () => result()); f.service.configure(token);
    await assert.rejects(f.service.search(query, signal()), (error) => error.status === status && !error.message.includes(token));
  }
});

test("caller cancellation and changing the image key abort pending IO and cannot resurrect cached results", async (t) => {
  let calls = 0;
  const f = await fixture(t, async (_url, options) => {
    calls++;
    return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
  });
  f.service.configure(token);
  const parent = new AbortController(); parent.abort();
  await assert.rejects(f.service.search(query, parent.signal)); assert.equal(calls, 0);
  const pending = f.service.search(query, signal()); f.service.disconnect();
  await assert.rejects(pending, { status: 409 });
  await assert.rejects(f.service.search(query, signal()), { status: 503 });
  f.service.configure(token);
  const active = new AbortController(); const cancelled = f.service.search(query, active.signal); active.abort();
  await assert.rejects(cancelled, (error) => error.name === "AbortError");
});

test("image searches time out and cap simultaneous external requests", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = await fixture(t, async (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true })));
  f.service.configure(token);
  const pending = Array.from({ length: 4 }, () => f.service.search(query, signal()));
  const results = Promise.all(pending.map((promise) => assert.rejects(promise, { status: 504 })));
  await assert.rejects(f.service.search(query, signal()), { status: 429 });
  t.mock.timers.tick(20_000); await results;
});

test("image HTTP routes validate input, protect the key and refuse cross-site requests without making upstream calls", async (t) => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return response(); });
  const server = createServer(async (request, response) => {
    if (!await servePartImages(request, response, new URL(request.url, "http://127.0.0.1"), f.service)) { response.writeHead(404); response.end(); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const endpoint = `${base}/api/part-images`;
  const put = (payload, extra = {}) => fetch(`${endpoint}/key`, { method: "PUT", headers: { "Content-Type": "application/json", ...extra }, body: JSON.stringify(payload) });
  const missing = await fetch(`${endpoint}?brand=TEST&article=A1`); assert.equal(missing.status, 503);
  assert.equal((await put({ apiKey: token }, { "Sec-Fetch-Site": "cross-site" })).status, 403);
  assert.equal((await put({ apiKey: "short" })).status, 400);
  assert.equal((await put({ apiKey: token, unexpected: true })).status, 400);
  assert.equal((await put({ apiKey: token, padding: "x".repeat(2000) })).status, 413);
  assert.equal((await put({ apiKey: token })).status, 200);
  const state = await fetch(`${endpoint}/key`); assert.equal(state.headers.get("cache-control"), "no-store");
  assert.deepEqual(await state.json(), { configured: true, persistent: false });
  for (const suffix of ["?brand=TEST", "?brand=TEST&article=A1&page=-1", "?brand=TEST&article=A1&url=https://internal.local", "?brand=TEST&brand=OTHER&article=A1"]) {
    assert.equal((await fetch(`${endpoint}${suffix}`)).status, 400);
  }
  assert.equal((await fetch(endpoint, { method: "POST" })).status, 405);
  assert.equal(calls, 0);
  const page = await fetch(`${endpoint}?brand=TEST&article=A1`); assert.equal(page.status, 200);
  assert.equal(JSON.stringify(await page.json()).includes(token), false); assert.equal(calls, 1);
  assert.equal((await fetch(`${endpoint}/key`, { method: "DELETE" })).status, 200);
  assert.equal((await fetch(`${endpoint}?brand=TEST&article=A1`)).status, 503);
});
