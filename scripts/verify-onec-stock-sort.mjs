import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

if (!process.argv[2]) throw new Error("Usage: node scripts/verify-onec-stock-sort.mjs <extension-directory>");
const root = resolve(process.argv[2]);
const dump = readFileSync(join(root, "ConfigDumpInfo.xml"), "utf8");
const modules = new Map();
for (const name of ["АС_АгрегаторСервер", "АС_НоменклатураАгрегатора", "АС_ПродажиНоменклатурыСервер", "АС_СинонимыПоискаСервер"]) {
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
const stock = source.slice(source.indexOf("Функция ТоварыВНаличии("), source.indexOf("Функция ТекстТоварныхОтборов("));
assert.match(stock, /ПЕРВЫЕ 101/);
assert.equal((stock.match(/Запрос\.Выполнить\(/g) || []).length, 1);
assert.doesNotMatch(stock, /ПолучитьОбъект\(|СМЕЩЕНИЕ|OFFSET/i);
assert.match(stock, /Сравнение = \?\(НаправлениеСортировки = "desc", "<", ">"\)/);
assert.match(stock, /Порядок = Порядок \+ ", Номенклатура"/);
assert.match(stock, /ИначеЕсли ПолеСортировки <> "quantity"(?: И ПолеСортировки <> "price")? Тогда[\s\S]*?Найденные\.Ссылка > &ПослеНоменклатуры/);
assert.match(stock, /Если ЕстьКурсор И ПолеСортировки = "quantity" Тогда[\s\S]*?ОтборИтога = ОтборИтога \+[\s\S]*?Найденные\.Ссылка > &ПослеНоменклатуры/);
assert.match(stock, /Итог = "ЕСТЬNULL\(Остатки\.Количество, 0\)"/);
assert.match(stock, /СУММА\(Остатки\.КоличествоОстаток\)[\s\S]*?СГРУППИРОВАТЬ ПО[\s\S]*?ОтборКаталога \+ " И "\) \+ ОтборИтога/);
assert.equal((stock.match(/ЗапасыНаСкладах\.Остатки\(/g) ?? []).length, 1);
assert.match(stock, /СУММА\(Остатки\.Количество \+ Остатки\.Резерв\)[\s\S]*?РегистрСведений\.ОстаткиТоваров/);
assert.match(stock, /РегистрНакопления\.ЗаказыПокупателей\.Остатки\([\s\S]*?Заказы\.КоличествоОстаток > 0/);
assert.match(stock, /Итог \+ " - ЕСТЬNULL\(АктивныеЗаказы\.Количество, 0\)"/);
assert.match(stock, /ПОМЕСТИТЬ АС_КаталогСтраницы/);
assert.match(stock, /Поступления = ПоступленияСтраницыНоменклатуры\(Ссылки\);\s*ЧтениеПоставокМС = [^;]+;\s*Для Индекс[\s\S]*?Поступления\.Получить/);
const incoming = source.slice(source.indexOf("Функция ПоступленияСтраницыНоменклатуры("), source.indexOf("Функция ЗаказыКПоступлению("));
assert.equal((incoming.match(/Запрос\.Выполнить\(/g) ?? []).length, 1);
assert.match(incoming, /ТекстЗапросаСвязейПоступления\(Истина\)[\s\S]*?ТекстЗапросаПоступления\(Ложь, Ложь, Ложь, Истина\)[\s\S]*?ТекстЗапросаПоступленияЗамен\(Истина\)/);
const formPath = join(root, "Catalogs/Номенклатура/Forms/ФормаСписка/Ext/Form");
const form = readFileSync(join(formPath, "Module.bsl"), "utf8");
const opening = form.slice(form.indexOf("Процедура АС_ПриОткрытииПосле("), form.indexOf("Процедура АС_ЗаполнитьПериодПоступленийПоУмолчанию("));
assert.match(opening, /Если Не РежимВыбора И Не ЭтоПодбор Тогда[\s\S]*?АС_ПоступившиеЗаПериод = Истина;[\s\S]*?АС_ДатаПоступленияС = НачалоДня\(ДатаСеанса\);\s*АС_ДатаПоступленияПо = КонецДня\(ДатаСеанса\);/);
const sales = modules.get("АС_ПродажиНоменклатурыСервер");
for (const method of ["ТекстОтбораПоступлений", "ТекстОтбораПродаж", "ТекстЗапросаПоступленияЗамен"]) {
  assert.match(sales, new RegExp(`Функция ${method}\\([^\\r\\n]*\\) Экспорт`));
  for (const caller of [source, form]) assert.ok(caller.includes(`АС_ПродажиНоменклатурыСервер.${method}(`));
}
assert.match(stock, /СчитатьВсего = РасширенныйСписок И Не ЕстьКурсор/);
assert.equal((stock.match(/Запрос\.ВыполнитьПакет\(/g) ?? []).length, 1);
assert.match(stock, /ПОМЕСТИТЬ СписокНоменклатуры[\s\S]*?ПЕРВЫЕ 101[\s\S]*?КОЛИЧЕСТВО\(\*\)/);
assert.match(stock, /Если СчитатьВсего Тогда[\s\S]*?Результат\.Вставить\("totalCount", Всего\);[\s\S]*?ВидыЦенДляСписка\(\)/);
assert.equal((stock.match(/ЦеныСтраницыНоменклатуры\(Ссылки,/g) ?? []).length, 1);
assert.match(stock, /ЦеныСтраницы = ЦеныСтраницыНоменклатуры[\s\S]*?Для Индекс = 0[\s\S]*?ЦеныСтраницы\.Получить/);
const prices = source.slice(source.indexOf("Функция ЦеныСтраницыНоменклатуры("), source.indexOf("Процедура ПроверитьВидЦен("));
assert.equal((prices.match(/Запрос\.Выполнить\(/g) ?? []).length, 1);
assert.match(prices, /СрезПоследних\(&ДатаЦен, ВидЦен = &ВидЦен[\s\S]*?Номенклатура В \(&Ссылки\)[\s\S]*?ГДЕ Цены\.Актуальность/);
assert.ok(prices.indexOf("Запрос.Выполнить()") < prices.indexOf("Пока Выборка.Следующий()"), "no query per product");
assert.match(stock, /ПрочитатьJSON\(Чтение, Ложь\)/);
assert.match(stock, /ЕстьСортировкаПоЦене = ПолеСортировки = "price"/);
assert.match(stock, /СрезПоследних\(&ДатаЦенСортировки, ВидЦен = &ВидЦенСортировки/);
assert.match(stock, /ЕстьЦена УБЫВ, " \+ КолонкаСортировки/);
assert.match(stock, /Новый Структура\("hasPrice,amount"/);
assert.match(stock, /КомпактныйКлючАртикула\(Часть\)/);
// Regression for the compiler error reported in 1C: no global Абс function.
// Execute only the two numeric guards from the real BSL source, not the module.
assert.doesNotMatch(source, /(?<![\p{L}\p{N}_])(?:Абс|Abs)\s*\(/iu);
const numericGuard = stock.match(/Если ТипЗнч\(ЗначениеПосле\) <> Тип\("Число"\) Тогда ВызватьИсключение "Некорректный остаток курсора\."; КонецЕсли;\s*Если ЗначениеПосле < -\d+ Или ЗначениеПосле > \d+ Тогда ВызватьИсключение "Некорректный остаток курсора\."; КонецЕсли;/)?.[0];
assert.ok(numericGuard, "A separate type check must precede the two signed range comparisons");
const numericCode = numericGuard.replaceAll('ТипЗнч(ЗначениеПосле) <> Тип("Число")', 'typeof ЗначениеПосле !== "number"')
  .replaceAll("Если ", "if (").replaceAll(" Тогда ", ") { ").replaceAll("ВызватьИсключение ", "throw new Error(")
  .replaceAll('"; КонецЕсли;', '"); }').replaceAll(" Или ", " || ");
const validateQuantity = new Function("ЗначениеПосле", numericCode);
for (const quantity of [-1e15, -999999999999999.875, -1.125, -1, 0, 1, 1.125, 999999999999999.875, 1e15]) assert.doesNotThrow(() => validateQuantity(quantity));
for (const quantity of [-1e15 - 0.125, 1e15 + 0.125, -1e16, 1e16, "0", null, undefined, false, {}, []]) assert.throws(() => validateQuantity(quantity), /Некорректный остаток курсора/);
assert.match(stock, /ЗаписатьJSON\(Запись, ПоследнееЗначение\)/);
for (const column of ["Наименование", "Артикул", "Количество"]) assert.ok(stock.includes(`ПоследнееЗначение = Выборка.${column}`));
assert.match(stock, /ПоследнееЗначение = Новый Структура\("hasPrice,amount"/);
const worker = modules.get("АС_АгрегаторСервер");
assert.match(worker, /ВерсияОстатков = 8;[\s\S]*?"requests", Неопределено, ЗавершитьДо[\s\S]*?ВерсияОстатков\)/);
assert.match(worker, /ЭтоОпрос И ВерсияОстатков > 6 И Ответ.КодСостояния = 400[\s\S]*?ВерсияОстатков = ВерсияОстатков - 1;/);
assert.match(worker, /ТоварыВНаличии\(Задание\.after, Диагностика, Задание\.query, Задание\.sortField, Задание\.sortDirection, Задание\.options\)/);
assert.match(worker, /Результат\.lastSortValue = Страница\.lastSortValue/);
console.log("Static 1C stock check: balanced modules, BOM/CRLF and SHA1; shared period SQL, page batch for original and replacement supply, stock with orders before filtering and sorting, legacy v6, scoped counts and cursors. Platform not run.");
