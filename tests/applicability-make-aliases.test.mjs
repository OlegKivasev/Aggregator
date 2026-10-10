import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createApplicabilityMakeMatcher } from "../src/frontend/applicability-make-aliases.js";

const makes = JSON.parse(await readFile(new URL("../src/frontend/applicability-makes.json", import.meta.url), "utf8"));
const matcher = createApplicabilityMakeMatcher(makes.map((make) => make.makeName));

test("make aliases resolve common Latin and Cyrillic spellings to existing catalog names", () => {
  const pairs = [
    ["Volkswagen", "VW"], ["фольксваген", "VW"], ["Citroen", "CITROËN"], ["ситроен", "CITROËN"],
    ["Mercedes Benz", "MERCEDES-BENZ"], ["MB", "MERCEDES-BENZ"], ["Мерседес", "MERCEDES-BENZ"],
    ["FoMoCo", "FORD"], ["Ford Motor Company", "FORD"], ["ГАЗ", "GAZ"], ["ВАЗ", "LADA"],
    ["Лада", "LADA"], ["УАЗ", "UAZ"], ["Хёндай", "HYUNDAI"], ["Хундай", "HYUNDAI"], ["Киа", "KIA"],
    ["Chevy", "CHEVROLET"], ["альфа-ромео", "ALFA ROMEO"], ["Škoda", "SKODA"], ["LandRover", "LAND ROVER"],
    ["GWM", "GREAT WALL"], ["Джили", "GEELY"], ["Чанган", "CHANGAN"], ["Джип", "JEEP"],
    ["Мицубиси", "MITSUBISHI"], ["БМВ", "BMW"], ["Li Auto", "LIXIANG"], ["KGM", "KG MOBILITY"],
  ];
  for (const [alias, name] of pairs) assert.equal(matcher.resolve(alias), name, alias);
  for (const make of makes) assert.equal(matcher.resolve(make.makeName), make.makeName);
});

test("aliases support partial picker queries and preserve catalog subdivisions", () => {
  assert.ok(matcher.matches("VW", "Volks"));
  assert.ok(matcher.matches("VW (FAW)", "Volkswagen"));
  assert.ok(matcher.matches("CITROËN", "ситро"));
  assert.ok(matcher.matches("MERCEDES-BENZ", "mercedes benz"));
  assert.equal(matcher.resolve("Volkswagen (FAW)"), "VW (FAW)");
  assert.equal(matcher.resolve("Ситроен (DF-PSA)"), "CITROËN (DF-PSA)");
  assert.equal(matcher.resolve("Форд USA"), "FORD USA");
  assert.equal(matcher.resolve("Рено Тракс"), "RENAULT TRUCKS");
  assert.equal(matcher.matches("FORD USA", "Fomoco"), true);
  assert.equal(matcher.resolve("Volkswagen UNKNOWN"), null);
});

test("distinct makes and ambiguous aliases cannot silently resolve to another make", () => {
  assert.equal(matcher.resolve("GM"), null);
  assert.equal(matcher.resolve("General Motors"), null);
  assert.equal(matcher.resolve("VAG"), null);
  assert.equal(matcher.resolve("SSANGYONG"), "SSANGYONG");
  assert.equal(matcher.resolve("KG MOBILITY"), "KG MOBILITY");
  assert.equal(matcher.matches("CHEVROLET", "GMC"), false);
  assert.equal(matcher.matches("HAVAL", "Great Wall"), false);
  const ambiguous = createApplicabilityMakeMatcher(["VW", "VOLKSWAGEN"]);
  assert.equal(ambiguous.resolve("VW"), "VW");
  assert.equal(ambiguous.resolve("Volkswagen"), "VOLKSWAGEN");
  assert.equal(ambiguous.resolve("Фольксваген"), null);
  assert.equal(matcher.resolve("FOR\u0000D"), null);
  assert.equal(matcher.resolve(null), null);
});
