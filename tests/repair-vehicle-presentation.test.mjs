import assert from "node:assert/strict";
import { test } from "node:test";
import { splitRepairVehicleName } from "../src/frontend/repair-vehicle-presentation.js";

test("repair vehicle display separates a trailing registration while retaining vehicle model details", () => {
  for (const [value, name, plate] of [
    ["Toyota Camry А123ВС163", "Toyota Camry", "А123ВС163"],
    ["LADA Vesta, А 123 ВС 63", "LADA Vesta", "А 123 ВС 63"],
    ["BMW X5 (A123BC777)", "BMW X5", "A123BC777"],
    ["Kia Rio А123ВС", "Kia Rio", "А123ВС"],
    ["Toyota | Camry | А123ВС163", "Toyota Camry", "А123ВС163"],
    ["Hyundai Solaris — А123ВС 163 RUS", "Hyundai Solaris", "А123ВС 163 RUS"],
  ]) assert.deepEqual(splitRepairVehicleName(value), { name, plate });
});

test("repair vehicle display removes pipe separators even without a recognized registration", () => {
  assert.deepEqual(splitRepairVehicleName("LADA | Vesta | 123"), { name: "LADA Vesta 123", plate: "" });
});

test("repair vehicle display preserves names without an unambiguous trailing plate", () => {
  for (const value of ["BMW X5", "Договор № 123", "А123ВС163", "А123ВС163 Toyota Camry", "", '<img src=x onerror="window.repairsXss=1">']) {
    assert.deepEqual(splitRepairVehicleName(value), { name: value, plate: "" });
  }
});
