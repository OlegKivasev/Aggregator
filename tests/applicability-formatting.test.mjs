import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApplicabilityVariantCodeContext, formatApplicabilityVehicle, formatApplicabilityVehicles } from "../src/frontend/applicability-formatting.js";

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

test("applicability structured list keeps bare numeric EV variants as modifications", () => {
  const cases = [
    ["58", "2021", "58"],
    ["58 AWD", "2021", "58 AWD"],
    ["77", "2021", "77"],
    ["77 GT AWD", "2021", "77 GT AWD"],
    ["84", "2024", "84"],
    ["84 GT AWD", "2024", "84 GT AWD"],
    ["100 AWD", "2023", "100 AWD"],
    ["58.0 AWD", "2021", "58.0 AWD"],
  ];

  cases.forEach(([carName, yearStart, expectedCarName]) => {
    assert.equal(
      formatApplicabilityVehicle({
        carName,
        makeName: "KIA",
        modelName: carName === "100 AWD" ? "EV9" : "EV6",
        yearEnd: null,
        yearStart,
      }),
      `отсутствует, отсутствует, KIA, ${carName === "100 AWD" ? "EV9" : "EV6"}, ${yearStart}-н.в., отсутствует, ${expectedCarName}`,
    );
  });
});

test("applicability normalizes standalone hundred-cc engine designations", () => {
  assert.equal(
    formatApplicabilityVehicle({
      carName: "2000",
      makeName: "CITROËN",
      modelName: "CX I",
      yearEnd: "12.1979",
      yearStart: "01.1974",
    }),
    "отсутствует, отсутствует, CITROËN, CX I, 1974-1979, 2.0, отсутствует",
  );
  assert.equal(
    formatApplicabilityVehicle({
      carName: "1000 (KA5)",
      makeName: "SUBARU",
      modelName: "JUSTY I",
      yearEnd: null,
      yearStart: "01.1984",
    }),
    "отсутствует, отсутствует, SUBARU, JUSTY I, 1984-н.в., 1.0, (KA5)",
  );
  assert.equal(
    formatApplicabilityVehicle({
      carName: "2000 GTi",
      makeName: "TEST",
      modelName: "MODEL (X1)",
      yearEnd: null,
      yearStart: "01.2000",
    }),
    "отсутствует, X1, TEST, MODEL, 2000-н.в., 2.0, GTi",
  );
  assert.equal(
    formatApplicabilityVehicle({
      carName: "650 i",
      makeName: "BMW",
      modelName: "7 (E65)",
      yearEnd: null,
      yearStart: "01.2000",
    }),
    "отсутствует, E65, BMW, 7, 2000-н.в., отсутствует, 650 i",
  );
});

test("applicability classifies low integer cc designations from a vehicle family", () => {
  const vehicle = (carName, makeName, modelName) => ({
    carName,
    makeName,
    modelName,
    yearEnd: null,
    yearStart: "01.1980",
  });

  assert.deepEqual(
    formatApplicabilityVehicles([
      vehicle("950", "FORD", "ESCORT I"),
      vehicle("1.1", "FORD", "ESCORT I"),
      vehicle("1.3", "FORD", "ESCORT I"),
    ]).split("\n").map((line) => line.split(", ").slice(-2).join(", ")),
    ["0.95, отсутствует", "1.1, отсутствует", "1.3, отсутствует"],
  );
  assert.deepEqual(
    formatApplicabilityVehicles([
      vehicle("750", "FIAT", "PANDA (141_)"),
      vehicle("0.9", "FIAT", "PANDA (141_)"),
      vehicle("950 4x4", "FIAT", "PANDA (141_)"),
      vehicle("1.0", "FIAT", "PANDA (141_)"),
    ]).split("\n").map((line) => line.split(", ").slice(-2).join(", ")),
    ["0.75, отсутствует", "0.9, отсутствует", "0.95, 4WD", "1.0, отсутствует"],
  );
  assert.deepEqual(
    formatApplicabilityVehicles([
      vehicle("550", "SUBARU", "REX"),
      vehicle("550 Turbo", "SUBARU", "REX"),
      vehicle("0.7", "SUBARU", "REX"),
    ]).split("\n").map((line) => line.split(", ").slice(-2).join(", ")),
    ["0.55, отсутствует", "0.55, Turbo", "0.7, отсутствует"],
  );
  assert.deepEqual(
    formatApplicabilityVehicles([
      vehicle("400 (K22)", "SUBARU", "REX I"),
      vehicle("500 (K23)", "SUBARU", "REX I"),
      vehicle("550 (K24)", "SUBARU", "REX I"),
      vehicle("0.55", "SUBARU", "REX II"),
      vehicle("700", "SUBARU", "REX II"),
    ]).split("\n").map((line) => line.split(", ").slice(-2).join(", ")),
    ["0.4, отсутствует", "0.5, отсутствует", "0.55, отсутствует", "0.55, отсутствует", "0.7, отсутствует"],
  );
  assert.deepEqual(
    formatApplicabilityVehicles([
      vehicle("660 4WD", "SUBARU", "VIVIO"),
      vehicle("0.7", "SUBARU", "VIVIO"),
    ]).split("\n").map((line) => line.split(", ").slice(-2).join(", ")),
    ["0.66, 4WD", "0.7, отсутствует"],
  );
  assert.equal(
    formatApplicabilityVehicles([
      vehicle("520 i", "BMW", "5 (E39)"),
      vehicle("525 i", "BMW", "5 (E39)"),
      vehicle("530 i", "BMW", "5 (E39)"),
      vehicle("550 i", "BMW", "5 (E39)"),
    ]).split("\n").at(-1).split(", ").slice(-2).join(", "),
    "отсутствует, 550 i",
  );
  assert.equal(
    formatApplicabilityVehicle(vehicle("400 E 4.2", "MERCEDES-BENZ", "E-CLASS (W124)"), new Set(["capacity", "carName"])),
    "4.2, 400 E",
  );
  const sClassLines = formatApplicabilityVehicles([
    vehicle("400 SE, SEL/S420", "MERCEDES-BENZ", "S-CLASS"),
    vehicle("500 SE, SEL", "MERCEDES-BENZ", "S-CLASS"),
    vehicle("S 420", "MERCEDES-BENZ", "S-CLASS"),
    vehicle("S 500", "MERCEDES-BENZ", "S-CLASS"),
    vehicle("4.2", "MERCEDES-BENZ", "S-CLASS"),
  ]).split("\n");
  assert.match(sClassLines[0], /, отсутствует, 400 SE, SEL\/S420$/);
  assert.match(sClassLines[1], /, отсутствует, 500 SE, SEL$/);
  assert.match(sClassLines[2], /, отсутствует, S 420$/);
  assert.match(sClassLines[3], /, отсутствует, S 500$/);
  assert.match(sClassLines[4], /, 4\.2, отсутствует$/);
});

test("applicability promotes compatible car-name code groups regardless of cardinality", () => {
  const vehicle = (carName) => ({
    carName,
    makeName: "DACIA",
    modelName: "DOKKER вэн (KE_)",
    yearEnd: null,
    yearStart: "01.2012",
  });
  const columns = new Set(["bodyCode", "carName"]);

  assert.equal(formatApplicabilityVehicle(vehicle("1.5 dCi (KEMW)"), columns), "KEMW, dCi");
  assert.equal(formatApplicabilityVehicle(vehicle("1.5 dCi (KEAJ, KEAH)"), columns), "KEAJ/KEAH, dCi");
  assert.equal(
    formatApplicabilityVehicle({
      carName: "1.6 (HSMC, HSMD)",
      makeName: "DACIA",
      modelName: "DUSTER (HS_)",
      yearEnd: null,
      yearStart: "01.2012",
    }, columns),
    "HSMC/HSMD, отсутствует",
  );
  assert.deepEqual(
    formatApplicabilityVehicles([
      { carName: "1.5 dCi (FEAJ)", makeName: "DACIA", modelName: "DOKKER Автофургон / микроавтобус", yearEnd: null, yearStart: "01.2012" },
      { carName: "1.5 dCi (FEMW)", makeName: "DACIA", modelName: "DOKKER Автофургон / микроавтобус", yearEnd: null, yearStart: "01.2012" },
      { carName: "1.5 dCi (FEJW, FEAH)", makeName: "DACIA", modelName: "DOKKER Автофургон / микроавтобус", yearEnd: null, yearStart: "01.2012" },
    ], columns).split("\n"),
    ["FEAJ, dCi", "FEMW, dCi", "FEJW/FEAH, dCi"],
  );
  assert.equal(
    formatApplicabilityVehicle({
      carName: "1.6 MIVEC (GA1W)",
      makeName: "MITSUBISHI",
      modelName: "ASX (GA_W_)",
      yearEnd: null,
      yearStart: "01.2010",
    }, columns),
    "GA1W, MIVEC",
  );
  assert.equal(
    formatApplicabilityVehicle({
      carName: "1.8 DI-D (GA6W)",
      makeName: "MITSUBISHI",
      modelName: "ASX (GA_W_)",
      yearEnd: null,
      yearStart: "01.2010",
    }, columns),
    "GA6W, DI-D",
  );
  assert.equal(
    formatApplicabilityVehicle({
      carName: "PureTech 130 (CUHNYM, CUHNSS)",
      makeName: "PEUGEOT",
      modelName: "308 (CU_)",
      yearEnd: null,
      yearStart: "01.2017",
    }, columns),
    "CUHNYM/CUHNSS, PureTech 130",
  );
  assert.equal(
    formatApplicabilityVehicle({
      carName: "PureTech 130 (CUHNYM, INVALID)",
      makeName: "PEUGEOT",
      modelName: "308 (CU_)",
      yearEnd: null,
      yearStart: "01.2017",
    }, columns),
    "CU, PureTech 130 (CUHNYM, INVALID)",
  );
  assert.equal(
    formatApplicabilityVehicle({
      carName: "1.4 (182.BG)",
      makeName: "FIAT",
      modelName: "BRAVA (182_)",
      yearEnd: null,
      yearStart: "01.1995",
    }, columns),
    "182.BG, отсутствует",
  );
  assert.equal(
    formatApplicabilityVehicle({
      carName: "2.0 16V (PA3V/W, PB3V, PA3W)",
      makeName: "MITSUBISHI",
      modelName: "L400 Bus (PD_W, PC_W, PA_V, PB_V, PA_W)",
      yearEnd: null,
      yearStart: "01.1994",
    }, columns),
    "PA3V/PA3W/PB3V, 16V",
  );
  assert.equal(
    formatApplicabilityVehicle({
      carName: "1.3 Sport (ZAM4A)",
      makeName: "CITROËN",
      modelName: "AX (ZA-_)",
      yearEnd: null,
      yearStart: "01.1987",
    }, columns),
    "ZAM4A, Sport",
  );
  assert.equal(
    formatApplicabilityVehicle({
      carName: "1.8 4WD (D05V, D05W)",
      makeName: "MITSUBISHI",
      modelName: "SPACE WAGON (D0_V/W)",
      yearEnd: null,
      yearStart: "01.1983",
    }, columns),
    "D05V/D05W, 4WD",
  );
  assert.equal(
    formatApplicabilityVehicle({
      carName: "2.5 TD (L035P, L037G)",
      makeName: "MITSUBISHI",
      modelName: "L 300 / DELICA II (L03_P/G)",
      yearEnd: null,
      yearStart: "01.1986",
    }, columns),
    "L035P/L037G, TD",
  );
  assert.deepEqual(
    formatApplicabilityVehicles([
      { carName: "1.5 dCi 90 (M20, M20M)", makeName: "NISSAN", modelName: "NV200 / EVALIA Bus", yearEnd: null, yearStart: "01.2010" },
      { carName: "1.5 dCi 110 (M20N, M20NN)", makeName: "NISSAN", modelName: "NV200 / EVALIA Фургон", yearEnd: null, yearStart: "01.2010" },
      { carName: "1.5 dCi 90 (M20)", makeName: "NISSAN", modelName: "NV200 / EVALIA", yearEnd: null, yearStart: "01.2010" },
    ], columns).split("\n"),
    ["M20/M20M, dCi 90", "M20N/M20NN, dCi 110", "M20, dCi 90"],
  );
  assert.equal(
    formatApplicabilityVehicles([
      { carName: "1.6 (16V)", makeName: "PEUGEOT", modelName: "PARTNER", yearEnd: null, yearStart: "01.1996" },
    ], columns),
    "отсутствует, (16V)",
  );
  const nissanEvidence = buildApplicabilityVariantCodeContext([
    { carName: "1.5 dCi 90 (M20, M20M)", makeName: "NISSAN", modelName: "NV200 / EVALIA Bus (M2_)", yearEnd: null, yearStart: "01.2010" },
  ]);
  assert.equal(
    formatApplicabilityVehicles([
      { carName: "1.5 dCi 90 (M20, M20M)", makeName: "NISSAN", modelName: "NV200 / EVALIA Bus", yearEnd: null, yearStart: "01.2010" },
    ], columns, nissanEvidence),
    "M20/M20M, dCi 90",
  );
  const specificCodeEvidence = buildApplicabilityVariantCodeContext([
    { carName: "3.0", makeName: "TOYOTA", modelName: "AVALON (MCX10R)", yearEnd: "12.2004", yearStart: "01.2000" },
    { carName: "2.0", makeName: "MITSUBISHI", modelName: "L 300 III Фургон (P23W)", yearEnd: "12.1994", yearStart: "01.1986" },
    { carName: "2.0", makeName: "MITSUBISHI", modelName: "L 300 III Фургон (P23V)", yearEnd: "12.1994", yearStart: "01.1986" },
  ]);
  assert.deepEqual(
    formatApplicabilityVehicles([
      { carName: "3.0 (MCX10R)", makeName: "TOYOTA", modelName: "AVALON (X2)", yearEnd: "12.2004", yearStart: "01.2000" },
      { carName: "2.0 (P23W, P23V)", makeName: "MITSUBISHI", modelName: "L 300 III Фургон (P0_V, P1_V, P2_V)", yearEnd: "12.1994", yearStart: "01.1986" },
    ], columns, specificCodeEvidence).split("\n"),
    ["MCX10R, отсутствует", "P23W/P23V, отсутствует"],
  );
  assert.equal(
    formatApplicabilityVehicle({
      carName: "2.0 (EBL, EBS, ECL, EDS, EDL, EGL, ESS, ESL, EUS)",
      makeName: "FORD",
      modelName: "TRANSIT Bus (E_ _)",
      yearEnd: "12.1994",
      yearStart: "01.1986",
    }, columns),
    "EBL/EBS/ECL/EDS/EDL/EGL/ESS/ESL/EUS, отсутствует",
  );
});

test("applicability retains inferred body aliases in the model identity", () => {
  assert.equal(
    formatApplicabilityVehicle({
      carName: "1.6 HDi",
      makeName: "CITROËN",
      modelName: "C3 PICASSO (SH_)",
      yearEnd: null,
      yearStart: "01.2009",
    }),
    "Вэн, SH, CITROËN, C3 PICASSO, 2009-н.в., 1.6, HDi",
  );
  assert.equal(
    formatApplicabilityVehicle({
      carName: "2.0 HDi",
      makeName: "CITROËN",
      modelName: "XSARA PICASSO (N68)",
      yearEnd: null,
      yearStart: "01.1999",
    }),
    "Вэн, N68, CITROËN, XSARA PICASSO, 1999-н.в., 2.0, HDi",
  );
});

test("applicability keeps multiword body and marketing phrases atomic in model identity", () => {
  const cases = [
    ["MITSUBISHI", "SPACE WAGON (D0_V/W)", "Универсал", "SPACE WAGON"],
    ["OPEL", "ASTRA J Sports Tourer (P10)", "Универсал", "ASTRA J Sports Tourer"],
    ["FIAT", "STILO Multi Wagon (192)", "Универсал", "STILO Multi Wagon"],
    ["BMW", "4 Gran Coupe (F36)", "Купе", "4 Gran Coupe"],
    ["BMW", "2 Active Tourer (F45)", "Вэн", "2 Active Tourer"],
  ];

  cases.forEach(([makeName, modelName, expectedBodyType, expectedModelName]) => {
    assert.equal(
      formatApplicabilityVehicle({
        carName: "1.6",
        makeName,
        modelName,
        yearEnd: null,
        yearStart: "01.2010",
      }),
      `${expectedBodyType}, ${modelName.match(/\(([^()]+)\)/)?.[1].replaceAll("_", "").replace(/\s+/g, "")}, ${makeName}, ${expectedModelName}, 2010-н.в., 1.6, отсутствует`,
    );
  });
});

test("applicability repairs syntax of truncated car names without inventing data", () => {
  assert.equal(
    formatApplicabilityVehicle({
      carName: "16V (LS09, LS0L, LS0M, LS0P, LS0V, LS18, LS1S, LS1V,...",
      makeName: "TEST",
      modelName: "MODEL (X1)",
      yearEnd: null,
      yearStart: "01.2000",
    }, new Set(["carName"])),
    "16V (LS09, LS0L, LS0M, LS0P, LS0V, LS18, LS1S, LS1V, …)",
  );
  assert.equal(
    formatApplicabilityVehicle({
      carName: "16V (LS09, LS0L",
      makeName: "TEST",
      modelName: "MODEL (X1)",
      yearEnd: null,
      yearStart: "01.2000",
    }, new Set(["carName"])),
    "16V (LS09, LS0L, …)",
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
    "1119, LADA, KALINA, 2013, 1.6",
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
    "SUV/Внедорожник, OS, HYUNDAI, KONA, 2017-2023, 1.6, T-GDI",
  );
});

test("applicability discards truncated body-code tails from combined SUV names", () => {
  const cases = [
    ["KONA Автофургон / спортивно-утилитарный автомобиль (OS, OSE,", "KONA"],
    ["SANTA FÉ I Автофургон / спортивно-утилитарный автомобиль (SM", "SANTA FE I"],
    ["SANTA FÉ II Автофургон / спортивно-утилитарный автомобиль (C", "SANTA FE II"],
    ["SANTA FÉ III Автофургон / спортивно-утилитарный автомобиль (", "SANTA FE III"],
    ["SANTA FE IV Автофургон / спортивно-утилитарный автомобиль (T", "SANTA FE IV"],
  ];

  cases.forEach(([modelName, expectedModel]) => {
    assert.equal(
      formatApplicabilityVehicle({
        carName: "1.6",
        makeName: "HYUNDAI",
        modelName,
        yearEnd: "12.2020",
        yearStart: "01.2018",
      }),
      `SUV/Внедорожник, отсутствует, HYUNDAI, ${expectedModel}, 2018-2020, 1.6, отсутствует`,
    );
  });
});

test("applicability recognizes SW as a wagon without removing it from the model", () => {
  assert.equal(
    formatApplicabilityVehicle({
      carName: "1.6",
      makeName: "KIA",
      modelName: "CEE'D SW (ED)",
      yearEnd: "12.2012",
      yearStart: "01.2007",
    }),
    "Универсал, ED, KIA, CEE'D SW, 2007-2012, 1.6, отсутствует",
  );
});

test("applicability recognizes Sportswagon as a terminal wagon descriptor", () => {
  const cases = [
    ["CEE'D Sportswagon (JD)", "JD", "CEE'D"],
    ["CEED Sportswagon (CD)", "CD", "CEED"],
    ["OPTIMA Sportswagon (JF)", "JF", "OPTIMA"],
  ];

  cases.forEach(([modelName, bodyCode, expectedModel]) => {
    assert.equal(
      formatApplicabilityVehicle({
        carName: "1.7 CRDi",
        makeName: "KIA",
        modelName,
        yearEnd: "12.2020",
        yearStart: "01.2016",
      }),
      `Универсал, ${bodyCode}, KIA, ${expectedModel}, 2016-2020, 1.7, CRDi`,
    );
  });
});

test("applicability normalizes terminal FASTBACK and Cargo body descriptors", () => {
  const cases = [
    ["1.0", "HYUNDAI", "i30 FASTBACK (PDE, PDEN)", "Фастбэк, PDE/PDEN, HYUNDAI, i30"],
    ["1.0", "HYUNDAI", "i10 II Cargo (BA, IA)", "Автофургон / микроавтобус, BA/IA, HYUNDAI, i10 II"],
    ["1.2", "HYUNDAI", "i10 II Cargo (BA, IA)", "Автофургон / микроавтобус, BA/IA, HYUNDAI, i10 II"],
  ];

  cases.forEach(([carName, makeName, modelName, expected]) => {
    assert.equal(
      formatApplicabilityVehicle({ carName, makeName, modelName, yearEnd: null, yearStart: "01.2016" }),
      `${expected}, 2016-н.в., ${carName}, отсутствует`,
    );
  });
});

test("applicability retains a non-terminal FASTBACK descriptor in the model", () => {
  assert.equal(
    formatApplicabilityVehicle({
      carName: "1.0",
      makeName: "HYUNDAI",
      modelName: "i30 FASTBACK N (PDE)",
      yearEnd: null,
      yearStart: "01.2018",
    }),
    "Фастбэк, PDE, HYUNDAI, i30 FASTBACK N, 2018-н.в., 1.0, отсутствует",
  );
});

test("applicability recognizes KOUP as a non-removable coupe alias", () => {
  assert.equal(
    formatApplicabilityVehicle({
      carName: "1.6 T-GDI",
      makeName: "KIA",
      modelName: "CERATO KOUP III (YD)",
      yearEnd: null,
      yearStart: "01.2013",
    }),
    "Купе, YD, KIA, CERATO KOUP III, 2013-н.в., 1.6, T-GDI",
  );
});

test("applicability removes complete terminal compound van descriptors", () => {
  const cases = [
    ["HYUNDAI", "i20 II Hatchback Van (GB, IB)", "GB/IB", "i20 II"],
    ["KIA", "CEE'D Combi Van (ED)", "ED", "CEE'D"],
    ["HYUNDAI", "i30 Kombi Van (FD)", "FD", "i30"],
  ];

  cases.forEach(([makeName, modelName, bodyCode, expectedModel]) => {
    assert.equal(
      formatApplicabilityVehicle({ carName: "1.6", makeName, modelName, yearEnd: null, yearStart: "01.2013" }),
      `Автофургон / микроавтобус, ${bodyCode}, ${makeName}, ${expectedModel}, 2013-н.в., 1.6, отсутствует`,
    );
  });
});

test("applicability uses a compatible terminal car code to refine the body code", () => {
  const cases = [
    ["STARIA Bus (US4)", "2.2 CRDi (US4W)", "Автобус, US4W, HYUNDAI, STARIA, 2021-н.в., 2.2, CRDi"],
    ["SELTOS (SP2, SP2I)", "1.6 MPi (SP2)", "отсутствует, SP2, KIA, SELTOS, 2019-н.в., 1.6, MPI"],
    ["SPORTAGE IV (QL, QLE)", "1.6 LPG (QLE)", "отсутствует, QLE, KIA, SPORTAGE IV, 2018-н.в., 1.6, LPG"],
  ];

  cases.forEach(([modelName, carName, expected]) => {
    assert.equal(
      formatApplicabilityVehicle({ carName, makeName: modelName === "STARIA Bus (US4)" ? "HYUNDAI" : "KIA", modelName, yearEnd: null, yearStart: modelName === "STARIA Bus (US4)" ? "01.2021" : modelName.startsWith("SELTOS") ? "01.2019" : "01.2018" }),
      expected,
    );
  });
});

test("applicability retains an unrelated terminal car-name parenthesis", () => {
  assert.equal(
    formatApplicabilityVehicle({
      carName: "1.6 T-GDi (AWD)",
      makeName: "HYUNDAI",
      modelName: "KONA (OS)",
      yearEnd: null,
      yearStart: "01.2018",
    }),
    "отсутствует, OS, HYUNDAI, KONA, 2018-н.в., 1.6, T-GDI (AWD)",
  );
});

test("applicability formats a same-year period once", () => {
  assert.equal(
    formatApplicabilityVehicle({
      carName: "1.6",
      makeName: "KIA",
      modelName: "CEE'D (ED)",
      yearEnd: "12.2011",
      yearStart: "01.2011",
    }),
    "отсутствует, ED, KIA, CEE'D, 2011, 1.6, отсутствует",
  );
});

test("applicability canonicalizes known technical tokens without changing other text", () => {
  assert.equal(
    formatApplicabilityVehicle({
      carName: "1.6 t-gdi crdi mpi gdi hybrid GT Eco-Dynamics+ HTRAC",
      makeName: "KIA",
      modelName: "CEE'D (ED)",
      yearEnd: null,
      yearStart: "01.2011",
    }),
    "отсутствует, ED, KIA, CEE'D, 2011-н.в., 1.6, T-GDI CRDi MPI GDI HEV GT Eco-Dynamics+ HTRAC",
  );
});

test("applicability preserves a body-style word when it is part of a model name", () => {
  assert.equal(
    formatApplicabilityVehicle({
      carName: "1.6 16V",
      makeName: "HYUNDAI",
      modelName: "COUPE II (GK)",
      yearEnd: "12.2009",
      yearStart: "01.2002",
    }),
    "Купе, GK, HYUNDAI, COUPE II, 2002-2009, 1.6, 16V",
  );
});

test("applicability keeps a model whose entire name resembles a body style", () => {
  const cases = [
    ["NISSAN", "PICK UP (D22)", "D22", "PICK UP"],
    ["HYUNDAI", "COUPE (GK)", "GK", "COUPE"],
    ["TESLA", "ROADSTER (R1)", "R1", "ROADSTER"],
  ];

  cases.forEach(([makeName, modelName, bodyCode, expectedModel]) => {
    assert.equal(
      formatApplicabilityVehicle({ carName: "1.6", makeName, modelName, yearEnd: null, yearStart: "01.2010" }),
      `отсутствует, ${bodyCode}, ${makeName}, ${expectedModel}, 2010-н.в., 1.6, отсутствует`,
    );
  });
});

test("applicability extracts common body aliases without consuming model identity", () => {
  const cases = [
    ["BORA Variant (1J6)", "Универсал", "1J6", "BORA"],
    ["A4 Avant (8E)", "Универсал", "8E", "A4"],
    ["3 Touring (E46)", "Универсал", "E46", "3"],
    ["MEGANE Break (X84)", "Универсал", "X84", "MEGANE"],
    ["OPTIMA Wagon (JF)", "Универсал", "JF", "OPTIMA"],
    ["CEE'D Sportwagon (CD)", "Универсал", "CD", "CEE'D"],
    ["OCTAVIA Combi (1Z)", "Универсал", "1Z", "OCTAVIA"],
    ["GOLF Cabriolet (1E)", "Кабриолет", "1E", "GOLF"],
  ];

  cases.forEach(([modelName, expectedBodyType, bodyCode, expectedModel]) => {
    assert.equal(
      formatApplicabilityVehicle({ carName: "1.6", makeName: "VW", modelName, yearEnd: null, yearStart: "01.2010" }),
      `${expectedBodyType}, ${bodyCode}, VW, ${expectedModel}, 2010-н.в., 1.6, отсутствует`,
    );
  });
});

test("applicability classifies parenthetical groups without losing descriptions", () => {
  assert.equal(
    formatApplicabilityVehicle({
      carName: "2.0 CDI",
      makeName: "MERCEDES-BENZ",
      modelName: "VITO Mixto (Double Cabin) (W447)",
      yearEnd: null,
      yearStart: "01.2014",
    }),
    "отсутствует, W447, MERCEDES-BENZ, VITO Mixto (Double Cabin), 2014-н.в., 2.0, CDI",
  );

  assert.equal(
    formatApplicabilityVehicle({
      carName: "1.6",
      makeName: "TEST",
      modelName: "MODEL (Long Wheelbase) (E11, NE11) (C5_ - C8_)",
      yearEnd: null,
      yearStart: "01.2014",
    }),
    "отсутствует, E11/NE11/C5/C8, TEST, MODEL (Long Wheelbase), 2014-н.в., 1.6, отсутствует",
  );

  assert.equal(
    formatApplicabilityVehicle({
      carName: "1.6",
      makeName: "TEST",
      modelName: "MODEL (Saloon) (E11)",
      yearEnd: null,
      yearStart: "01.2014",
    }),
    "Седан, E11, TEST, MODEL, 2014-н.в., 1.6, отсутствует",
  );
});

test("applicability preserves compact terminal code expressions", () => {
  const cases = [
    ["PEUGEOT", "205 I (741A/C)", "741A/C"],
    ["HONDA", "ACCORD (20A/C)", "20A/C"],
    ["MITSUBISHI", "MODEL (2E/K)", "2E/K"],
    ["MERCEDES-BENZ", "MODEL (638/2)", "638/2"],
    ["TEST", "MODEL (XB-_)", "XB-"],
    ["TEST", "MODEL (ZA-_)", "ZA-"],
    ["TEST", "MODEL (V_)", "V"],
    ["TEST", "MODEL (M_)", "M"],
    ["TEST", "MODEL (G_)", "G"],
    ["TEST", "MODEL (P)", "P"],
    ["TEST", "MODEL (DBA-RG_)", "DBA-RG"],
    ["TEST", "MODEL (LA-RF_)", "LA-RF"],
    ["TEST", "MODEL (L03_P/G, L0_2P)", "L03P/G/L02P"],
  ];

  cases.forEach(([makeName, modelName, expectedCode]) => {
    assert.equal(
      formatApplicabilityVehicle({ carName: "1.6", makeName, modelName, yearEnd: null, yearStart: "01.2010" }),
      `отсутствует, ${expectedCode}, ${makeName}, ${modelName.slice(0, modelName.indexOf(" ("))}, 2010-н.в., 1.6, отсутствует`,
    );
  });
});

test("applicability removes a terminal Coupe body descriptor", () => {
  const cases = [
    ["GENESIS Coupe (BK)", "BK", "GENESIS"],
    ["i20 II Coupe (GB)", "GB", "i20 II"],
  ];

  cases.forEach(([modelName, bodyCode, expectedModel]) => {
    assert.equal(
      formatApplicabilityVehicle({
        carName: "1.6",
        makeName: "HYUNDAI",
        modelName,
        yearEnd: "12.2019",
        yearStart: "01.2015",
      }),
      `Купе, ${bodyCode}, HYUNDAI, ${expectedModel}, 2015-2019, 1.6, отсутствует`,
    );
  });
});

test("applicability reconciles only unambiguous truncated body-code fragments in one document", () => {
  const vehicle = (modelName, yearStart = "01.2018") => ({
    carName: "1.6",
    makeName: "HYUNDAI",
    modelName,
    yearEnd: "12.2020",
    yearStart,
  });

  assert.equal(
    formatApplicabilityVehicles([
      vehicle("SANTA FÉ I Автофургон / спортивно-утилитарный автомобиль (SM", "01.2000"),
      vehicle("SANTA FÉ I (SM)", "01.2000"),
      vehicle("SANTA FÉ II Автофургон / спортивно-утилитарный автомобиль (C"),
      vehicle("SANTA FÉ II (CM)"),
      vehicle("KONA Автофургон / спортивно-утилитарный автомобиль (OS, OSE,"),
      vehicle("KONA (OS, OSE)"),
      vehicle("SANTA FÉ III Автофургон / спортивно-утилитарный автомобиль ("),
    ]),
    [
      "SUV/Внедорожник, SM, HYUNDAI, SANTA FE I, 2000-2020, 1.6, отсутствует",
      "отсутствует, SM, HYUNDAI, SANTA FE I, 2000-2020, 1.6, отсутствует",
      "SUV/Внедорожник, CM, HYUNDAI, SANTA FE II, 2018-2020, 1.6, отсутствует",
      "отсутствует, CM, HYUNDAI, SANTA FE II, 2018-2020, 1.6, отсутствует",
      "SUV/Внедорожник, OS/OSE, HYUNDAI, KONA, 2018-2020, 1.6, отсутствует",
      "отсутствует, OS/OSE, HYUNDAI, KONA, 2018-2020, 1.6, отсутствует",
      "SUV/Внедорожник, отсутствует, HYUNDAI, SANTA FE III, 2018-2020, 1.6, отсутствует",
    ].join("\n"),
  );

  assert.equal(
    formatApplicabilityVehicles([
      vehicle("SANTA FÉ I Автофургон / спортивно-утилитарный автомобиль (C"),
      vehicle("SANTA FÉ I (CM)"),
      vehicle("SANTA FÉ I (CN)"),
    ]).split("\n")[0],
    "SUV/Внедорожник, отсутствует, HYUNDAI, SANTA FE I, 2018-2020, 1.6, отсутствует",
  );
});

test("applicability keeps complete codes from truncated terminal groups", () => {
  const vehicle = (modelName) => ({
    carName: "1.6",
    makeName: "VW",
    modelName,
    yearEnd: null,
    yearStart: "01.2010",
  });

  assert.equal(
    formatApplicabilityVehicles([
      vehicle("TRANSPORTER T4 c бортовой платформой/ходовая часть (70E, 70L"),
      vehicle("JUMPY I (BU_, BV_, BW_,"),
    ]),
    [
      "С бортовой платформой/ходовая часть, 70E/70L, VW, TRANSPORTER T4, 2010-н.в., 1.6, отсутствует",
      "отсутствует, BU/BV/BW, VW, JUMPY I, 2010-н.в., 1.6, отсутствует",
    ].join("\n"),
  );
});

test("applicability recovers only unambiguous incomplete terminal code tails", () => {
  const vehicle = (modelName) => ({
    carName: "1.6",
    makeName: "MERCEDES-BENZ",
    modelName,
    yearEnd: null,
    yearStart: "01.2018",
  });

  assert.equal(
    formatApplicabilityVehicles([
      vehicle("SPRINTER 3-t (B910)"),
      vehicle("SPRINTER 3-t (B907, B9"),
    ]).split("\n")[1],
    "отсутствует, B907/B910, MERCEDES-BENZ, SPRINTER 3-t, 2018-н.в., 1.6, отсутствует",
  );

  assert.equal(
    formatApplicabilityVehicles([
      vehicle("SPRINTER 3-t (B907)"),
      vehicle("SPRINTER 3-t (B910)"),
      vehicle("SPRINTER 3-t (B9"),
    ]).split("\n")[2],
    "отсутствует, отсутствует, MERCEDES-BENZ, SPRINTER 3-t, 2018-н.в., 1.6, отсутствует",
  );
});

test("applicability canonicalizes compound technology and drivetrain terms", () => {
  const vehicle = (carName) => ({
    carName,
    makeName: "HYUNDAI",
    modelName: "KONA (OS)",
    yearEnd: null,
    yearStart: "01.2020",
  });

  assert.equal(
    formatApplicabilityVehicle(vehicle("1.6 T-GDi Plug-in-Hybrid 48V-Hybrid All-wheel Drive")),
    "отсутствует, OS, HYUNDAI, KONA, 2020-н.в., 1.6, T-GDI Plug-in Hybrid MHEV 48V AWD",
  );
  assert.equal(
    formatApplicabilityVehicle(vehicle("1.6 T-GDI Plug-in Hybrid Hybrid 48V AWD")),
    "отсутствует, OS, HYUNDAI, KONA, 2020-н.в., 1.6, T-GDI Plug-in Hybrid MHEV 48V AWD",
  );
});

test("applicability canonicalizes electrification aliases without collapsing distinct powertrains", () => {
  const characteristic = (carName) => formatApplicabilityVehicle({
    carName,
    makeName: "HYUNDAI",
    modelName: "KONA (OS)",
    yearEnd: null,
    yearStart: "01.2020",
  }, new Set(["carName"]));

  ["PHEV", "Plug-in Hybrid", "Plug in Hybrid", "Plug-in-Hybrid"].forEach((alias) => {
    assert.equal(characteristic(`1.6 T-GDI ${alias} HTRAC`), "T-GDI Plug-in Hybrid HTRAC");
  });
  ["EV", "Electric", "ELECTRIC"].forEach((alias) => {
    assert.equal(characteristic(`1.6 ${alias} AWD`), "EV AWD");
  });
  assert.equal(characteristic("1.6 EV Electric"), "EV");
  assert.equal(characteristic("1.6 Fuel Cell"), "FCEV");
  assert.equal(characteristic("1.6 Hydrogen Fuel Cell"), "FCEV");
  assert.equal(characteristic("1.6 FCEV"), "FCEV");
  assert.equal(characteristic("1.6 GDI HEV"), "GDI HEV");
  assert.equal(characteristic("1.6 GDI Hybrid"), "GDI HEV");
  ["Hybrid 48V", "48V Hybrid", "48V-Hybrid"].forEach((alias) => {
    assert.equal(characteristic(`1.6 T-GDI ${alias}`), "T-GDI MHEV 48V");
  });
  assert.equal(characteristic("1.6 T-GDI MHEV"), "T-GDI MHEV");
  assert.equal(characteristic("1.6 E-NIRO"), "E-NIRO");
});

test("applicability canonicalizes exact technical aliases, drivetrain, and SANTA FE display", () => {
  const vehicle = (carName, modelName = "SANTA FÉ III (DM)") => ({
    carName,
    makeName: "HYUNDAI",
    modelName,
    yearEnd: null,
    yearStart: "01.2012",
  });

  assert.equal(
    formatApplicabilityVehicle(vehicle("2.4 CCVT TGDI VVTi VVT-I VVT i 4x4")),
    "отсутствует, DM, HYUNDAI, SANTA FE III, 2012-н.в., 2.4, CVVT T-GDI VVT-i VVT-i VVT-i 4WD",
  );
  assert.equal(
    formatApplicabilityVehicle(vehicle("2.4 4WD", "GRAND SANTA FÉ (NC)")),
    "отсутствует, NC, HYUNDAI, GRAND SANTA FE, 2012-н.в., 2.4, 4WD",
  );
});

test("applicability retains transmission designations in the optional modification", () => {
  const vehicle = (carName) => ({
    carName,
    makeName: "KIA",
    modelName: "CEED (CD)",
    yearEnd: null,
    yearStart: "01.2020",
  });
  const columns = new Set(["capacity", "carName"]);

  assert.equal(formatApplicabilityVehicle(vehicle("1.6 T-GDI 7DCT Automatic GT"), columns), "1.6, T-GDI 7DCT Automatic GT");
  assert.equal(formatApplicabilityVehicle(vehicle("2.0 CRDi 8AT AWD"), columns), "2.0, CRDi 8AT AWD");
  assert.equal(formatApplicabilityVehicle(vehicle("1.6 MPI 6M/T"), columns), "1.6, MPI 6M/T");
  assert.equal(formatApplicabilityVehicle(vehicle("2.0 CVT AWD"), columns), "2.0, CVT AWD");
});
