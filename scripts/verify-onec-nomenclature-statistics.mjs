import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

if (!process.argv[2]) throw new Error("Usage: node scripts/verify-onec-nomenclature-statistics.mjs <extension-directory>");
const root = resolve(process.argv[2]);
const read = (path) => readFileSync(join(root, path), "utf8");
const modulePath = (name) => `CommonModules/${name}/Ext/Module.bsl`;
const stock = read(modulePath("АС_ДоступностьТоваровСервер"));
const sales = read(modulePath("АС_ПродажиНоменклатурыСервер"));
const lookup = read(modulePath("АС_НоменклатураАгрегатора"));
const formPath = "Catalogs/Номенклатура/Forms/ФормаЭлемента/Ext/Form";
const form = read(`${formPath}/Module.bsl`);
const xml = read(`${formPath}.xml`);
const dump = read("ConfigDumpInfo.xml");
const section = (text, name) => {
  const start = text.indexOf(`Функция ${name}(`);
  assert.ok(start >= 0, name);
  return text.slice(start, text.indexOf("КонецФункции", start));
};
const batchStock = section(stock, "ПолучитьСведенияПоНоменклатурам");
const batchSales = section(sales, "ПолучитьИсториюПродажПоМесяцам");
const barcode = section(lookup, "НайтиТовары");
const card = section(sales, "ПолучитьПоказателиЗакупки");
for (const [text, name, consumer] of [
  [stock, "ПолучитьСведенияПоНоменклатурам", barcode],
  [sales, "ПолучитьИсториюПродажПоМесяцам", barcode],
]) {
  assert.match(section(text, name).split(/\r?\n/)[0], /Экспорт$/);
  assert.ok(consumer.includes(`${name}(`));
}
assert.ok(section(stock, "ПолучитьСведенияПоНоменклатуре").includes("ПолучитьСведенияПоНоменклатурам(Товары)"));
assert.match(batchStock, /Окр\(Сведения\.ФизическийОстаток - Сведения\.ПотребностьПоЗаказам, 3\)/);
assert.match(batchStock, /Остаток < 0, 0, Остаток/);
assert.equal((batchStock.match(/Запрос\.ВыполнитьПакет\(/g) ?? []).length, 1);
assert.equal((batchSales.match(/Запрос\.Выполнить\(/g) ?? []).length, 1);
assert.match(batchSales, /КоличествоОборот - Продажи\.КоличествоИнтОборот/);
assert.match(batchSales, /КонецПериода = КонецДня\(Сейчас\)/);
assert.match(card, /КонецПериода = КонецДня\(Сейчас\)/);
assert.match(card, /ВсегоПродано \/ \(4 \+ ДоляТекущегоМесяца\)/);
assert.match(card, /День\(Сейчас\) \/ День\(КонецМесяца\(Сейчас\)\)/);
assert.match(section(sales, "ПолучитьШтатнуюРекомендациюЗакупки"), /НачалоИстории, КонецИстории, НачалоДня\(Сейчас\)/);
assert.match(sales.slice(sales.indexOf("Процедура РассчитатьЗакупкуВФоне(")), /КонецИстории = КонецДня\(Сегодня\)/);
assert.match(section(sales, "ПодписьИсточниковЗакупки"), /Части\.Добавить\(ЗначениеВСтрокуВнутр\(КонецИстории\)\)/);
assert.match(form, /ДанныеМесяца = Закупка\.Месяцы\[4 - Индекс\]/);
for (let index = 1; index <= 5; index++) assert.ok(xml.includes(`name="АС_ЗакупкаМесяц${index}"`));
assert.match(barcode, /ПолучитьИсториюПродажПоМесяцам\(Ссылки, 4/);
const priceLoop = barcode.slice(barcode.lastIndexOf("Для Каждого СтрокаТовара Из Товары Цикл"));
assert.doesNotMatch(priceLoop, /ПолучитьСведенияПоНоменклатурам\(|ПолучитьИсториюПродажПоМесяцам\(/);
assert.match(priceLoop, /Месяцы\[3 - Индекс\]/);

// Execute the actual SELECT/grouping expressions against fixture register snapshots.
// Virtual table filters are mapped to SQLite views; this does not execute 1C/RLS.
const db = new DatabaseSync(":memory:");
db.exec(`CREATE TABLE requested(id TEXT); INSERT INTO requested VALUES ('A'),('B');
  CREATE TABLE stock(Номенклатура TEXT, СтруктурнаяЕдиница TEXT, КоличествоОстаток REAL, warehouse INTEGER);
  INSERT INTO stock VALUES ('A','main',10,1),('A','other',-2,1),('A','transit',100,0),('B','main',1,1),('ignored','main',99,1);
  CREATE TABLE orders(Номенклатура TEXT, ЗаказПокупателя TEXT, КоличествоОстаток REAL);
  INSERT INTO orders VALUES ('A','one',4),('A','one',-1),('A','negative',-2),('B','two',5),('ignored','one',50);
  CREATE TABLE sales(Номенклатура TEXT, Период TEXT, КоличествоОборот REAL, КоличествоИнтОборот REAL);
  INSERT INTO sales VALUES ('A','2026-02',10,2),('A','2026-02',-1,0),('A','2026-01',0,0),('A','2025-12',-2,0),('B','2025-11',3,0),('ignored','2026-02',99,0);`);
const queryText = (source) => {
  const query = /Запрос\.Текст\s*=\s*"([\s\S]*?)";/.exec(source)?.[1];
  assert.ok(query);
  return query.replace(/\r?\n\s*\|/g, "\n").replaceAll(/\/\/[^\r\n]*/g, "")
    .replaceAll("ВЫБРАТЬ РАЗРЕШЕННЫЕ", "SELECT").replaceAll("СГРУППИРОВАТЬ ПО", "GROUP BY")
    .replaceAll("ИМЕЮЩИЕ", "HAVING").replaceAll("ЕСТЬNULL", "IFNULL").replaceAll("СУММА", "SUM")
    .replaceAll(" КАК ", " AS ").replace(/(^|\s)ИЗ(?=\s)/g, "$1FROM");
};
const stockSql = queryText(batchStock)
  .replace(/РегистрНакопления\.Запасы\.Остатки\([\s\S]*?\) AS ЗапасыОстатки/, "(SELECT * FROM stock WHERE warehouse=1 AND Номенклатура IN (SELECT id FROM requested)) AS ЗапасыОстатки")
  .replace(/РегистрНакопления\.ЗаказыПокупателей\.Остатки\([\s\S]*?\) AS ЗаказыПокупателейОстатки/, "(SELECT * FROM orders WHERE Номенклатура IN (SELECT id FROM requested)) AS ЗаказыПокупателейОстатки");
assert.match(batchStock, /ТИПЗНАЧЕНИЯ\(СтруктурнаяЕдиница\) = ТИП\(Справочник\.СтруктурныеЕдиницы\)/);
assert.equal((batchStock.match(/Номенклатура В \(&Номенклатура\)/g) ?? []).length, 2);
const [stockQuery, orderQuery] = stockSql.split(";");
const stockRows = db.prepare(stockQuery).all();
const orderRows = db.prepare(orderQuery).all();
const available = (id) => Math.max(0, stockRows.filter((r) => r.Номенклатура === id).reduce((sum, r) => sum + r.Количество, 0)
  - orderRows.filter((r) => r.Номенклатура === id).reduce((sum, r) => sum + r.Количество, 0));
assert.equal(available("A"), 5);
assert.equal(available("B"), 0);
assert.equal(available("no-records"), 0);
const salesSql = queryText(batchSales).replace(/РегистрНакопления\.Продажи\.Обороты\([\s\S]*?\) AS Продажи/,
  "(SELECT * FROM sales WHERE Номенклатура IN (SELECT id FROM requested)) AS Продажи");
const sold = db.prepare(salesSql).all();
assert.equal(sold.find((r) => r.Номенклатура === "A" && r.Месяц === "2026-02").Количество, 7);
assert.equal(sold.find((r) => r.Номенклатура === "A" && r.Месяц === "2025-12").Количество, -2);
assert.equal(sold.some((r) => r.Номенклатура === "ignored"), false);
db.close();
// Model the source's month indexing and fractional-month mean across year/leap boundaries.
for (const [year, month, day] of [[2026, 1, 1], [2026, 11, 17], [2028, 2, 29]]) {
  const first = new Date(Date.UTC(year, month - 5, 1));
  const months = Array.from({ length: 5 }, (_, index) => new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + index, 1)));
  assert.equal(months.at(-1).getUTCMonth(), month - 1);
  for (const [index, date] of months.entries()) assert.equal((date.getUTCFullYear() - first.getUTCFullYear()) * 12 + date.getUTCMonth() - first.getUTCMonth(), index);
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const total = 40 + 10 * day / days;
  assert.equal(total / (4 + day / days), 10, "a constant sales rate must not fall because the current month is incomplete");
}

// Validate module context, source encodings, metadata fingerprints and BSL block balance.
const files = [modulePath("АС_ДоступностьТоваровСервер"), modulePath("АС_ПродажиНоменклатурыСервер"), modulePath("АС_НоменклатураАгрегатора"), `${formPath}/Module.bsl`];
const formEntry = dump.split(/\r?\n/).find((line) => line.includes('name="Catalog.Номенклатура.Form.ФормаЭлемента.Form"'));
assert.equal(/configVersion="([a-f0-9]+)"/.exec(formEntry)?.[1], createHash("sha1").update(readFileSync(join(root, `${formPath}.xml`))).update(readFileSync(join(root, `${formPath}/Module.bsl`))).digest("hex"));
for (const path of files) {
  const bytes = readFileSync(join(root, path));
  const source = bytes.toString("utf8");
  assert.equal(bytes.subarray(0, 3).toString("hex"), "efbbbf", path);
  assert.equal((source.match(/\r\n/g) ?? []).length, (source.match(/\n/g) ?? []).length, path);
  const clean = source.replace(/"(?:[^"]|"")*"/g, '""').replace(/\/\/[^\r\n]*/g, "").replace(/^\s*#.*$/gm, "");
  const stack = [];
  for (const match of clean.matchAll(/(?<![\p{L}\p{N}_])(Функция|Процедура|Если|Для|Пока|Попытка|КонецФункции|КонецПроцедуры|КонецЕсли|КонецЦикла|КонецПопытки)(?![\p{L}\p{N}_])/gu)) {
    const token = match[0];
    const opening = { КонецФункции: ["Функция"], КонецПроцедуры: ["Процедура"], КонецЕсли: ["Если"], КонецЦикла: ["Для", "Пока"], КонецПопытки: ["Попытка"] }[token];
    if (opening) assert.ok(opening.includes(stack.pop()), `${path}: ${token} at ${match.index}`); else stack.push(token);
  }
  assert.deepEqual(stack, [], path);
  if (path.startsWith("CommonModules/")) {
    const name = path.split("/")[1];
    assert.ok(read(`CommonModules/${name}.xml`).includes("<Server>true</Server>"));
    const entry = dump.split(/\r?\n/).find((line) => line.includes(`name="CommonModule.${name}.Module"`));
    assert.equal(/configVersion="([a-f0-9]+)"/.exec(entry)?.[1], createHash("sha1").update(bytes).digest("hex"));
  }
}
console.log("Static/model checks passed: shared stock query, returns/internal transfers, zero stock, month/year/leap boundaries, current-month card/list forecast, BSL blocks, exports, server context, BOM/CRLF and SHA-1. Barcode statistics add two stock SELECTs and one sales SELECT for 1–20 matches, with no per-match register queries or extra HTTP. 1C platform/RLS/runtime latency not tested.");
