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
import { parseArmtekOrderHistory } from "../src/backend/suppliers/armtek/armtek-order.ts";

const supplierItem = (article, quantity, details = {}) => ({ article, brand: "LADA", title: article, quantity,
  fulfillment: "in_transit", ...details });
const localItem = (article, quantity, details = {}) => ({ article, brand: "LADA", title: article, quantity, brandAliases: "", ...details });

test("a single POST compares positions from the 1C period with supplier orders by product", async () => {
  const dir = await mkdtemp(join(tmpdir(), "supplier-reconciliation-"));
  const db = join(dir, "orders.sqlite");
  const previousPath = process.env.GARAGE_DB_PATH;
  process.env.GARAGE_DB_PATH = db;
  const calls = [];
  let limited = false;
  const day = "2026-11-28";
  const partKomArticle = "482034581R";
  const connected = ["part-kom", "armtek", "rossko", "forum-auto", "stparts"];
  const { orders: armtekOrders } = parseArmtekOrderHistory({ DATA: [
    { ORDER: "0498323681", ORDER_DATE: "20261128", PIN: "SP2111", BRAND: "HI-Q", KWMENG: "2", KWMENG_R: "2", Issued: "0",
      STATUS: "Позиция полностью поставлена" },
    { ORDER: "A-CANCELLED", ORDER_DATE: "20261128", PIN: "A-CANCELLED", BRAND: "LADA", KWMENG: "3", Issued: "0", REJECTED: "3" },
  ] });
  const otherHistories = {
    armtek: { limited: false, orders: [{ number: "A-1", date: day, items: [supplierItem("ACTIVE", 2)] }, ...armtekOrders] },
    rossko: { limited: false, orders: [{ number: "R-1", date: day, items: [supplierItem("MISSING-IN-1C", 3)] }] },
    "forum-auto": { limited: false, orders: [{ number: "F-1", date: day, items: [supplierItem("WITHOUT-MAPPING", 5)] }] },
  };
  const supplierHistory = [
    { number: "AUT-99", date: day, items: [supplierItem("11190-2902712-00", 1, { brand: "Лада" }), supplierItem("LOCAL-ONLY", 1, { fulfillment: "cancelled" })] },
    { number: "AUT-02", date: `${day} 15:40:00`, items: [supplierItem("1119-2902712", 1), supplierItem("SP1181", 2), supplierItem("REMOTE-ONLY", 3)] },
    { number: "OTHER-DAY", date: "2026-11-27", items: [supplierItem("LOCAL-ONLY", 50)] },
  ];
  const server = createAggregatorServer({ publicDir: resolve("src/frontend"), application: {
    streamSearch: async () => {}, listSupplierSessions: () => connected.map((supplier) => ({ supplier, authorized: true })),
    supplierOrderHistory: async (query) => {
      calls.push(query);
      return query.supplier === "autopiter" ? { limited, orders: supplierHistory } : otherHistories[query.supplier];
    },
    partKomOrderHistory: async (archive) => {
      calls.push({ supplier: "part-kom", archive });
      return { limited: true, orders: [
        { number: "PK-1", date: `${day} 14:52:00`, items: [supplierItem(partKomArticle, 4, { brand: "Тольятти" }),
          supplierItem("PARTIALLY-RECEIVED", 2, { fulfillment: "delivered" })] },
        { number: "PK-2", date: day, items: [supplierItem("COMPLETED", 8, { fulfillment: "delivered" })] },
        { number: "PK-3", date: day, items: [supplierItem("CANCELLED", 8, { fulfillment: "cancelled" })] },
        { number: "PK-4", date: "2026-11-27", items: [supplierItem("OTHER-DAY", 8)] },
      ] };
    },
  } });
  const counterparties = new SupplierCounterparties(db);
  const nomenclature = new NomenclatureService(db);
  try {
    const counterpartyId = "12345678-abcd-1234-abcd-123456789abc";
    counterparties.save("autopiter", { id: counterpartyId, name: "Автопитер", taxId: "" });
    const token = nomenclature.rotateKey();
    await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}${supplierOrderReconciliationPath}`;
    const firstDocument = [localItem("1119-2902712", 1, { brandAliases: "Лада" }), localItem("LOCAL-ONLY", 2)];
    const otherDocuments = [localItem("1119-2902712", 1), localItem("SP1181", 2),
      ...Array.from({ length: 500 }, (_, i) => localItem(`zero-${i}`, 0))];
    const body = { counterpartyId, from: day, to: day, items: [...firstDocument, ...otherDocuments] };
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
    assert.match(result.rows[1].reason, /В 1С за период/);

    limited = true;
    supplierHistory.push({ number: "AUT-02", date: day, items: [supplierItem("REMOTE-ONLY", 3)] });
    const incomplete = await (await post(body, token)).json();
    assert.equal(calls.length, 2);
    assert.equal(incomplete.warnings.length, 2);
    assert.ok(incomplete.rows.every(({ status }) => status === "unverified"));

    const partKomId = "23456781-abcd-1234-abcd-123456789abc";
    const armtekId = "34567891-abcd-1234-abcd-123456789abc";
    const rosskoId = "45678912-abcd-1234-abcd-123456789abc";
    const marketId = "56789123-abcd-1234-abcd-123456789abc";
    counterparties.save("part-kom", { id: partKomId, name: "Автоконтракты", taxId: "" });
    counterparties.save("armtek", { id: armtekId, name: "Армтек", taxId: "" });
    counterparties.save("rossko", { id: rosskoId, name: "Росско", taxId: "" });
    counterparties.save("stparts", { id: marketId, name: "Рынок", taxId: "" });
    assert.equal((await fetch(url)).status, 401);
    const scopeResponse = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(scopeResponse.status, 200);
    const { counterpartyIds: scopeIds } = await scopeResponse.json();
    assert.deepEqual(scopeIds, [partKomId, armtekId, rosskoId]);
    assert.equal(calls.length, 2, "the scope lookup must not contact suppliers");
    const allBody = { from: day, to: day, scopeIds, counterparties: [
      { id: partKomId, name: "Автоконтракты", items: [localItem(partKomArticle, 4), localItem("PARTIALLY-RECEIVED", 2), localItem("PK-UNCERTAIN", 1)] },
      { id: armtekId, name: "Армтек", items: [localItem("ACTIVE", 2), localItem(partKomArticle, 1), localItem("SP2111", 2, { brand: "Sangsin" }),
        localItem("A-CANCELLED", 2)] },
      { id: counterpartyId, name: "Автопитер", items: [localItem("OFFLINE", 2)] },
      { id: marketId, name: "Рынок", items: [localItem("MARKET", 2)] },
      { id: null, name: "Без поставщика", items: [localItem("NO-COUNTERPARTY", 3)] },
    ] };
    assert.equal((await post({ ...allBody, counterparties: [...allBody.counterparties, allBody.counterparties[0]] }, token)).status, 400);
    assert.equal(calls.length, 2);
    const allResponse = await post(allBody, token);
    assert.equal(allResponse.status, 200);
    const all = await allResponse.json();
    assert.equal(all.scope, "all-active");
    assert.equal(all.sourcesRead, 3);
    assert.deepEqual(calls.slice(2), [{ supplier: "part-kom", archive: false }, { supplier: "armtek", from: day, to: day },
      { supplier: "rossko", period: { from: day, to: day } }]);
    const byArticle = new Map(all.rows.map((row) => [row.article, row]));
    assert.equal(all.rows.length, 7);
    assert.deepEqual(all.warnings, ["PartKOM · история достигла предела выдачи."]);
    const [partKomBrandQuestion, armtekShortage] = all.rows.filter((row) => row.article === partKomArticle);
    assert.match(partKomBrandQuestion.supplier, /PartKOM/);
    assert.deepEqual([partKomBrandQuestion.status, partKomBrandQuestion.brand, partKomBrandQuestion.onec, partKomBrandQuestion.confirmed],
      ["unverified", "LADA / Тольятти", 4, 4]);
    assert.match(partKomBrandQuestion.reason, /Разные бренды.*1С.*LADA.*у поставщика.*Тольятти/);
    assert.equal(armtekShortage.status, "shortage");
    assert.match(armtekShortage.supplier, /Armtek/);
    assert.equal(byArticle.get("MISSING-IN-1C").status, "extra");
    assert.match(byArticle.get("MISSING-IN-1C").supplier, /Rossko/);
    assert.match(byArticle.get("PK-UNCERTAIN").reason, /PartKOM.*предела/);
    assert.equal(byArticle.get("PARTIALLY-RECEIVED").highlight, "received");
    const armtekDisk = byArticle.get("SP2111");
    assert.deepEqual([armtekDisk.status, armtekDisk.received, armtekDisk.highlight], ["unverified", 2, "received"]);
    assert.match(armtekDisk.reason, /Sangsin.*HI-Q.*получено 2 шт/);
    assert.equal(byArticle.get("A-CANCELLED").highlight, "cancelled");
    assert.equal(byArticle.get("A-CANCELLED").cancelled, 3);
    for (const article of ["COMPLETED", "CANCELLED", "MARKET", "WITHOUT-MAPPING", "OFFLINE", "NO-COUNTERPARTY", "OTHER-DAY"]) {
      assert.equal(byArticle.has(article), false, article);
    }
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

test("different brands for the same exact article stay unverified even when quantities agree", () => {
  const article = "482034581R";
  const local = [localItem(article, 4)];
  const remote = [supplierItem(article, 4, { brand: "Тольятти" })];
  const [question] = compareReconciliation(local, remote, false);
  assert.deepEqual([question.status, question.brand, question.onec, question.confirmed], ["unverified", "LADA / Тольятти", 4, 4]);
  const [differentQuantity] = compareReconciliation(local, [{ ...remote[0], quantity: 5 }], true);
  assert.deepEqual([differentQuantity.status, differentQuantity.onec, differentQuantity.confirmed], ["unverified", 4, 5]);
  const ambiguous = compareReconciliation([...local, localItem(article, 1, { brand: "OTHER" })], remote, true);
  assert.deepEqual(ambiguous.map(({ brand, status }) => [brand, status]),
    [["LADA", "unverified"], ["OTHER", "unverified"], ["Тольятти", "unverified"]]);
  const [extraBrand] = compareReconciliation(local, [...remote, supplierItem(article, 4)], true);
  assert.deepEqual([extraBrand.brand, extraBrand.status], ["Тольятти", "unverified"]);
  assert.equal(compareReconciliation([localItem("1119-2902712", 4)],
    [supplierItem("11190-2902712", 4, { brand: "Тольятти" })], true).length, 2);
  assert.deepEqual(compareReconciliation([localItem(article, 4, { brandAliases: "Тольятти" })], remote, true), []);
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
