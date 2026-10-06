import assert from "node:assert/strict";
import { test } from "node:test";
import { formatApplicabilityVehicle } from "../src/frontend/applicability-formatting.js";

test("applicability compact list extracts body type, year and engine capacity", () => {
  assert.equal(
    formatApplicabilityVehicle({
      carName: "1.4 16V LPG",
      makeName: "LADA",
      modelName: "KALINA универсал (1117)",
      yearEnd: "12.2013",
      yearStart: "11.2008",
    }),
    "Универсал, LADA, KALINA (1117), 2008-2013, 1.4, 16V LPG",
  );
});

test("applicability compact list supports English body types and absent optional parts", () => {
  assert.equal(
    formatApplicabilityVehicle({
      carName: "1.6",
      makeName: "AUDI",
      modelName: "A2 (8Z0) Saloon",
      yearEnd: "н.в.",
      yearStart: "05.2002",
    }),
    "Седан, AUDI, A2 (8Z0), 2002-н.в., 1.6, отсутствует",
  );
});
