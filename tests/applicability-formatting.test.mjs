import assert from "node:assert/strict";
import { test } from "node:test";
import { formatApplicabilityVehicle, formatApplicabilityVehicles } from "../src/frontend/applicability-formatting.js";

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
    ["SANTA FÉ I Автофургон / спортивно-утилитарный автомобиль (SM", "SANTA FÉ I"],
    ["SANTA FÉ II Автофургон / спортивно-утилитарный автомобиль (C", "SANTA FÉ II"],
    ["SANTA FÉ III Автофургон / спортивно-утилитарный автомобиль (", "SANTA FÉ III"],
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

test("applicability recognizes Sportswagon as a wagon without removing it from the model", () => {
  const cases = [
    ["CEE'D Sportswagon (JD)", "JD", "CEE'D Sportswagon"],
    ["CEED Sportswagon (CD)", "CD", "CEED Sportswagon"],
    ["OPTIMA Sportswagon (JF)", "JF", "OPTIMA Sportswagon"],
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
    "отсутствует, ED, KIA, CEE'D, 2011-н.в., 1.6, T-GDI CRDi MPI GDI Hybrid GT Eco-Dynamics+ HTRAC",
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
      "SUV/Внедорожник, SM, HYUNDAI, SANTA FÉ I, 2000-2020, 1.6, отсутствует",
      "отсутствует, SM, HYUNDAI, SANTA FÉ I, 2000-2020, 1.6, отсутствует",
      "SUV/Внедорожник, CM, HYUNDAI, SANTA FÉ II, 2018-2020, 1.6, отсутствует",
      "отсутствует, CM, HYUNDAI, SANTA FÉ II, 2018-2020, 1.6, отсутствует",
      "SUV/Внедорожник, OS/OSE, HYUNDAI, KONA, 2018-2020, 1.6, отсутствует",
      "отсутствует, OS/OSE, HYUNDAI, KONA, 2018-2020, 1.6, отсутствует",
      "SUV/Внедорожник, отсутствует, HYUNDAI, SANTA FÉ III, 2018-2020, 1.6, отсутствует",
    ].join("\n"),
  );

  assert.equal(
    formatApplicabilityVehicles([
      vehicle("SANTA FÉ I Автофургон / спортивно-утилитарный автомобиль (C"),
      vehicle("SANTA FÉ I (CM)"),
      vehicle("SANTA FÉ I (CN)"),
    ]).split("\n")[0],
    "SUV/Внедорожник, отсутствует, HYUNDAI, SANTA FÉ I, 2018-2020, 1.6, отсутствует",
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
    "отсутствует, OS, HYUNDAI, KONA, 2020-н.в., 1.6, T-GDI Plug-in Hybrid Hybrid 48V AWD",
  );
  assert.equal(
    formatApplicabilityVehicle(vehicle("1.6 T-GDI Plug-in Hybrid Hybrid 48V AWD")),
    "отсутствует, OS, HYUNDAI, KONA, 2020-н.в., 1.6, T-GDI Plug-in Hybrid Hybrid 48V AWD",
  );
});

test("applicability detects only explicit transmission aliases with deterministic priority", () => {
  const transmission = (carName) => formatApplicabilityVehicle({
    carName,
    makeName: "KIA",
    modelName: "CEED (CD)",
    yearEnd: null,
    yearStart: "01.2020",
  }, new Set(["transmission"]));

  assert.equal(transmission("1.6 6M/T"), "Механика");
  assert.equal(transmission("1.6 3-speed manual"), "Механика");
  assert.equal(transmission("1.6 8AT"), "АКПП");
  assert.equal(transmission("2.0 8-speed automatic"), "АКПП");
  assert.equal(transmission("2.0 ZF 8HP"), "АКПП");
  assert.equal(transmission("2.0 300 HP"), "отсутствует");
  assert.equal(transmission("1.6 7DCT automatic"), "Робот");
  assert.equal(transmission("1.6 5AMT"), "Робот");
  assert.equal(transmission("1.6 CVT automatic"), "Вариатор");
  assert.equal(transmission("1.6 C.V.T."), "Вариатор");
  assert.equal(transmission("1.6 e-CVT"), "Вариатор");
  assert.equal(transmission("1.6 Steptronic DCT"), "Робот");
  assert.equal(transmission("1.6 7G-Tronic"), "АКПП");
  assert.equal(transmission("1.6 AWD 4WD 4x4 HTRAC"), "отсутствует");
  assert.equal(transmission("1.6 CVT DCT"), "отсутствует");
  assert.equal(transmission("1.6 CVVT"), "отсутствует");
  assert.equal(transmission("1.6 INVECS-III"), "отсутствует");
  assert.equal(transmission("1.6 INVECS-III CVT"), "Вариатор");
});

test("applicability removes only recognized transmission aliases from the characteristic", () => {
  const vehicle = (carName) => ({
    carName,
    makeName: "KIA",
    modelName: "CEED (CD)",
    yearEnd: null,
    yearStart: "01.2020",
  });
  const columns = new Set(["capacity", "transmission", "carName"]);

  assert.equal(formatApplicabilityVehicle(vehicle("1.6 T-GDI 7DCT Automatic GT"), columns), "1.6, Робот, T-GDI GT");
  assert.equal(formatApplicabilityVehicle(vehicle("2.0 CRDi 8AT AWD"), columns), "2.0, АКПП, CRDi AWD");
  assert.equal(formatApplicabilityVehicle(vehicle("1.6 MPI 6M/T"), columns), "1.6, Механика, MPI");
  assert.equal(formatApplicabilityVehicle(vehicle("2.0 CVT AWD"), columns), "2.0, Вариатор, AWD");
  assert.equal(formatApplicabilityVehicle(vehicle("1.6 7DCT Automatic GT"), columns), "1.6, Робот, GT");
  assert.equal(formatApplicabilityVehicle(vehicle("1.6 CVT DCT AWD"), columns), "1.6, отсутствует, CVT DCT AWD");
});
