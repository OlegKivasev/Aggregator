import assert from "node:assert/strict";
import { test } from "node:test";
import { applicabilityFileMaxBytes, decodeApplicabilityFile, parseApplicabilityFile } from "../src/frontend/applicability-file-import.js";

const makes = ["HYUNDAI", "LAND ROVER", "FORD", "ЛАДА"];

test("applicability file retains article/brand pairs and source line numbers", () => {
  const rows = parseApplicabilityFile("\uFEFF12345 | Hyundai\r\n12345 | Land Rover\r\n\r\nAP 108/6 | ford\nAA-1 | ЛАДА", makes);
  assert.deepEqual(rows, [
    { lineNumber: 1, sku: "12345", brand: "HYUNDAI", error: "" },
    { lineNumber: 2, sku: "12345", brand: "LAND ROVER", error: "" },
    { lineNumber: 4, sku: "AP 108/6", brand: "FORD", error: "" },
    { lineNumber: 5, sku: "AA-1", brand: "ЛАДА", error: "" },
  ]);
});

test("applicability file skips normalized duplicates only within the same brand", () => {
  const rows = parseApplicabilityFile("AA-1 | ford\nAA1 | FORD\nAA1 | HYUNDAI\nAA2 | land   rover", makes);
  assert.equal(rows[0].error, "");
  assert.equal(rows[1].error, "Повтор в файле");
  assert.equal(rows[2].error, "");
  assert.equal(rows[3].brand, "LAND ROVER");
});

test("applicability file reports invalid rows while retaining valid rows", () => {
  const rows = parseApplicabilityFile([
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
  const rows = Array.from({ length: 500 }, (_, index) => `AA${index} | FORD`);
  assert.equal(parseApplicabilityFile(rows.join("\n"), makes).length, 500);
  assert.throws(() => parseApplicabilityFile([...rows, "AA500 | FORD"].join("\n"), makes), /500/);
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
