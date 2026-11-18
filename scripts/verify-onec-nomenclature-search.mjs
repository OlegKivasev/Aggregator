import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

if (!process.argv[2]) throw new Error("Usage: node scripts/verify-onec-nomenclature-search.mjs <extension-directory>");
const root = resolve(process.argv[2]);
const read = (name) => readFileSync(join(root, "CommonModules", name, "Ext/Module.bsl"), "utf8");
const source = read("АС_НоменклатураАгрегатора");
const articles = read("АС_НоменклатураСервер");
const synonyms = read("АС_СинонимыПоискаСервер");
const oem = read("АС_ИндексOEMСервер");
const worker = read("АС_АгрегаторСервер");
for (const [module, text, names] of [["АС_НоменклатураСервер", articles, ["КомпактныйКлючАртикула"]],
  ["АС_СинонимыПоискаСервер", synonyms, ["ВариантыСтрокиПоиска", "НайтиНоменклатуруПоВариантам"]],
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
console.log("Static search checks: article normalization, shared synonym/OEM exports, vehicle aliases, hierarchy filters, fixed navigation reads and result forwarding verified. 1C platform not run.");
