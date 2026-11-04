import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { GarageApplicationService, GarageConflictError, GarageOfferExpiredError, GarageValidationError } from "../src/backend/garage/garage-application-service.ts";
import { SqliteGarageRepository } from "../src/backend/garage/sqlite-garage-repository.ts";
import { CartApplicationService } from "../src/backend/purchasing/cart-application-service.ts";
import { SqliteCartRepository } from "../src/backend/purchasing/sqlite-cart-repository.ts";
import { attachPurchaseReference } from "../src/backend/purchasing/purchase-offer.ts";
import { parsePartKomApiResults } from "../src/backend/suppliers/part-kom/part-kom-api-adapter.ts";
import { createHttpGarageApplication } from "../src/backend/garage/http-garage-application.ts";
import { SupplierAuthError, SupplierIntegrationError, SupplierTimeoutError } from "../src/backend/errors.ts";

const offer = {
  supplier: "rossko", brand: "Toyota", article: "ABC-123", title: "Фильтр", price: 100,
  quantity: 4, warehouse: "Основной", deliveryDate: "2026-09-11", deliveryDateTo: "2026-09-13", deliveryDateApproximate: true,
  link: "https://rossko.ru/product/123",
};

// Fictional PartKOM providers intentionally share the same public warehouse label.
const partKomOffers = (price = 100) => parsePartKomApiResults([
  { number: "2478298", maker: "Ford", description: "Цилиндр сцепления рабочий", makerId: 101,
    providerId: 202, placement: "Склад", price, quantity: 3, expectedDate: "2028-03-10" },
  { number: "2478298", maker: "Ford", description: "Цилиндр сцепления рабочий", makerId: 101,
    providerId: 303, placement: "Склад", price: 150, quantity: 5, expectedDate: "2028-03-12" },
], "2478298");

test("garage retains the supplier identity across restart and refreshes the same PartKOM provider as the cart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "autoservice-garage-provider-"));
  const path = join(directory, "garage.sqlite");
  let results = partKomOffers(130);
  let service = new GarageApplicationService(new SqliteGarageRepository(path), {
    findOffers: async () => ({ results, failed: false }),
  });
  try {
    const vehicle = service.createVehicle("Тестовый Transit");
    const initial = partKomOffers()[0];
    const saved = service.addOffer(vehicle.id, vehicle.revision, service.registerSearchOffer(initial), 35, 2);
    service.close();
    service = new GarageApplicationService(new SqliteGarageRepository(path), {
      findOffers: async () => ({ results, failed: false }),
    });
    const refresh = () => service.refreshVehicle(vehicle.id, service.getVehicle(vehicle.id).revision, new AbortController().signal);
    const fresh = (await refresh()).items[0];
    assert.equal(fresh.availabilityStatus, "available");
    assert.equal(fresh.purchasePrice, 130);
    assert.equal(fresh.regularPrice, 175.5);
    assert.equal(fresh.requiredQuantity, 2);
    assert.equal(fresh.id, saved.id);
    assert.equal(fresh.deliveryDate, results[0].deliveryDate);
    const prepared = await service.prepareCartOffers(vehicle.id, service.getVehicle(vehicle.id).revision, saved.id,
      new AbortController().signal, (_id, result) => { assert.equal(result.price, 130); return true; });
    assert.equal(prepared.offers.length, 1);
    assert.doesNotMatch(JSON.stringify(prepared), /providerId|makerId|purchaseReference|purchase_reference/);
    results = [results[1]];
    assert.equal((await refresh()).items[0].availabilityStatus, "not_found", "another provider must not silently replace the original");
    assert.equal(service.getVehicle(vehicle.id).items[0].purchasePrice, 130);
    results = partKomOffers(140);
    assert.equal((await refresh()).items[0].purchasePrice, 140);
  } finally { service.close(); await rm(directory, { recursive: true, force: true }); }
});

test("garage recovers an unambiguous legacy PartKOM snapshot then retains its private provider identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "autoservice-garage-legacy-provider-"));
  const path = join(directory, "garage.sqlite");
  let results = partKomOffers();
  const service = new GarageApplicationService(new SqliteGarageRepository(path), {
    findOffers: async () => ({ results, failed: false }),
  });
  try {
    const vehicle = service.createVehicle("Сохранённый Transit");
    // structuredClone simulates a pre-migration garage entry with no private reference.
    const initial = structuredClone(results[0]);
    service.addOffer(vehicle.id, vehicle.revision, service.registerSearchOffer(initial), 35, 1);
    const refresh = () => service.refreshVehicle(vehicle.id, service.getVehicle(vehicle.id).revision, new AbortController().signal);
    assert.equal((await refresh()).items[0].availabilityStatus, "available");
    results = partKomOffers(135);
    assert.equal((await refresh()).items[0].purchasePrice, 135);
  } finally { service.close(); await rm(directory, { recursive: true, force: true }); }
});

test("legacy garage entries remain unconfirmed when snapshots cannot distinguish providers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "autoservice-garage-ambiguous-provider-"));
  const initial = structuredClone(partKomOffers()[0]);
  let results = partKomOffers(110);
  const service = new GarageApplicationService(new SqliteGarageRepository(join(directory, "garage.sqlite")), {
    findOffers: async () => ({ results, failed: false }),
  });
  try {
    const vehicle = service.createVehicle("Тестовая машина");
    service.addOffer(vehicle.id, vehicle.revision, service.registerSearchOffer(initial), 35, 1);
    const refresh = () => service.prepareCartOffers(vehicle.id, service.getVehicle(vehicle.id).revision, undefined,
      new AbortController().signal, () => assert.fail("ambiguous offers must never be orderable"));
    let current = await refresh();
    assert.equal(current.vehicle.items[0].availabilityStatus, "not_found", "neither provider matches the stored price");
    assert.deepEqual(current.offers, []);
    results = partKomOffers();
    results[1].price = 100;
    current = await refresh();
    assert.equal(current.vehicle.items[0].availabilityStatus, "not_found", "identical saved snapshots remain ambiguous");
    assert.deepEqual(current.offers, []);
    assert.equal(current.vehicle.items[0].purchasePrice, initial.price);
  } finally { service.close(); await rm(directory, { recursive: true, force: true }); }
});

test("garage refresh uses persisted identities for every cart supplier and accepts both VAZ article forms", async () => {
  const directory = await mkdtemp(join(tmpdir(), "autoservice-garage-identities-"));
  const reference = (supplier, id) => supplier === "armtek" ? { supplier, keyzak: id, returnDays: 14 }
    : supplier === "part-kom" ? { supplier, makerId: "101", providerId: id }
      : supplier === "forum-auto" ? { supplier, warehouse: "Основной", gid: id } : { supplier, partGuid: "part", stockId: id };
  const origins = { "part-kom": "https://www.part-kom.ru/", armtek: "https://etp.armtek.ru/",
    "forum-auto": "https://itrade.forum-auto.ru/", rossko: "https://samara.rossko.ru/" };
  try {
    for (const supplier of Object.keys(origins)) {
      const original = attachPurchaseReference({ ...offer, supplier, article: "2121-1803027", brand: "TEST", link: origins[supplier] }, reference(supplier, "202"));
      const updated = attachPurchaseReference({ ...original, article: "21210-1803027", price: 180, quantity: 7,
        warehouse: "Обновлённое название склада", deliveryDate: "2028-03-10", deliveryDateTo: null, deliveryDateApproximate: false }, reference(supplier, "202"));
      const other = attachPurchaseReference({ ...updated, price: 90 }, reference(supplier, "303"));
      let results = [other, updated];
      let failed = false;
      const lookup = { findOffers: async () => ({ results, failed }) };
      const path = join(directory, `${supplier}.sqlite`);
      let service = new GarageApplicationService(new SqliteGarageRepository(path), lookup);
      try {
        const vehicle = service.createVehicle("Тестовый автомобиль");
        const item = service.addOffer(vehicle.id, vehicle.revision, service.registerSearchOffer(original), 25, 2);
        service.close();
        service = new GarageApplicationService(new SqliteGarageRepository(path), lookup);
        const refresh = () => service.refreshVehicle(vehicle.id, service.getVehicle(vehicle.id).revision, new AbortController().signal);
        const current = (await refresh()).items[0];
        assert.equal(current.purchasePrice, 180, supplier);
        assert.equal(current.article, "21210-1803027");
        assert.equal(current.availabilityStatus, "available");
        failed = true;
        assert.equal((await refresh()).items[0].availabilityStatus, "supplier_error");
        failed = false;
        assert.equal((await refresh()).items[0].availabilityStatus, "available");
        results = [other];
        assert.equal((await refresh()).items[0].availabilityStatus, "not_found", supplier);
        assert.equal(service.getVehicle(vehicle.id).items[0].purchasePrice, 180);
        assert.equal(service.getVehicle(vehicle.id).items[0].id, item.id);
        results = [updated, updated];
        assert.equal((await refresh()).items[0].availabilityStatus, "not_found", "duplicate matches remain ambiguous");
        results = [updated];
        assert.equal((await refresh()).items[0].availabilityStatus, "available");
      } finally { service.close(); }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("garage lookup requires completed supplier search and keeps upstream failures distinct from missing goods", async () => {
  const directory = await mkdtemp(join(tmpdir(), "autoservice-garage-lookup-"));
  const previousPath = process.env.GARAGE_DB_PATH;
  process.env.GARAGE_DB_PATH = join(directory, "garage.sqlite");
  let mode = "completed";
  const controller = new AbortController();
  const service = createHttpGarageApplication(async (_query, emit) => {
    if (mode === "abort") { controller.abort(new Error("fixture abort")); return; }
    if (mode === "auth_throw") throw new SupplierAuthError("private credential detail");
    if (mode === "timeout_throw") throw new SupplierTimeoutError("private upstream URL");
    if (mode === "integration_throw") throw new SupplierIntegrationError("private supplier payload");
    if (mode === "missing") { emit({ type: "supplier_status", supplier: "rossko", status: "completed" }); return; }
    emit({ type: "result", result: offer });
    if (mode === "fatal") emit({ type: "fatal_error", message: "private failure" });
    if (mode === "other_supplier") emit({ type: "supplier_status", supplier: "armtek", status: "completed" });
    if (!["incomplete", "fatal", "other_supplier"].includes(mode)) {
      emit({ type: "supplier_status", supplier: "rossko", status: mode });
    }
  });
  try {
    const vehicle = service.createVehicle("Тестовая машина");
    service.addOffer(vehicle.id, vehicle.revision, service.registerSearchOffer(offer), 35, 1);
    for (mode of ["completed", "missing", "auth_error", "timeout", "error", "incomplete", "fatal", "other_supplier",
      "auth_throw", "timeout_throw", "integration_throw"]) {
      const result = await service.refreshVehicle(vehicle.id, service.getVehicle(vehicle.id).revision, controller.signal);
      assert.equal(result.items[0].availabilityStatus, mode === "completed" ? "available" : mode === "missing" ? "not_found" : "supplier_error", mode);
      assert.doesNotMatch(JSON.stringify(result), /private/);
    }
    mode = "abort";
    const before = service.getVehicle(vehicle.id);
    await assert.rejects(service.refreshVehicle(vehicle.id, before.revision, controller.signal), /fixture abort/);
    assert.deepEqual(service.getVehicle(vehicle.id), before);
  } finally {
    service.close();
    if (previousPath === undefined) delete process.env.GARAGE_DB_PATH; else process.env.GARAGE_DB_PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
});

test("garage prepares only fresh confirmed cart offers and retains missing or failed positions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "autoservice-garage-cart-"));
  const path = join(directory, "garage.sqlite");
  const offers = new Map();
  let duringLookup = null;
  const service = new GarageApplicationService(new SqliteGarageRepository(path), {
    findOffers: async (article) => {
      if (duringLookup) duringLookup();
      return { results: offers.has(article) ? [offers.get(article)] : [], failed: article === "FAILED" };
    },
  });
  const cart = new CartApplicationService(new SqliteCartRepository(path), async () => []);
  try {
    const vehicle = service.createVehicle("Тестовый автомобиль");
    const ids = new Map();
    for (const article of ["READY", "MISSING", "FAILED", "LOW", "UNKNOWN", "EXPIRED", "FRACTION", "UNSUPPORTED"]) {
      const current = { ...offer, article, deliveryDate: null, deliveryDateTo: null, deliveryDateApproximate: false };
      const item = service.addOffer(vehicle.id, service.getVehicle(vehicle.id).revision, service.registerSearchOffer(current), 35, article === "FRACTION" ? .5 : 2);
      ids.set(article, item.id);
      if (article === "MISSING" || article === "FAILED") continue;
      offers.set(article, attachPurchaseReference({ ...current, price: 150,
        quantity: article === "LOW" ? 1 : article === "UNKNOWN" ? null : 4,
        ...(article === "EXPIRED" ? { deliveryDate: "2000-01-01" } : {}) },
      { supplier: "rossko", partGuid: article, stockId: "fixture-stock" }));
      if (article === "UNSUPPORTED") offers.set(article, { ...current });
    }
    const prepared = await service.prepareCartOffers(vehicle.id, service.getVehicle(vehicle.id).revision, undefined,
      new AbortController().signal, cart.registerOffer.bind(cart));
    assert.equal(prepared.vehicle.items.length, 8);
    assert.deepEqual(prepared.offers.map(({ itemId, quantity }) => ({ itemId, quantity })), [{ itemId: ids.get("READY"), quantity: 2 }]);
    assert.equal(prepared.vehicle.items.find((item) => item.article === "MISSING").availabilityStatus, "not_found");
    assert.equal(prepared.vehicle.items.find((item) => item.article === "FAILED").availabilityStatus, "supplier_error");
    assert.equal(cart.view().count, 0, "preparing offers must never add or place an order");
    const added = cart.mutate("add", { revision: 0, offers: prepared.offers });
    assert.equal(added.count, 2);
    assert.equal(added.items[0].result.price, 150);
    assert.equal(added.items[0].result.article, "READY");
    assert.equal(JSON.stringify(prepared).includes("fixture-stock"), false, "routing references stay on the server");
    const one = await service.prepareCartOffers(vehicle.id, prepared.vehicle.revision, ids.get("READY"), new AbortController().signal, cart.registerOffer.bind(cart));
    assert.equal(one.offers.length, 1);
    await assert.rejects(service.prepareCartOffers(vehicle.id, one.vehicle.revision, "bad-id", new AbortController().signal, cart.registerOffer.bind(cart)), GarageValidationError);
    await assert.rejects(service.prepareCartOffers(vehicle.id, 1, undefined, new AbortController().signal, cart.registerOffer.bind(cart)), GarageConflictError);
    duringLookup = () => {
      const item = service.getVehicle(vehicle.id).items.find((item) => item.article === "READY");
      service.updateItem(item.id, item.revision, 3, "Изменено во время проверки", item.groupId);
    };
    const concurrent = await service.prepareCartOffers(vehicle.id, one.vehicle.revision, ids.get("READY"), new AbortController().signal, cart.registerOffer.bind(cart));
    assert.deepEqual(concurrent.offers, []);
    assert.equal(concurrent.vehicle.items.find((item) => item.article === "READY").requiredQuantity, 3);
    duringLookup = null;
    const abort = new AbortController();
    duringLookup = () => abort.abort(new Error("cancelled"));
    await assert.rejects(service.prepareCartOffers(vehicle.id, concurrent.vehicle.revision, ids.get("READY"), abort.signal, cart.registerOffer.bind(cart)), /cancelled/);
  } finally { service.close(); cart.close(); await rm(directory, { recursive: true, force: true }); }
});

test("table preferences migrate legacy widths and persist validated alignments atomically", async () => {
  const directory = await mkdtemp(join(tmpdir(), "autoservice-table-preferences-"));
  const path = join(directory, "garage.sqlite");
  let repository = new SqliteGarageRepository(path);
  let service = new GarageApplicationService(repository, { findOffers: async () => ({ results: [], failed: false }) });
  try {
    repository.setUiPreference("table-column-widths-v1", JSON.stringify({ main: { supplier: 100 } }));
    assert.deepEqual(service.getTablePreferences(), { widths: { main: { supplier: 100 }, analogs: { supplier: 100 } }, alignments: {} });
    repository.setUiPreference("table-column-settings-v2", JSON.stringify({ widths: { main: { supplier: 60 }, analogs: { supplier: 200, title: 480 } },
      alignments: { main: { supplier: "left" }, analogs: { supplier: "right", title: "center" } } }));
    assert.deepEqual(service.getTablePreferences(), { widths: { main: { supplier: 60, title: 480 }, analogs: { supplier: 60, title: 480 } },
      alignments: { main: { supplier: "left", title: "center" }, analogs: { supplier: "left", title: "center" } } });
    const saved = { widths: { main: { supplier: 24, brand: 64 }, analogs: { supplier: 24, brand: 64 } },
      alignments: { main: { supplier: "right", brand: "center" }, analogs: { supplier: "right", brand: "center" } } };
    assert.deepEqual(service.setTablePreferences(saved.widths, saved.alignments), saved);
    assert.throws(() => service.setTablePreferences({ main: { supplier: 60 } }, { main: { supplier: "justify" } }), GarageValidationError);
    assert.deepEqual(service.getTablePreferences(), saved);
    service.close();
    repository = new SqliteGarageRepository(path);
    service = new GarageApplicationService(repository, { findOffers: async () => ({ results: [], failed: false }) });
    assert.deepEqual(service.getTablePreferences(), saved);
    assert.deepEqual(service.setTablePreferences(saved.widths, undefined), saved);
  } finally { service.close(); await rm(directory, { recursive: true, force: true }); }
});

test("garage persists vehicles, guards revisions, merges known duplicates, and refreshes a supplier snapshot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "autoservice-garage-"));
  const repository = new SqliteGarageRepository(join(directory, "garage.sqlite"));
  let refreshed = { ...offer, price: 120, quantity: 1 };
  const service = new GarageApplicationService(repository, {
    findOffers: async () => ({ results: [refreshed], failed: false }),
  });
  try {
    const vehicle = service.createVehicle("Toyota Camry");
    assert.throws(() => service.addOffer(vehicle.id, vehicle.revision, "expired-offer", 35, 1), GarageOfferExpiredError);
    const offerId = service.registerSearchOffer(offer);
    assert.throws(() => service.addOffer(vehicle.id, vehicle.revision, offerId, 35, 5), GarageValidationError);
    const item = service.addOffer(vehicle.id, vehicle.revision, offerId, 35, 2);
    assert.equal(item.purchasePrice, 100);
    assert.equal(item.deliveryDateTo, "2026-09-13");
    assert.equal(item.deliveryDateApproximate, true);
    const details = service.getVehicle(vehicle.id);
    const duplicate = service.addOffer(vehicle.id, details.revision, offerId, 35, 2);
    assert.equal(duplicate.duplicate.id, item.id);
    const merged = service.addOffer(vehicle.id, details.revision, offerId, 35, 2, "increment");
    assert.equal(merged.requiredQuantity, 4);
    assert.throws(() => service.renameVehicle(vehicle.id, vehicle.revision, "Старое имя"), GarageConflictError);
    const beforeGroup = service.getVehicle(vehicle.id);
    const group = service.createGroup(vehicle.id, beforeGroup.revision, "Стойки");
    assert.equal(group.name, "Стойки");
    const grouped = service.updateItem(item.id, beforeGroup.items[0].revision, 4, "", group.id);
    assert.equal(grouped.groupId, group.id);
    const current = service.getVehicle(vehicle.id);
    assert.deepEqual(current.groups.map(({ name }) => name), ["Стойки"]);
    assert.equal(current.items[0].groupId, group.id);
    const renamed = service.renameGroup(vehicle.id, group.id, current.revision, "Передняя подвеска");
    assert.equal(renamed.name, "Передняя подвеска");
    const beforeDeletion = service.getVehicle(vehicle.id);
    service.deleteGroup(vehicle.id, group.id, beforeDeletion.revision);
    const ungrouped = service.getVehicle(vehicle.id);
    assert.deepEqual(ungrouped.groups, []);
    assert.equal(ungrouped.items[0].groupId, null);
    const refreshedVehicle = await service.refreshVehicle(vehicle.id, ungrouped.revision, new AbortController().signal);
    assert.equal(refreshedVehicle.items[0].purchasePrice, 120);
    assert.equal(refreshedVehicle.items[0].regularPrice, 162);
    assert.equal(refreshedVehicle.items[0].availabilityStatus, "insufficient");
    assert.equal(refreshedVehicle.items[0].deliveryDateTo, "2026-09-13");
    assert.equal(refreshedVehicle.items[0].deliveryDateApproximate, true);
  } finally {
    repository.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("garage refresh matches article formatting, retains ambiguous snapshots and never writes after an abort", async () => {
  const directory = await mkdtemp(join(tmpdir(), "autoservice-garage-refresh-"));
  let results = [{ ...offer, article: "ABC123", deliveryDate: "2026-10-19", deliveryDateTo: "2026-10-20", price: 130 }];
  let failed = false;
  let abort = null;
  const service = new GarageApplicationService(new SqliteGarageRepository(join(directory, "garage.sqlite")), {
    findOffers: async () => { abort?.(); return { results, failed }; },
  });
  try {
    const vehicle = service.createVehicle("Гранта");
    const saved = service.addOffer(vehicle.id, vehicle.revision, service.registerSearchOffer(offer), 35, 1);
    const refresh = () => service.refreshVehicle(vehicle.id, service.getVehicle(vehicle.id).revision, new AbortController().signal);
    assert.equal((await refresh()).items[0].deliveryDate, "2026-10-19");
    assert.equal(service.getVehicle(vehicle.id).items[0].purchasePrice, 130);
    results = [{ ...offer, article: "ABC-123", price: 140 }, { ...offer, article: "ABC 123", price: 150 }];
    assert.equal((await refresh()).items[0].availabilityStatus, "not_found");
    assert.equal(service.getVehicle(vehicle.id).items[0].deliveryDate, "2026-10-19");
    failed = true;
    assert.equal((await refresh()).items[0].availabilityStatus, "supplier_error");
    const current = service.getVehicle(vehicle.id);
    const controller = new AbortController();
    abort = () => controller.abort(new Error("fixture abort"));
    await assert.rejects(service.refreshVehicle(vehicle.id, current.revision, controller.signal), /fixture abort/);
    assert.deepEqual(service.getVehicle(vehicle.id), current);
    assert.equal(current.items[0].id, saved.id);
  } finally { service.close(); await rm(directory, { recursive: true, force: true }); }
});

test("garage migrates existing items into the ungrouped section", async () => {
  const directory = await mkdtemp(join(tmpdir(), "autoservice-garage-legacy-"));
  const path = join(directory, "garage.sqlite");
  const database = new DatabaseSync(path);
  const vehicleId = "8e4b7df5-4d87-4a38-8f2f-bcecc2b4f4f8";
  const itemId = "b6a8cfd3-dbd6-45f0-8f32-0c0c91f166c9";
  try {
    database.exec(`
      CREATE TABLE garage_vehicles (id TEXT PRIMARY KEY, name TEXT NOT NULL, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
      CREATE TABLE garage_items (
        id TEXT PRIMARY KEY, vehicle_id TEXT NOT NULL, revision INTEGER NOT NULL, supplier TEXT NOT NULL, brand TEXT NOT NULL, article TEXT NOT NULL,
        title TEXT NOT NULL, warehouse TEXT, delivery_date TEXT, link TEXT NOT NULL, supplier_quantity REAL, required_quantity REAL NOT NULL,
        purchase_price REAL NOT NULL, markup_percent REAL NOT NULL, regular_price REAL NOT NULL, comment TEXT NOT NULL, last_checked_at TEXT,
        availability_status TEXT NOT NULL
      ) STRICT;
    `);
    database.prepare("INSERT INTO garage_vehicles VALUES (?, ?, ?, ?, ?)").run(vehicleId, "Toyota Camry", 1, "2026-10-04T00:00:00.000Z", "2026-10-04T00:00:00.000Z");
    database.prepare("INSERT INTO garage_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(itemId, vehicleId, 1, "rossko", "Toyota", "ABC-123", "Фильтр", null, null, "https://rossko.ru/product/123", 4, 1, 100, 35, 135, "", null, "available");
  } finally {
    database.close();
  }
  const repository = new SqliteGarageRepository(path);
  try {
    const vehicle = repository.getVehicle(vehicleId);
    assert.deepEqual(vehicle?.groups, []);
    assert.equal(vehicle?.items[0].groupId, null);
    assert.equal(vehicle?.items[0].deliveryDateTo, null);
    assert.equal(vehicle?.items[0].deliveryDateApproximate, false);
  } finally {
    repository.close();
    await rm(directory, { recursive: true, force: true });
  }
});
