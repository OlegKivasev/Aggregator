import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

if (!process.argv[2]) throw new Error("Usage: node scripts/verify-onec-nomenclature-search.mjs <extension-directory>");
const root = resolve(process.argv[2]);
const read = (name) => readFileSync(join(root, "CommonModules", name, "Ext/Module.bsl"), "utf8");
const source = read("АС_НоменклатураАгрегатора");
const articles = read("АС_НоменклатураСервер");
const synonyms = read("АС_СинонимыПоискаСервер");
const oem = read("АС_ИндексOEMСервер");
const worker = read("АС_АгрегаторСервер");
for (const [module, text, names] of [["АС_НоменклатураСервер", articles, ["КомпактныйКлючАртикула"]],
  ["АС_СинонимыПоискаСервер", synonyms, ["ВариантыСтрокиПоиска", "ПодготовитьПоискСинонимов", "ПроверенныеСинонимы"]],
  ["АС_ИндексOEMСервер", oem, ["НормализоватьOEM", "ОбеспечитьИндекс"]]]) {
  for (const name of names) {
    assert.match(text, new RegExp(`(?:Функция|Процедура) ${name}\\([^\\r\\n]*\\) Экспорт`), `${module}.${name} exists in the server module`);
    assert.ok(source.includes(`${module}.${name}(`));
  }
}
const compactSource = articles.slice(articles.indexOf("Функция КомпактныйКлючАртикула("), articles.indexOf("Функция ШаблоныПоискаАвтоАртикула("));
const allowed = /ДопустимыеСимволы = "([^"]+)"/.exec(compactSource)?.[1]; assert.ok(allowed);
// Model the character filter from the real shared source. This is not BSL execution.
const compact = (article) => [...article.trim().toUpperCase().replaceAll("Ё", "Е")].filter((character) => allowed.includes(character)).join("");
for (const article of ["L309-14-248", "L30914-248", "L30914248", "L309/14_248", " l309.14(248) "]) assert.equal(compact(article), "L30914248");
assert.notEqual(compact("L309X14-248"), compact("L309-14-248"));
assert.match(source, /КлючАртикула = АС_НоменклатураСервер\.КомпактныйКлючАртикула\(Часть\)/);
assert.match(source, /Найденные\.АС_АртикулДляПоиска ПОДОБНО/);
assert.match(source, /КатегорияНоменклатуры В ИЕРАРХИИ \(&Категория\)/);
assert.match(source, /Найденные\.Ссылка В ИЕРАРХИИ \(&Группа\)/);
const navigation = source.slice(source.indexOf("Функция НавигацияНоменклатуры("), source.indexOf("Функция НоменклатураПоOEM("));
assert.match(navigation, /Для Каждого Вид Из СтрРазделить\("categories,groups,oemBrands"/);
assert.equal((navigation.match(/Запрос\.Выполнить\(/g) ?? []).length, 1, "one fixed query per navigation kind");
assert.doesNotMatch(navigation, /ПолучитьОбъект\(/);
const oemSearch = source.slice(source.indexOf("Функция НоменклатураПоOEM("), source.indexOf("Функция ВидыЦенДляСписка("));
assert.match(oemSearch, /КлючOEM = &КлючOEM/);
assert.match(oemSearch, /НормализоватьOEM\(Выборка\.OEM\) <> КлючOEM/);
assert.match(oemSearch, /Данные\.Марка = &Марка/);
assert.match(worker, /ВерсияОстатков = 8/);
assert.match(synonyms, /ПакетСинонимов = Запрос\.ВыполнитьПакет\(\)/);
assert.match(synonyms, /АС_ДобавитьВариантыМарокИМоделей\(Результат, НормализованнаяСтрока, ПакетСинонимов\[1\]\.Выбрать\(\)\)/);
assert.match(synonyms, /Справочник\.АС_Автомобили КАК Автомобили[\s\S]*?НЕ Автомобили\.ПометкаУдаления/);
assert.match(synonyms, /Названия = СтрРазделить\(Выборка\.Синонимы,[\s\S]*?Названия\.Добавить\(Выборка\.Наименование\)/);
assert.match(synonyms, /ЗаменыПоФразам\.Получить\(Фраза\)[\s\S]*?Префикс \+ " " \+ Вариант/);
assert.match(worker, /Результат\.Вставить\("navigation", Страница\.navigation\)/);
assert.match(worker, /Тело\.Удалить\("navigation"\)/);
const stock = source.slice(source.indexOf("Функция ТоварыВНаличии("), source.indexOf("Функция ПодтвердитьСинонимыСписка("));
assert.match(stock, /ТекстПакета = ТекстТоварныхОтборов\([^)]+\);[\s\S]*?ПодтвердитьСинонимыСписка\(МенеджерТаблиц, ТекстПакета, УсловияСправочника/);
assert.match(stock, /ИсточникКаталога = "АС_КандидатыПоиска";[\s\S]*?ТекстПакета = "";/);
assert.match(stock, /Запрос\.МенеджерВременныхТаблиц = МенеджерТаблиц/);
assert.doesNotMatch(stock, /НайтиНоменклатуруПоВариантам/);
assert.match(stock, /Если ЕстьСинонимы И Синонимы\.ПроверятьКандидатов Тогда[\s\S]*?ПодтвердитьСинонимыСписка\([^)]+\)[\s\S]*?Иначе\s+Если ЕстьСинонимы Тогда\s+РежимСинонимов = "в запросе";\s+УсловиеТекста = "\(" \+ УсловиеТекста \+ " ИЛИ \(НЕ Найденные\.Недействителен И " \+ Синонимы\.Условие/);
const scoped = source.slice(source.indexOf("Функция ПодтвердитьСинонимыСписка("), source.indexOf("Функция ТекстТоварныхОтборов("));
assert.match(scoped, /ПОМЕСТИТЬ АС_КандидатыПоиска[\s\S]*?СтрСоединить\(УсловияСправочника, " И "\)/);
assert.match(scoped, /НЕ Найденные\.Недействителен И " \+ Синонимы\.Условие/);
assert.match(scoped, /ГДЕ НЕ Кандидаты\.ПрямоеСовпадение/);
assert.equal((scoped.match(/Запрос\.Выполнить\(/g) ?? []).length, 1);
assert.match(synonyms, /Поиск\.Варианты\.Добавить\(СтрРазделить\(НормализованныйВариант/);
assert.match(synonyms, /ИмяПараметра = ИменаШаблонов\.Получить\(Шаблон\)/);
assert.match(synonyms, /Если Не УсловияСлова\.ПростоеСлово Тогда Поиск\.ПроверятьКандидатов = Истина/);
assert.match(synonyms, /Если Поиск\.ПроверятьКандидатов Тогда\s+Возврат ПроверенныеСинонимы/);
const literalAlphabet = /ДопустимыеСимволыСинонима = "([^"]+)"/.exec(synonyms)?.[1];
assert.ok(literalAlphabet);
assert.match(synonyms, /Если СтрДлина\(Слово\) < 3 Тогда Возврат Ложь/);
const simple = (variants) => variants.every((variant) => variant.split(" ").every((word) =>
  word.length >= 3 && [...word.toLowerCase()].every((character) => literalAlphabet.includes(character))));
for (const variants of [["Ауди", "Audi"], ["Гранта", "Lada Granta"], ["держатель", "опора амортизатора"]]) assert.ok(simple(variants));
for (const variants of [["РК", "ремкомплект"], ["XC90", "Вольво"], ["шрус", "шарнир 1.2"], ["лёд", "обледенение"], ["ABC_", "ABCDE"]]) assert.ok(!simple(variants));
assert.match(synonyms, /СтрДлина\(СловоПоиска\) > 2[\s\S]*?АС_СтрокаСодержитСокращениеСКомплектом/);
const form = readFileSync(join(root, "Catalogs/Номенклатура/Forms/ФормаСписка/Ext/Form/Module.bsl"), "utf8");
assert.equal((form.match(/АС_СинонимыПоискаСервер\.ДополнитьПоискСинонимами\(/g) ?? []).length, 2);
assert.match(synonyms, /УжеНайденные\.Получить\(Выборка\.Номенклатура\)[^\r\n]+Продолжить/);
assert.match(stock, /Свойство\("highlightSynonyms", ЗапрошенаПодсветка\)/);
assert.match(stock, /Товары\.Количество\(\) = 100 Тогда ЕстьЕще = Истина; Прервать; КонецЕсли;[\s\S]*?СловаСинонимовДляПодсветки\(Товар\.name, Синонимы\.Варианты, ИсходныеСлова\)[\s\S]*?Товар\.Вставить\("nameMatches", СловаПодсветки\)/);
const nameMatches = synonyms.slice(synonyms.indexOf("Функция СловаСинонимовДляПодсветки("), synonyms.indexOf("Функция НормализоватьСтроку("));
assert.match(nameMatches, /Экспорт[\s\S]*?АС_СтрокаСодержитВсеСлова\(Имя, НормализованноеИмя, СловаПоиска\)[\s\S]*?ИсходныеСлова\.Получить\(Слово\)/);
assert.doesNotMatch(nameMatches, /Новый Запрос|Выполнить\(/);

// Model the candidate transfer over a local SQL fixture. The native 1C
// collation, query plans and runtime are outside this measurement.
const db = new DatabaseSync(":memory:");
db.function("contains_token", (text, term) => String(text).toLowerCase().includes(term) ? 1 : 0);
db.exec(`
  CREATE TABLE products(id INTEGER PRIMARY KEY, name TEXT, full_name TEXT, article TEXT, category INTEGER,
    received INTEGER, stock INTEGER, deleted INTEGER, inactive INTEGER);
  WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 60000)
  INSERT INTO products
  SELECT i, CASE WHEN i%5=0 THEN 'Втулка Ауди ' WHEN i%3=0 THEN 'Втулка Audi ' ELSE 'Фильтр ' END||i,
    CASE WHEN i%7=0 THEN 'Комплект Audi' ELSE 'Деталь' END, 'P-'||i,
    i%3, i%97=0, i%11<>0, 0, i%137=0 FROM n;
  INSERT INTO products VALUES
    (70001,'Подшипник','Подшипник','АУДИ-1',0,1,1,0,0),
    (70002,'Амортизатор','Сборка Audi A6','A6',0,1,1,0,0),
    (70003,'Ауди','Ауди','A6',0,1,1,0,1),
    (70004,'Audi','Audi','A6',0,1,1,0,1),
    (70005,'Audi','Audi','A6',0,1,1,1,0),
    (70006,'Втулка Audi','Втулка Audi','A6',1,1,1,0,0),
    (70007,'Втулка Audi','Втулка Audi','A6',0,0,1,0,0),
    (70008,'Втулка Audi','Втулка Audi','A6',0,1,0,0,0),
    (70009,'Держатель','Кронштейн','B1',0,1,1,0,0),
    (70010,'Опора амортизатора','ОПОРА АМОРТИЗАТОРА','B2',0,1,1,0,0),
    (70011,'Опора','Амортизатор','B3',0,1,1,0,0),
    (70012,'Амортизатор','Усиленная опора амортизатора','B4',0,1,1,0,0);`);
const direct = "(contains_token(name,'ауди') OR contains_token(article,'ауди'))";
const alias = "(NOT inactive AND (contains_token(name,'ауди') OR contains_token(full_name,'ауди') OR contains_token(name,'audi') OR contains_token(full_name,'audi')))";
const alphabet = /Разделители = "([^"]+)"/.exec(synonyms)[1];
const normalize = (value) => [...value.toLowerCase().replaceAll("ё", "е").replace(/[х*]/g, "x")]
  .filter((character) => !alphabet.includes(character)).join("").trim().replace(/\s+/g, " ");
const wordsMatch = (value, word) => word.length > 2 ? value.includes(word) : ` ${value} `.includes(` ${word} `);
assert.equal(wordsMatch(normalize("Р/К"), "рк"), true);
assert.equal(wordsMatch(normalize("6РК2100"), "рк"), false);
const verify = (candidate, once) => {
  const terms = ["ауди", "audi"];
  if (!once) return terms.some((term) => wordsMatch(normalize(candidate.name), term)
    || wordsMatch(normalize(candidate.full_name), term));
  const matches = (field) => {
    const prepared = normalize(field);
    return terms.some((term) => wordsMatch(prepared, term));
  };
  return matches(candidate.name) || candidate.name !== candidate.full_name && matches(candidate.full_name);
};
try {
  const beforeStart = performance.now();
  const allCandidates = db.prepare(`SELECT id,name,full_name FROM products WHERE NOT deleted AND ${alias}`).all();
  const verified = new Set(allCandidates.filter((candidate) => verify(candidate, false)).map(({ id }) => id));
  const beforeMs = performance.now() - beforeStart;
  for (const scopes of ["1", "received", "received AND category=0", "received AND category=0 AND id>30000"]) {
    const expected = db.prepare(`SELECT id, ${direct} AS matched FROM products WHERE NOT deleted AND stock AND (${scopes}) ORDER BY id`).all()
      .filter(({ id, matched }) => matched || verified.has(id)).map(({ id }) => id);
    const started = performance.now();
    const stage = db.prepare(`SELECT id,name,full_name,${direct} AS matched FROM products
      WHERE NOT deleted AND (${scopes}) AND (${direct} OR ${alias}) ORDER BY id`).all();
    const confirmed = stage.filter(({ matched, ...candidate }) => !matched && verify(candidate, true)).map(({ id }) => id);
    const actual = db.prepare(`SELECT id FROM products WHERE NOT deleted AND stock AND (${scopes})
      AND (${direct} OR id IN (SELECT value FROM json_each(?))) ORDER BY id`).all(JSON.stringify(confirmed)).map(({ id }) => id);
    const previousMs = performance.now() - started;
    const literalStarted = performance.now();
    const literal = db.prepare(`SELECT id FROM products WHERE NOT deleted AND stock AND (${scopes}) AND (${direct} OR ${alias}) ORDER BY id`).all().map(({ id }) => id);
    const literalMs = performance.now() - literalStarted;
    assert.deepEqual(actual, expected);
    assert.deepEqual(literal, actual);
    if (scopes === "1") {
      console.log(`Audi model, full catalogue: ${stage.filter(({ matched }) => !matched).length} names checked in JS before, 0 in the SQL path; ${previousMs.toFixed(1)} → ${literalMs.toFixed(1)} ms locally, identical rows.`);
    }
    if (scopes === "received AND category=0") {
      for (const id of [70001, 70002, 70003]) assert.ok(actual.includes(id));
      for (const id of [70004, 70005, 70006, 70007, 70008]) assert.ok(!actual.includes(id));
      const candidatesChecked = stage.filter(({ matched }) => !matched).length;
      assert.ok(candidatesChecked < allCandidates.length / 100);
      console.log(`Audi model with receipt and category: ${allCandidates.length} → ${candidatesChecked} → 0 candidate names checked across three implementations; ${beforeMs.toFixed(1)} → ${previousMs.toFixed(1)} → ${literalMs.toFixed(1)} ms locally. Platform not run.`);
    }
  }
  const customTerms = [["держатель"], ["опора", "амортизатора"]];
  const custom = "(contains_token(name,'держатель') OR contains_token(full_name,'держатель')"
    + " OR (contains_token(name,'опора') AND contains_token(name,'амортизатора'))"
    + " OR (contains_token(full_name,'опора') AND contains_token(full_name,'амортизатора')))";
  const customCandidates = db.prepare(`SELECT id,name,full_name FROM products WHERE id>=70009 AND ${custom} ORDER BY id`).all();
  assert.deepEqual(customCandidates.map(({ id }) => id), [70009, 70010, 70012]);
  assert.ok(customCandidates.every(({ name, full_name }) =>
    [name, full_name].some((field) => customTerms.some((terms) => terms.every((term) => wordsMatch(normalize(field), term))))));
} finally { db.close(); }
