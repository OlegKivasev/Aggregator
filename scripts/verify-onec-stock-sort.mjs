import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

if (!process.argv[2]) throw new Error("Usage: node scripts/verify-onec-stock-sort.mjs <extension-directory>");
const root = resolve(process.argv[2]);
const dump = readFileSync(join(root, "ConfigDumpInfo.xml"), "utf8");
const modules = new Map();
for (const name of ["АС_АгрегаторСервер", "АС_НоменклатураАгрегатора"]) {
  const bytes = readFileSync(join(root, "CommonModules", name, "Ext/Module.bsl"));
  const source = bytes.toString("utf8"); modules.set(name, source);
  assert.equal(bytes.subarray(0, 3).toString("hex"), "efbbbf");
  assert.equal((source.match(/\r\n/g) || []).length, (source.match(/\n/g) || []).length);
  const version = new RegExp(`<Metadata name="CommonModule\\.${name}\\.Module"[^>]*configVersion="([a-f0-9]+)"`).exec(dump)?.[1];
  assert.equal(version, createHash("sha1").update(bytes).digest("hex"));
  // Lexical block balance, not a compiler or platform validation.
  let code = ""; let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"') {
      if (quoted && source[index + 1] === '"') { index += 1; continue; }
      quoted = !quoted; code += " "; continue;
    }
    if (!quoted && char === "/" && source[index + 1] === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      code += "\n"; continue;
    }
    if (!quoted) code += char;
  }
  assert.equal(quoted, false, "Unterminated BSL string");
  const stack = [];
  const blocks = { Если: "КонецЕсли", Попытка: "КонецПопытки", Функция: "КонецФункции", Процедура: "КонецПроцедуры", Для: "КонецЦикла", Пока: "КонецЦикла" };
  const endings = new Set(Object.values(blocks));
  for (const token of code.replace(/^\s*#.*$/gm, "").match(/[\p{L}_][\p{L}\p{N}_]*/gu) ?? []) {
    if (blocks[token]) stack.push(blocks[token]);
    else if (endings.has(token)) assert.equal(stack.pop(), token, `${name}: ${token}`);
  }
  assert.deepEqual(stack, []);
}
const source = modules.get("АС_НоменклатураАгрегатора");
const stock = source.slice(source.indexOf("Функция ТоварыВНаличии("), source.indexOf("Процедура ПроверитьВидЦен("));
assert.match(stock, /ПЕРВЫЕ 101/);
assert.equal((stock.match(/Запрос\.Выполнить\(/g) || []).length, 1);
assert.doesNotMatch(stock, /ПолучитьОбъект\(|СМЕЩЕНИЕ|OFFSET|(?<!\.)КОЛИЧЕСТВО\(/i);
assert.match(stock, /Сравнение = \?\(НаправлениеСортировки = "desc", "<", ">"\)/);
assert.match(stock, /Порядок = Порядок \+ ", Номенклатура"/);
assert.match(stock, /ИначеЕсли ПолеСортировки <> "quantity" Тогда[\s\S]*?Найденные\.Ссылка > &ПослеНоменклатуры/);
assert.match(stock, /Если ЕстьКурсор И ПолеСортировки = "quantity" Тогда[\s\S]*?УсловиеИтога = УсловиеИтога \+[\s\S]*?СУММА\(Остатки\.КоличествоОстаток\)[\s\S]*?Остатки\.Номенклатура > &ПослеНоменклатуры/);
assert.match(stock, /СГРУППИРОВАТЬ ПО[\s\S]*?ИМЕЮЩИЕ " \+ УсловиеИтога[\s\S]*?УПОРЯДОЧИТЬ ПО " \+ Порядок/);
assert.match(stock, /ПрочитатьJSON\(Чтение, Ложь\)/);
assert.match(stock, /ЗаписатьJSON\(Запись, ПоследнееЗначение\)/);
for (const column of ["Наименование", "Артикул", "Количество"]) assert.ok(stock.includes(`ПоследнееЗначение = Выборка.${column}`));
const worker = modules.get("АС_АгрегаторСервер");
assert.equal((worker.match(/stock=4/g) ?? []).length, 3);
assert.doesNotMatch(worker, /stock=3/);
assert.match(worker, /ТоварыВНаличии\(Задание\.after, Диагностика, Задание\.query, Задание\.sortField, Задание\.sortDirection\)/);
assert.match(worker, /Результат\.lastSortValue = Страница\.lastSortValue/);
console.log("Static 1C sort check: both modules have balanced blocks, BOM/CRLF and matching SHA1; one bounded stock query, text range before grouping, quantity range after sum, reference tie key, exact decimal cursor. Platform not run.");
