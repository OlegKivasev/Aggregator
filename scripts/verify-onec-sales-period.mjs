import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

if (!process.argv[2]) throw new Error("Usage: node scripts/verify-onec-sales-period.mjs <extension-directory>");
const read = (module) => readFileSync(join(process.argv[2], "CommonModules", module, "Ext", "Module.bsl"), "utf8");
const sales = read("АС_ПродажиНоменклатурыСервер");
const incoming = read("АС_НоменклатураАгрегатора");
const worker = read("АС_АгрегаторСервер");
const section = (text, name) => {
  const start = text.indexOf(`Функция ${name}(`);
  assert.ok(start >= 0, name);
  return text.slice(start, text.indexOf("КонецФункции", start));
};
const candidates = section(sales, "ТекстКандидатовПродажПериода");
const history = section(sales, "ТекстЗапросаУчитываемыхДобавлений");
const filter = section(sales, "ТекстОтбораПродаж");
assert.match(candidates, /Строки\.АС_ДатаДобавления МЕЖДУ &ДатаПродажиС И &ДатаПродажиПо[\s\S]*?Строки\.Ссылка\.Дата МЕЖДУ/);
assert.match(candidates, /ОБЪЕДИНИТЬ[\s\S]*?Порции\.ВидСтроки = ""Запасы"" И Порции\.Количество > 0[\s\S]*?Порции\.ДатаДобавления МЕЖДУ/);
assert.doesNotMatch(history, /&ДатаПродажи/);
assert.match(history, /Если Не ТолькоГруппыПериода Тогда[\s\S]*?Документ\.ЗаказПокупателя\.Работы[\s\S]*?КонецЕсли;/);
assert.match(history, /ПОМЕСТИТЬ АС_ПорцииИсторииПродаж[\s\S]*?ПОМЕСТИТЬ АС_ИнтервалыСтрокПродаж/);
assert.match(history, /ГруппыСПорциями\.НомерВариантаКП/);
assert.match(filter, /ТекстКандидатовПродажПериода\(\)[\s\S]*?ТекстЗапросаУчитываемыхДобавлений\(Ложь, Истина\)/);
assert.match(filter, /Если ИсточникПродажи <> 1 И ИсточникПродажи <> 2 Тогда[\s\S]*?АС_СтрокиЧековПродаж[\s\S]*?КонецЕсли;[\s\S]*?АС_КлючиПродаж/);
assert.match(filter, /СтрокиЗаказа\.Ссылка = Ключи\.ЗаказПокупателя\s+\|\s+И СтрокиЗаказа\.Номенклатура = Ключи\.Номенклатура\s+\|\s+И СтрокиЗаказа\.Характеристика = Ключи\.Характеристика/);
const details = section(incoming, "ЗаказыКПоступлению");
assert.equal((details.match(/Запрос\.Выполнить\(/g) ?? []).length, 1);
assert.match(details, /ПЕРВЫЕ 101[\s\S]*?ПОМЕСТИТЬ АС_СтраницаЗаказовКПоступлению[\s\S]*?Документ\.ЗаказПоставщику\.Запасы[\s\S]*?РегистрНакопления\.ГрафикДвиженияЗапасов/);
assert.match(details, /Страница\.Заказ\.Контрагент\.Наименование/);
assert.match(worker, /Свойство\("incomingDetails", ПараметрыПоставки\)[\s\S]*?ЗаказыКПоступлению\(ПараметрыПоставки, Диагностика\)/);

// Model the scope reduction and interval intersections against the same offline data.
// Dates are integer days. This measures SQLite, not 1C or its underlying database.
const db = new DatabaseSync(":memory:");
db.exec(`
  CREATE TABLE lines(g TEXT, kind TEXT, line INTEGER, row_day INTEGER, order_day INTEGER, qty REAL, ignored INTEGER, cancelled INTEGER);
  CREATE TABLE portions(g TEXT, line INTEGER, day INTEGER, qty REAL);
  WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 30000)
  INSERT INTO lines SELECT 'historic-'||i,'stock',1,10 + i%330,1,3,0,0 FROM n
  UNION ALL SELECT 'historic-'||i,'stock',2,10 + i%330,1,1,0,0 FROM n
  UNION ALL SELECT 'labor-'||i,'labor',1,10 + i%330,1,1,0,0 FROM n;
  INSERT INTO portions SELECT g, 1, row_day, 4 FROM lines WHERE kind='stock' AND line=1;
  INSERT INTO lines VALUES
    ('old-order-added-today','stock',1,400,15,1,0,0),
    ('fallback-to-order-day','stock',1,NULL,400,1,0,0),
    ('old-line-new-portion','stock',1,18,18,9,0,0),
    ('ignore-out-of-period-portions','stock',1,400,15,9,0,0),
    ('cancelled','stock',1,400,15,2,0,1),
    ('portion-past-available','stock',1,18,18,2,0,0),
    ('ignored-lines','stock',1,18,18,2,1,0),
    ('ignored-lines','stock',2,19,19,1,0,0),
    ('new-labor','labor',1,400,15,2,0,0);
  INSERT INTO portions VALUES
    ('old-line-new-portion',1,18,3),('old-line-new-portion',2,400,4),('old-line-new-portion',3,402,2),
    ('ignore-out-of-period-portions',1,15,9),
    ('portion-past-available',1,18,2),('portion-past-available',2,400,1),
    ('ignored-lines',1,18,2),('ignored-lines',2,400,1);
  CREATE INDEX positive_portions ON portions(g, day, line);
  CREATE INDEX order_lines ON lines(g, kind, line);
`);
const run = (optimized, from, to) => {
  const cte = optimized ? `
    candidates AS MATERIALIZED (
      SELECT g FROM lines WHERE kind='stock' AND qty>0 AND COALESCE(row_day,order_day) BETWEEN :lo AND :hi
      UNION SELECT g FROM portions WHERE qty>0 AND day BETWEEN :lo AND :hi
    ),` : "";
  const query = `WITH ${cte}
    scoped AS MATERIALIZED (
      SELECT g,kind,line,COALESCE(row_day,order_day) AS day,qty,ignored FROM lines
      WHERE qty>0 AND NOT cancelled ${optimized ? "AND kind='stock' AND g IN (SELECT g FROM candidates)" : ""}
    ),
    in_scope AS MATERIALIZED (SELECT * FROM portions WHERE qty>0 AND g IN (SELECT g FROM scoped)),
    line_intervals AS (
      SELECT *, COALESCE(SUM(qty) OVER (PARTITION BY g ORDER BY day,line ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) AS start
      FROM scoped ${optimized ? "WHERE g IN (SELECT g FROM in_scope)" : ""}
    ),
    portion_intervals AS (
      SELECT *, COALESCE(SUM(qty) OVER (PARTITION BY g ORDER BY day,line ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) AS start FROM in_scope
    ),
    picked AS (
      SELECT L.g FROM line_intervals L JOIN portion_intervals P ON
        L.g=P.g AND L.start<P.start+P.qty AND L.start+L.qty>P.start
      WHERE L.kind='stock' AND NOT L.ignored AND P.day BETWEEN :lo AND :hi
      UNION
      SELECT g FROM scoped S WHERE kind='stock' AND NOT ignored AND day BETWEEN :lo AND :hi
        AND NOT EXISTS (SELECT 1 FROM in_scope P WHERE P.g=S.g)
    )
    SELECT (SELECT COUNT(*) FROM scoped) AS lines, (SELECT COUNT(*) FROM line_intervals) AS intervals,
      (SELECT json_group_array(g) FROM (SELECT g FROM picked ORDER BY g)) AS hits`;
  const start = performance.now();
  const result = db.prepare(query).get({ lo: from, hi: to });
  return { ...result, ms: performance.now() - start };
};
try {
  for (const [from, to] of [[400, 400], [399, 402], [12, 18], [1, 402]]) {
    const prior = run(false, from, to);
    const improved = run(true, from, to);
    assert.equal(improved.hits, prior.hits);
    if (from === 400) {
      assert.deepEqual(JSON.parse(improved.hits), ["fallback-to-order-day", "ignored-lines", "old-line-new-portion", "old-order-added-today"]);
      assert.ok(improved.intervals < prior.intervals / 1000);
      console.log(`Sales period model: ${prior.lines} → ${improved.lines} scoped rows, ${prior.intervals} → ${improved.intervals} interval rows, ${prior.ms.toFixed(1)} → ${improved.ms.toFixed(1)} ms in SQLite. 1C was not run.`);
    }
  }
} finally { db.close(); }
