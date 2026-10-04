import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { GarageApplicationService, GarageConflictError, GarageOfferExpiredError, GarageValidationError } from "../src/backend/garage/garage-application-service.ts";
import { SqliteGarageRepository } from "../src/backend/garage/sqlite-garage-repository.ts";

const offer = {
  supplier: "rossko", brand: "Toyota", article: "ABC-123", title: "Фильтр", price: 100,
  quantity: 4, warehouse: "Основной", deliveryDate: "2026-09-11", deliveryDateApproximate: false,
  link: "https://rossko.ru/product/123",
};

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
  } finally {
    repository.close();
    await rm(directory, { recursive: true, force: true });
  }
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
  } finally {
    repository.close();
    await rm(directory, { recursive: true, force: true });
  }
});
