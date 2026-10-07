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
    "Универсал, 1117, LADA, KALINA, 2008-2013, 1.4, 16V LPG",
  );
});

test("applicability compact list uses present for an absent end year", () => {
  assert.equal(
    formatApplicabilityVehicle({
      carName: "1.6",
      makeName: "AUDI",
      modelName: "A2 (8Z0) Saloon",
      yearEnd: null,
      yearStart: "05.2002",
    }),
    "Седан, 8Z0, AUDI, A2, 2002-н.в., 1.6, отсутствует",
  );
});

test("applicability structured list omits unchecked columns", () => {
  assert.equal(
    formatApplicabilityVehicle({
      carName: "1.6 Sport",
      makeName: "LADA",
      modelName: "KALINA Хэтчбэк (1119)",
      yearEnd: "12.2013",
      yearStart: "06.2013",
    }, new Set(["bodyCode", "makeName", "modelName", "years", "capacity"])),
    "1119, LADA, KALINA, 2013-2013, 1.6",
  );
});

test("applicability structured list joins multiple body codes", () => {
  assert.equal(
    formatApplicabilityVehicle({
      carName: "2.0",
      makeName: "BMW",
      modelName: "3 (E90, E91)",
      yearEnd: "12.2012",
      yearStart: "01.2005",
    }),
    "отсутствует, E90/E91, BMW, 3, 2005-2012, 2.0, отсутствует",
  );
});

test("applicability structured list removes TECDOC placeholders from body codes", () => {
  assert.equal(
    formatApplicabilityVehicle({
      carName: "0.8",
      makeName: "LADA",
      modelName: "OKA (1111_)",
      yearEnd: "12.2007",
      yearStart: "01.1996",
    }),
    "отсутствует, 1111, LADA, OKA, 1996-2007, 0.8, отсутствует",
  );
});

test("applicability structured list expands SAMARA body codes into separate rows", () => {
  assert.equal(
    formatApplicabilityVehicle({
      carName: "1.5",
      makeName: "LADA",
      modelName: "SAMARA (2108/2109/2113/2114)",
      yearEnd: "12.2013",
      yearStart: "01.1996",
    }),
    [
      "отсутствует, 2108, LADA, 2108, 1996-2013, 1.5, отсутствует",
      "отсутствует, 2109, LADA, 2109, 1996-2013, 1.5, отсутствует",
      "отсутствует, 2113, LADA, 2113, 1996-2013, 1.5, отсутствует",
      "отсутствует, 2114, LADA, 2114, 1996-2013, 1.5, отсутствует",
    ].join("\n"),
  );
});

test("applicability structured list keeps combined van and wagon body type together", () => {
  assert.equal(
    formatApplicabilityVehicle({
      carName: "1.5",
      makeName: "LADA",
      modelName: "KALINKA Фургон /универсал (21043)",
      yearEnd: "12.1998",
      yearStart: "01.1985",
    }),
    "Фургон/универсал, 21043, LADA, KALINKA, 1985-1998, 1.5, отсутствует",
  );
});

test("applicability recognizes a combined van and SUV designation before the van fallback", () => {
  assert.equal(
    formatApplicabilityVehicle({
      carName: "1.6 CRDi",
      makeName: "HYUNDAI",
      modelName: "TUCSON Автофургон / спортивно-утилитарный автомобиль (TLE)",
      yearEnd: "12.2020",
      yearStart: "01.2018",
    }),
    "SUV/Внедорожник, TLE, HYUNDAI, TUCSON, 2018-2020, 1.6, CRDi",
  );
});

test("applicability removes the combined van and SUV designation from KONA", () => {
  assert.equal(
    formatApplicabilityVehicle({
      carName: "1.6 T-GDi",
      makeName: "HYUNDAI",
      modelName: "KONA Автофургон / спортивно-утилитарный автомобиль (OS)",
      yearEnd: "12.2023",
      yearStart: "06.2017",
    }),
    "SUV/Внедорожник, OS, HYUNDAI, KONA, 2017-2023, 1.6, T-GDi",
  );
});
