import assert from "node:assert/strict";
import { test } from "node:test";
import { filterRepairCards } from "../src/frontend/repair-search.js";

const cards = [
  { number: "ЗН-1", vehicleName: "Ford Focus | А 123 ВС 163", counterpartyName: "ООО Автопарк" },
  { number: "ЗН-2", vehicleName: "Toyota Camry | В456ЕН63" },
  { number: "ЗН-3", vehicleName: "Лада Гранта | Е789КМ163", counterpartyName: "ООО Ёлочка" },
];

test("repair search matches vehicle details, mixed alphabet registration, organization and order number", () => {
  for (const query of ["focus", "FORD 123", "а123вс163", "A123BC163", "а 123 вс 163", "автопарк", "зн-1"]) {
    assert.deepEqual(filterRepairCards(cards, query), [cards[0]], query);
  }
  assert.deepEqual(filterRepairCards(cards, "camry b456eh63"), [cards[1]]);
  assert.deepEqual(filterRepairCards(cards, "елочка гранта"), [cards[2]]);
});

test("repair search retains source data and excludes cards unless all query terms match", () => {
  assert.equal(filterRepairCards(cards, "  "), cards);
  assert.equal(filterRepairCards(cards, " | "), cards);
  assert.deepEqual(filterRepairCards(cards, "Ford 456"), []);
  assert.deepEqual(filterRepairCards(cards, "неизвестная машина"), []);
  assert.equal(cards[0].vehicleName, "Ford Focus | А 123 ВС 163");
});
