import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { NomenclatureService } from "../src/backend/nomenclature/nomenclature-service.ts";
import { parseStockResult } from "../src/backend/nomenclature/stock-contract.ts";

if (!process.argv[2]) throw new Error("Usage: node scripts/verify-onec-display-text.mjs <extension-directory>");
const root = resolve(process.argv[2]) + "/";
const path = "CommonModules/АС_НоменклатураАгрегатора/Ext/Module.bsl";
const bytes = readFileSync(root + path);
const source = bytes.toString("utf8");
const dump = readFileSync(root + "ConfigDumpInfo.xml", "utf8");
assert.equal(bytes.subarray(0, 3).toString("hex"), "efbbbf");
assert.equal((source.match(/\r\n/g) || []).length, (source.match(/\n/g) || []).length);
assert.equal(/<Metadata name="CommonModule\.АС_НоменклатураАгрегатора\.Module"[^>]*configVersion="([a-f0-9]+)"/.exec(dump)?.[1], createHash("sha1").update(bytes).digest("hex"));

// Restricted execution model for the actual string helper, not a 1C platform run.
// Unsupported BSL statements fail this check rather than being skipped.
const helperStart = source.indexOf("Функция ПроверитьТекст(");
assert.ok(helperStart >= 0, "Display helper must exist in the supplied extension");
const helper = source.slice(helperStart);
const expression = (text) => text.replaceAll("Неопределено", "undefined").replaceAll("Ложь", "false").replaceAll("Истина", "true")
  .replaceAll("Новый Массив", "[]").replaceAll(".Добавить(", ".push(");
const condition = (text) => expression(text).replaceAll("<>", "!==").replace(/(?<![<>!=])=(?!=)/g, "===")
  .replace(/(^|\s)Не\s/g, "$1! ").replace(/\sИли\s/g, " || ").replace(/\sИ\s/g, " && ");
let generated = "";
const variables = new Set();
function statement(text) {
  if (!text) return "";
  if (text.startsWith("Если ")) {
    const match = /^Если (.*?) Тогда\s*(.*)$/.exec(text);
    assert.ok(match, text);
    const tail = match[2];
    return `if (${condition(match[1])}) { ${tail ? statement(tail.replace(/\s*КонецЕсли;$/, "")) + "}" : ""}`;
  }
  if (text === "КонецЕсли;") return "}";
  if (text === "КонецЦикла;") return "}";
  const loop = /^Для (\w+|[А-Яа-я]+) = (.*?) По (.*?) Цикл$/.exec(text);
  if (loop) { variables.add(loop[1]); return `for (${loop[1]}=${expression(loop[2])}; ${loop[1]}<=${expression(loop[3])}; ${loop[1]}++) {`; }
  if (text.startsWith("ВызватьИсключение ")) return `throw new Error(${text.slice(18).replace(/;$/, "")});`;
  if (text.startsWith("Возврат ")) return "return " + expression(text.slice(8));
  const assignment = /^([А-Яа-яA-Za-z_]+) = (.*);$/.exec(text);
  if (assignment) { variables.add(assignment[1]); return assignment[1] + "=" + expression(assignment[2]) + ";"; }
  if (/^Фрагменты\.Добавить\(Фрагмент\);$/.test(text)) return expression(text);
  throw new Error("Unsupported statement: " + text);
}
for (const raw of helper.split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith("//") || line.startsWith("Функция ")) continue;
  if (line === "КонецФункции") break;
  generated += statement(line) + "\n";
}
variables.delete("Значение");
const prepare = new Function("СокрЛП", "СтрДлина", "КодСимвола", "Сред", "ЗначениеЗаполнено", "СтрСоединить",
  `"use strict"; return function(Значение,Максимум,РазрешитьПустое=false,ДляОтображения=false) {let ${[...variables].join(",")};\n${generated}}`)(
  (value) => value.trim(), (value) => value.length, (value, index) => value.charCodeAt(index - 1),
  (value, start, length) => length === undefined ? value.slice(start - 1) : value.slice(start - 1, start - 1 + length),
  (value) => typeof value === "string" && value.trim().length > 0, (parts, separator) => parts.join(separator));

assert.equal(prepare("Колодки тормозные", 500, false, true), "Колодки тормозные");
assert.equal(prepare("Колодки\r\n\t  тормозные", 500, false, true), "Колодки тормозные");
assert.equal(prepare("\u0000\tНазвание\u0085\u007f", 500, false, true), "Название");
assert.equal(prepare("0000123\tA", 50, true, true), "0000123 A");
assert.equal(prepare("\u0000\r\n", 50, true, true), "");
assert.throws(() => prepare("\u0000\r\n", 500, false, true));
assert.throws(() => prepare("x".repeat(501), 500, false, true));
for (const code of [...Array.from({ length: 32 }, (_, i) => i), ...Array.from({ length: 33 }, (_, i) => i + 127)]) {
  assert.equal(prepare("A" + String.fromCharCode(code) + "B", 500, false, true), "A B");
  assert.throws(() => prepare("A" + String.fromCharCode(code) + "B", 100));
}
assert.equal(prepare('<img src=x onerror="x">', 500, false, true), '<img src=x onerror="x">');
assert.ok(source.includes("ПроверитьТекст(СтрокаПоиска, 100, Истина)"));
assert.ok(source.includes("ПроверитьТекст(Выборка.Наименование, 500, Ложь, Истина)"));
assert.ok(source.includes("ПроверитьТекст(Выборка.Артикул, 50, Истина, Истина)"));
const stock = source.slice(source.indexOf("Функция ТоварыВНаличии("), source.indexOf("Функция ШаблонПодстроки("));
assert.equal((stock.match(/Запрос\.Выполнить\(/g) || []).length, 1);

const directory = await mkdtemp(join(tmpdir(), "stock-text-check-"));
const service = new NomenclatureService(join(directory, "database.sqlite"));
try {
  const token = service.rotateKey(); service.heartbeat(token);
  const waiting = service.loadStock(null, new AbortController().signal, "кол торм");
  const job = service.claim(token, true, true, true);
  const products = Array.from({ length: 100 }, (_, index) => ({ id: randomUUID(),
    name: prepare(`Колодки ${index}\r\n\t тормозные`, 500, false, true),
    article: prepare(`0000${index}\u0000A`, 50, true, true), quantity: index + 0.125 }));
  service.completeStock(token, parseStockResult({ requestId: job.id, leaseId: job.leaseId, status: "completed", products, hasMore: true }));
  assert.deepEqual((await waiting).products, products);
} finally {
  service.close();
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  assert.ok(basename(directory).startsWith("stock-text-check-"));
  await rm(directory, { recursive: true, force: true });
}
console.log("Source helper execution model: 65 control codes, CRLF/tab runs, strict query, empty/oversized values, leading zeros OK.");
console.log("100 normalized rows accepted atomically by real SQLite service. Static stock path: 1 register query. 1C platform not run.");
