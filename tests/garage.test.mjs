import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GarageApplicationService, GarageConflictError } from "../src/backend/garage/garage-application-service.ts";
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
    const offerId = service.registerSearchOffer(offer);
    const item = service.addOffer(vehicle.id, vehicle.revision, offerId, 35, 2);
    assert.equal(item.purchasePrice, 100);
    const details = service.getVehicle(vehicle.id);
    const duplicate = service.addOffer(vehicle.id, details.revision, offerId, 35, 2);
    assert.equal(duplicate.duplicate.id, item.id);
    const merged = service.addOffer(vehicle.id, details.revision, offerId, 35, 2, "increment");
    assert.equal(merged.requiredQuantity, 4);
    assert.throws(() => service.renameVehicle(vehicle.id, vehicle.revision, "Старое имя"), GarageConflictError);
    const current = service.getVehicle(vehicle.id);
    const refreshedVehicle = await service.refreshVehicle(vehicle.id, current.revision, new AbortController().signal);
    assert.equal(refreshedVehicle.items[0].purchasePrice, 120);
    assert.equal(refreshedVehicle.items[0].regularPrice, 162);
    assert.equal(refreshedVehicle.items[0].availabilityStatus, "insufficient");
  } finally {
    repository.close();
    await rm(directory, { recursive: true, force: true });
  }
});
