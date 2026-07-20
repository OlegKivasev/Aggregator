import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { analyzeEvents, auditArticle, parseArguments } from "../scripts/audit-articles.mjs";

test("article audit validates arguments", () => {
  const options = parseArguments(["--supplier", "rossko,armtek", "--concurrency", "3", "ABC"]);
  assert.deepEqual(options.suppliers, ["rossko", "armtek"]);
  assert.equal(options.concurrency, 3);
  assert.deepEqual(options.articles, ["ABC"]);
  assert.throws(() => parseArguments(["--supplier", "unknown"]), /Unknown supplier/);
});

test("article audit detects invalid normalized results and incomplete suppliers", () => {
  const analysis = analyzeEvents("ABC-123", [
    { type: "search_started", article: "ABC-123", suppliers: ["rossko"] },
    { type: "supplier_status", supplier: "rossko", status: "searching" },
    { type: "result", result: { supplier: "rossko", brand: "Brand", article: "OTHER", title: "Part", price: -1, warehouse: null, deliveryDate: null, deliveryDateApproximate: false, link: "javascript:bad" } },
    { type: "search_completed", article: "ABC-123" },
  ]);

  assert.ok(analysis.issues.some((issue) => issue.code === "article_mismatch"));
  assert.ok(analysis.issues.some((issue) => issue.code === "invalid_price"));
  assert.ok(analysis.issues.some((issue) => issue.code === "invalid_link"));
  assert.ok(analysis.issues.some((issue) => issue.code === "unfinished_supplier"));
});

let server;
let baseUrl;

before(async () => {
  server = createServer((request, response) => {
    if (request.url?.startsWith("/api/search")) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      const events = [
        { type: "search_started", article: "ABC-123", suppliers: ["rossko"] },
        { type: "supplier_status", supplier: "rossko", status: "searching" },
        { type: "result", result: { supplier: "rossko", brand: "Brand", article: "ABC123", title: "Part", price: 10, warehouse: null, deliveryDate: null, deliveryDateApproximate: false, link: "https://example.test/part" } },
        { type: "supplier_status", supplier: "rossko", status: "completed" },
        { type: "search_completed", article: "ABC-123" },
      ];
      response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("article audit consumes a valid SSE search", async () => {
  const result = await auditArticle({ baseUrl, article: "ABC-123", suppliers: ["rossko"], timeoutMs: 5_000 });
  assert.equal(result.outcome, "passed");
  assert.equal(result.resultCount, 1);
  assert.deepEqual(result.issues, []);
});
