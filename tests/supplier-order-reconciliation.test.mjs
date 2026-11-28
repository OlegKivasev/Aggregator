import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createAggregatorServer } from "../src/backend/http/create-server.ts";
import { supplierOrderReconciliationPath } from "../src/backend/http/supplier-order-reconciliation.ts";
import { NomenclatureService } from "../src/backend/nomenclature/nomenclature-service.ts";
import { compareReconciliation } from "../src/backend/purchasing/supplier-order-reconciliation.ts";
import { SupplierCounterparties } from "../src/backend/purchasing/supplier-counterparties.ts";

const supplierItem = (article, quantity, details = {}) => ({ article, brand: "LADA", title: article, quantity,
  fulfillment: "in_transit", ...details });
const localItem = (article, quantity, details = {}) => ({ article, brand: "LADA", title: article, quantity, brandAliases: "", ...details });

test("a single POST compares the selected 1C document with all dated supplier positions by product", async () => {
  const dir = await mkdtemp(join(tmpdir(), "supplier-reconciliation-"));
  const db = join(dir, "orders.sqlite");
  const previousPath = process.env.GARAGE_DB_PATH;
  process.env.GARAGE_DB_PATH = db;
  const calls = [];
  let limited = false;
  const day = "2026-11-28";
  const supplierHistory = [
    { number: "AUT-99", date: day, items: [supplierItem("11190-2902712-00", 1, { brand: "Лада" }), supplierItem("LOCAL-ONLY", 1, { fulfillment: "cancelled" })] },
    { number: "AUT-02", date: `${day} 15:40:00`, items: [supplierItem("1119-2902712", 1), supplierItem("REMOTE-ONLY", 3)] },
    { number: "OTHER-DAY", date: "2026-11-27", items: [supplierItem("LOCAL-ONLY", 50)] },
  ];
  const server = createAggregatorServer({ publicDir: resolve("src/frontend"), application: {
    streamSearch: async () => {}, listSupplierSessions: () => [],
    supplierOrderHistory: async (query) => { calls.push(query); return { limited, orders: supplierHistory }; },
  } });
  const counterparties = new SupplierCounterparties(db);
  const nomenclature = new NomenclatureService(db);
  try {
    const counterpartyId = "12345678-abcd-1234-abcd-123456789abc";
    counterparties.save("autopiter", { id: counterpartyId, name: "Автопитер", taxId: "" });
    const token = nomenclature.rotateKey();
    await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}${supplierOrderReconciliationPath}`;
    const body = { counterpartyId, from: day, to: day, items: [localItem("1119-2902712", 1, { brandAliases: "Лада" }),
      localItem("1119-2902712", 1), localItem("LOCAL-ONLY", 2), ...Array.from({ length: 500 }, (_, i) => localItem(`zero-${i}`, 0))] };
    const post = (data, key) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: JSON.stringify(data) });
    assert.equal((await post(body, "invalid")).status, 401);
    assert.equal((await post({ ...body, to: "2026-02-30" }, token)).status, 400);
    assert.equal((await post({ ...body, counterpartyId: "23456781-abcd-1234-abcd-123456789abc" }, token)).status, 422);
    assert.equal(calls.length, 0);

    const response = await post(body, token);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("Server-Timing"), /^supplier-order-reconciliation;dur=/);
    const result = await response.json();
    assert.deepEqual(calls, [{ supplier: "autopiter", from: day, to: day }]);
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.rows.map(({ article, status, onec, confirmed, cancelled }) => [article, status, onec, confirmed, cancelled]), [
      ["LOCAL-ONLY", "shortage", 2, 0, 1], ["REMOTE-ONLY", "extra", 0, 3, 0],
    ]);

    limited = true;
    supplierHistory.push({ number: "AUT-02", date: day, items: [supplierItem("REMOTE-ONLY", 3)] });
    const incomplete = await (await post(body, token)).json();
    assert.equal(calls.length, 2);
    assert.equal(incomplete.warnings.length, 2);
    assert.ok(incomplete.rows.every(({ status }) => status === "unverified"));
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    nomenclature.close();
    counterparties.close();
    if (previousPath === undefined) delete process.env.GARAGE_DB_PATH;
    else process.env.GARAGE_DB_PATH = previousPath;
    await rm(dir, { recursive: true, force: true });
  }
});

test("conflicting brands and unconfirmed supplier quantities do not appear as certain discrepancies", () => {
  const local = [localItem("MIX", 1, { brand: "ONE", brandAliases: "ALIAS" }), localItem("MIX", 1, { brand: "TWO", brandAliases: "ALIAS" }),
    localItem("PARTIAL", 3), localItem("CANCELLED", 4), localItem("NO-BRAND", 1)];
  const rows = compareReconciliation(local, [supplierItem("MIX", 2, { brand: "ALIAS" }), supplierItem("NO-BRAND", 1, { brand: null }),
    supplierItem("PARTIAL", 4, { fulfillment: "partial", deliveredQuantity: 2 }),
    supplierItem("CANCELLED", 4, { fulfillment: "partially_cancelled", fulfillmentQuantities: { delivered: 2, cancelled: 2 } })], true);
  assert.ok(rows.filter(({ article }) => article === "MIX" || article === "NO-BRAND").every(({ status }) => status === "unverified"));
  assert.deepEqual(rows.filter(({ article }) => article === "PARTIAL" || article === "CANCELLED")
    .map(({ status, confirmed, possible, cancelled }) => [status, confirmed, possible, cancelled]),
  [["unverified", 2, 4, 0], ["shortage", 2, 2, 2]]);
  const [noArticle, unmatched] = compareReconciliation([localItem("CHECK", 2)], [supplierItem("", 2)], true);
  assert.match(noArticle.reason, /артикул/);
  assert.equal(unmatched.status, "unverified");
});
