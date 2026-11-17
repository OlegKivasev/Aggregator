import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

if (!process.argv[2]) throw new Error("Usage: node scripts/verify-onec-nomenclature-startup.mjs <extension-directory>");
const source = readFileSync(join(resolve(process.argv[2]), "CommonModules/АС_АгрегаторСервер/Ext/Module.bsl"), "utf8");
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const launch = section("Процедура ЗапуститьЛокальныйПоискНоменклатуры()", "Процедура ОбработатьЗапросыНоменклатуры()");
const worker = section("Процедура ОбработатьЗапросыНоменклатуры()", "Процедура ОтметитьЭтапНоменклатуры(");
const phase = section("Процедура ОтметитьЭтапНоменклатуры(", "Функция АктуальныНастройкиНоменклатуры(");
const http = section("Функция ЗапросНоменклатуры(", "КонецФункции");
assert.match(launch, /Отбор = Новый Структура\("ИмяМетода,Состояние",[\s\S]*?СостояниеФоновогоЗадания\.Активно/);
assert.match(launch, /МожноЗапускать = ФоновыеЗадания\.ПолучитьФоновыеЗадания\(Отбор\)\.Количество\(\) = 0/);
assert.match(launch, /Если МожноЗапускать Тогда[\s\S]*?Отбор\.Состояние = СостояниеФоновогоЗадания\.ЗавершеноАварийно/);
assert.doesNotMatch(launch, /Новый Структура\("ИмяМетода,Ключ,Состояние"/, "active jobs with another key still prevent duplicates");
assert.match(worker, /Отбор = Новый Структура\("ИмяМетода,Состояние",[\s\S]*?СостояниеФоновогоЗадания\.ЗавершеноАварийно/);
assert.ok(worker.indexOf("ЗавершитьДо =") < worker.indexOf("ПолучитьФоновыеЗадания("));
assert.ok(worker.indexOf("ЗавершитьДо =") < worker.indexOf("Настройки = ПрочитатьНастройки()"));
const beforePoll = worker.slice(0, worker.indexOf("Ответ = ЗапросНоменклатуры("));
assert.doesNotMatch(beforePoll, /ПроверитьНастройкиНоменклатуры\(/, "stock polling does not depend on the three barcode price types");
assert.match(worker, /Иначе\s+ПроверитьНастройкиНоменклатуры\(Настройки, ""\);\s+Результат\.products = АС_НоменклатураАгрегатора\.НайтиТовары\(/);
for (const label of ["Подготовка адреса и ключа", "Подготовка TLS", "Создание HTTP-соединения", "Чтение HTTP-ответа"]) assert.ok(http.includes(`"${label}"`));
assert.ok(http.indexOf('"Подготовка TLS"') < http.indexOf("Новый СертификатыУдостоверяющихЦентровОС"));
assert.ok(http.indexOf('"HTTP " + Метод') < http.indexOf("Соединение.ВызватьHTTPМетод("));
assert.match(phase, /ДлительностьЭтапа >= 1000/);
assert.match(phase, /Попытка[\s\S]*?ЗаписьЖурналаРегистрации[\s\S]*?Исключение/);
assert.doesNotMatch(phase, /ПрочитатьКлюч|Authorization|Штрихкод|Настройки\.Адрес|ПодробноеПредставлениеОшибки/);
assert.match(source, /Результат\.Вставить\("codeRevision", "startup-20261117"\)/);

// Behavioral model of the preserved guard; no 1C process or database is used.
const guardExpression = launch.match(/Если (Задание\.Конец \+ 30 > ТекущаяДатаСеанса\(\)) Тогда/)?.[1];
assert.ok(guardExpression);
const cooldown = new Function("Задание", "ТекущаяДатаСеанса", `return ${guardExpression}`);
const now = 1000;
const oldGuard = (jobs) => !jobs.some((job) => job.state === "active" || job.state === "failed" && cooldown(job, () => now));
const filteredGuard = (jobs) => {
  const active = jobs.filter((job) => job.state === "active");
  if (active.length) return { allowed: false, rowsExamined: active.length };
  const failed = jobs.filter((job) => job.state === "failed");
  return { allowed: !failed.some((job) => cooldown(job, () => now)), rowsExamined: failed.length };
};
const cases = [[], [{ state: "active", key: "another-key", Конец: 0 }], [{ state: "failed", Конец: now - 29 }],
  [{ state: "failed", Конец: now - 30 }], [{ state: "failed", Конец: now - 31 }],
  [{ state: "completed", Конец: now }], [{ state: "completed", Конец: now, duration: 0 }]];
for (const jobs of cases) assert.equal(filteredGuard(jobs).allowed, oldGuard(jobs));
const successfulHistory = Array.from({ length: 50_000 }, () => ({ state: "completed", Конец: now }));
assert.deepEqual(filteredGuard(successfulHistory), { allowed: true, rowsExamined: 0 });
assert.equal(filteredGuard([...successfulHistory, { state: "active", key: "another-key", Конец: 0 }]).allowed, false);
assert.equal(filteredGuard([...successfulHistory, { state: "failed", Конец: now - 1 }]).allowed, false);
// The reported run lasted 117 seconds. A platform call may overrun a script deadline;
// after it returns, a budget measured at entry cannot silently start another 45-second window.
const budget = Number(worker.match(/ЗавершитьДо = ТекущаяУниверсальнаяДата\(\) \+ (\d+)/)?.[1]);
assert.equal(budget, 45);
assert.ok(117 >= budget);
assert.ok(worker.indexOf("ТекущаяУниверсальнаяДата() >= ЗавершитьДо - ЗапасНаОбработку") < worker.indexOf("Ответ = ЗапросНоменклатуры("));
console.log("Startup static/model checks: 7 guard cases preserved, 50000 successful history rows excluded by the platform filter, active jobs of any key and 30-second error pause retained; 0 barcode price checks before polling; entry-based 45-second budget and secret-free phase logs verified. Actual 117-second delay is not reproduced without 1C.");
