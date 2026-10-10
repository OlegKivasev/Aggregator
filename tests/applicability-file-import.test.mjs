import assert from "node:assert/strict";
import { test } from "node:test";
import { applicabilityFileMaxBytes, decodeApplicabilityFile, parseApplicabilityFile } from "../src/frontend/applicability-file-import.js";

const makes = ["HYUNDAI", "LAND ROVER", "FORD", "ЛАДА"];

test("applicability file retains article/brand pairs and source line numbers", () => {
  const { articles, rows } = parseApplicabilityFile("\uFEFF12345 | Hyundai\r\n12345 | Land Rover\r\n\r\nAP 108/6 | ford\nAA-1 | ЛАДА", makes);
  assert.deepEqual(articles, []);
  assert.deepEqual(rows, [
    { lineNumber: 1, sku: "12345", brand: "HYUNDAI", error: "" },
    { lineNumber: 2, sku: "12345", brand: "LAND ROVER", error: "" },
    { lineNumber: 4, sku: "AP 108/6", brand: "FORD", error: "" },
    { lineNumber: 5, sku: "AA-1", brand: "ЛАДА", error: "" },
  ]);
});

test("applicability file skips normalized duplicates only within the same brand", () => {
  const { rows } = parseApplicabilityFile("AA-1 | ford\nAA1 | FORD\nAA1 | HYUNDAI\nAA2 | land   rover", makes);
  assert.equal(rows[0].error, "");
  assert.equal(rows[1].error, "Повтор в файле");
  assert.equal(rows[2].error, "");
  assert.equal(rows[3].brand, "LAND ROVER");
});

test("applicability file reports invalid rows while retaining valid rows", () => {
  const { rows } = parseApplicabilityFile([
    "MISSING", "AA1 | Unknown", "AA2 |", "| FORD", "AA3 | FORD | EXTRA",
    "AA4,AA5 | FORD", "AA6,AA6 | FORD", "--- | FORD", "AA\u0000BB | FORD",
    `${"A".repeat(129)} | FORD`, "AA7 | FO\u0000RD", "AA8 | FORD",
  ].join("\n"), makes);
  assert.ok(rows.slice(0, -1).every((row) => row.error));
  assert.equal(rows.at(-1).error, "");
  assert.equal(rows[1].error, "Бренд не найден в списке.");
});

test("applicability file rejects empty and oversized inputs without partial imports", () => {
  assert.throws(() => parseApplicabilityFile("\uFEFF\r\n  \n", makes), /не содержит/);
  assert.throws(() => parseApplicabilityFile("A".repeat(applicabilityFileMaxBytes + 1), makes), /1 МБ/);
  assert.throws(() => decodeApplicabilityFile(new Uint8Array(applicabilityFileMaxBytes + 1)), /1 МБ/);
  const rows = Array.from({ length: 5000 }, (_, index) => `AA${index} | FORD`);
  assert.equal(parseApplicabilityFile(rows.join("\n"), makes).rows.length, 5000);
  assert.throws(() => parseApplicabilityFile([...rows, "AA5000 | FORD"].join("\n"), makes), /5000/);
});

test("structured file separates source articles from OEMs and deduplicates within each article", () => {
  const { articles, rows } = parseApplicabilityFile([
    "\uFEFFАртикул: PART-1", "OEM-артикул: OE-1 | Volkswagen", "OEM-артикул: OE1 | VW",
    "OEM-артикул: OE-1 | Audi", "", "Артикул: PART-2", "OEM-артикул: OE1 | Фольксваген",
    "Артикул: PART1", "OEM-артикул: OE2 | Citroen",
  ].join("\r\n"), ["VW", "AUDI", "CITROËN"]);
  assert.deepEqual(articles, ["PART-1", "PART-2"]);
  assert.deepEqual(rows.map(({ lineNumber, article, sku, brand, error }) => ({ lineNumber, article, sku, brand, error })), [
    { lineNumber: 2, article: "PART-1", sku: "OE-1", brand: "VW", error: "" },
    { lineNumber: 3, article: "PART-1", sku: "OE1", brand: "VW", error: "Повтор в файле" },
    { lineNumber: 4, article: "PART-1", sku: "OE-1", brand: "AUDI", error: "" },
    { lineNumber: 7, article: "PART-2", sku: "OE1", brand: "VW", error: "" },
    { lineNumber: 9, article: "PART-1", sku: "OE2", brand: "CITROËN", error: "" },
  ]);
});

test("invalid source headers clear the previous block and orphan OEMs are skipped", () => {
  const { articles, rows } = parseApplicabilityFile([
    "OEM-артикул: ORPHAN | FORD", "Артикул: VALID1", "OEM-артикул: OE1 | FORD",
    "Артикул: ---", "OEM-артикул: OE2 | FORD", "Артикул: AA,BB", "Артикул:",
    "Артикул: VALID2", "OEM-артикул: OE3 | FORD",
  ].join("\n"), makes);
  assert.deepEqual(articles, ["VALID1", "VALID2"]);
  assert.deepEqual(rows.filter((row) => !row.error).map((row) => [row.article, row.sku]), [["VALID1", "OE1"], ["VALID2", "OE3"]]);
  assert.ok(rows.filter((row) => row.error).every((row) => row.article === null));
  assert.throws(() => parseApplicabilityFile("Артикул: NO-OEM", makes), /не содержит/);
  const blocks = Array.from({ length: 101 }, (_, i) => `Артикул: PART${i}\nOEM-артикул: OE${i} | FORD`).join("\n");
  assert.throws(() => parseApplicabilityFile(blocks, makes), /100 исходных/);
});

test("file aliases use catalog names and ambiguous parent brands need an explicit make", () => {
  const { rows } = parseApplicabilityFile("OE1 | Volkswagen\nOE2 | Citroen\nOE3 | ГАЗ\nOE4 | Fomoco\nOE5 | GM", ["VW", "CITROËN", "GAZ", "FORD", "CHEVROLET", "GMC"]);
  assert.deepEqual(rows.slice(0, 4).map((row) => row.brand), ["VW", "CITROËN", "GAZ", "FORD"]);
  assert.ok(rows.slice(0, 4).every((row) => !row.error));
  assert.match(rows[4].error, /конкретный бренд/);
});

test("applicability file decodes UTF-8, BOM-prefixed UTF-16 and Windows-1251 Cyrillic", () => {
  const text = "12345 | ЛАДА";
  assert.equal(decodeApplicabilityFile(Buffer.from(text)), text);
  assert.equal(decodeApplicabilityFile(Buffer.from(`\uFEFF${text}`)), text);
  const utf16 = Buffer.from(`\uFEFF${text}`, "utf16le");
  assert.equal(decodeApplicabilityFile(utf16), text);
  assert.equal(decodeApplicabilityFile(Buffer.from(utf16).swap16()), text);
  assert.equal(decodeApplicabilityFile(Buffer.concat([Buffer.from("12345 | "), Buffer.from([0xcb, 0xc0, 0xc4, 0xc0])])), text);
  assert.throws(() => decodeApplicabilityFile(Buffer.from([0xff, 0xfe, 0x41])));
});
