import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";

if (!process.argv[2]) throw new Error("Usage: node scripts/verify-onec-nomenclature-worker.mjs <extension-directory>");
const source = readFileSync(join(resolve(process.argv[2]), "CommonModules/АС_АгрегаторСервер/Ext/Module.bsl"), "utf8");
const worker = source.slice(source.indexOf("Процедура ОбработатьЗапросыНоменклатуры()"), source.indexOf("Функция АктуальныНастройкиНоменклатуры("));
const windowSeconds = Number(worker.match(/ЗавершитьДо = ТекущаяУниверсальнаяДата\(\) \+ (\d+);/)?.[1]);
const reserve = Number(worker.match(/ЗапасНаОбработку = (\d+);/)?.[1]);
const ttl = Number(readFileSync(new URL("../src/backend/nomenclature/stock-requests.ts", import.meta.url), "utf8").match(/const ttl = ([\d_]+);/)?.[1].replaceAll("_", "")) / 1000;
assert.equal(windowSeconds, 45, "preserve the file database worker window");
assert.equal(reserve, ttl, "reserve a full request lifetime for reading and delivery");
assert.match(worker, /ТекущаяУниверсальнаяДата\(\) >= ЗавершитьДо - ЗапасНаОбработку/);
assert.match(worker, /"requests\?waitSeconds=20&stock=6", Неопределено, ЗавершитьДо, ЗапасНаОбработку, ДиагностикаОбмена\)/);
assert.match(source, /Функция ЗапросНоменклатуры\(Настройки, Метод, Ресурс, Тело, НеПозднее, ЗапасНаОбработку = 0, ДиагностикаОбмена = Неопределено\)/);
const expression = source.match(/Формат\((Макс\(0, Мин\(20, Таймаут - 2, Осталось - ЗапасНаОбработку\)\)), "ЧГ=0"\)/)?.[1];
assert.ok(expression, "poll duration must subtract processing reserve from the remaining window");
const wait = new Function("Таймаут", "Осталось", "ЗапасНаОбработку", `return ${expression.replaceAll("Макс", "Math.max").replaceAll("Мин", "Math.min")}`);
for (const elapsed of [0, 5, 10, 14, 15, 20, 40, 44]) {
  const remaining = windowSeconds - elapsed;
  const seconds = wait(Math.min(25, remaining), remaining, reserve);
  assert.ok(seconds >= 0 && seconds <= 20);
  if (remaining <= reserve) { assert.equal(seconds, 0); continue; }
  for (const arrival of [0, seconds / 2, seconds]) {
    assert.ok(elapsed + arrival + ttl <= windowSeconds, "late queue arrival must retain the full processing window");
  }
}
// Before the fix, a poll with five seconds left waited three seconds: only two remained.
assert.equal(Math.max(0, Math.min(20, 5 - 2)), 3);
console.log("Static worker timing model: 45-second window retained, poll <=15 seconds, >=30 seconds remain for accepted work; stock=6 and optional HTTP argument verified. Platform not run.");

const clientBytes = readFileSync(join(resolve(process.argv[2]), "Ext/ManagedApplicationModule.bsl"));
const client = clientBytes.toString("utf8");
assert.equal(clientBytes.subarray(0, 3).toString("hex"), "efbbbf");
assert.equal((client.match(/\r\n/g) || []).length, (client.match(/\n/g) || []).length);
const dump = readFileSync(join(resolve(process.argv[2]), "ConfigDumpInfo.xml"), "utf8");
const clientVersion = /<Metadata name="Configuration\.АС_Автосервис\.ManagedApplicationModule"[^>]*configVersion="([a-f0-9]+)"/.exec(dump)?.[1];
assert.equal(clientVersion, createHash("sha1").update(clientBytes).digest("hex"));
const tickSeconds = Number(client.match(/ПодключитьОбработчикОжидания\("АС_АгрегаторПроверитьПоискНоменклатуры", (\d+)\)/)?.[1]);
assert.equal(tickSeconds, 2, "file mode must not wait for the minute-based scheduled-job dispatcher");
const startup = client.slice(0, client.indexOf("КонецПроцедуры"));
assert.match(startup, /Если Не АС_АгрегаторСервер\.ИспользоватьКлиентскийТаймерОбмена\(\) Тогда Возврат/);
assert.match(startup, /АС_АгрегаторПроверитьПоискНоменклатуры\(\);/);
assert.match(client, /Процедура АС_АгрегаторПроверитьПоискНоменклатуры\(\) Экспорт[\s\S]*?АС_АгрегаторСервер\.ЗапуститьЛокальныйПоискНоменклатуры\(\);/);
const launch = source.slice(source.indexOf("Процедура ЗапуститьЛокальныйПоискНоменклатуры()"), source.indexOf("Процедура ОбработатьЗапросыНоменклатуры()"));
assert.match(launch, /ИнформационнаяБазаФайловая\(\) Тогда Возврат/);
assert.match(launch, /Не Настройки\.ПоискНоменклатурыВключен Или Настройки\.ОтпечатокБазы <> ОтпечатокБазы\(\)/);
assert.doesNotMatch(launch, /Настройки\.Включен|HTTPСоединение|ЗапросНоменклатуры\(|ТоварыВНаличии\(/);
assert.match(launch, /Регламентное\.Использование[\s\S]*?Регламентное\.ИмяПользователя = ПользователиИнформационнойБазы\.ТекущийПользователь\(\)\.Имя/);
assert.match(launch, /СостояниеФоновогоЗадания\.Активно/);
assert.match(launch, /Отбор\.Состояние = СостояниеФоновогоЗадания\.ЗавершеноАварийно[\s\S]*?Задание\.Конец \+ 30/);
assert.match(launch, /ФоновыеЗадания\.Выполнить\("АС_АгрегаторСервер\.ОбработатьЗапросыНоменклатуры", Новый Массив,\s*"АС_НоменклатураАгрегатора"/);
assert.match(source, /НастроитьЗаданиеАгрегатора\("АС_ПоискНоменклатурыАгрегатора", "АС_НоменклатураАгрегатора"/);

// Reproduce clicks between idle worker runs, including the reported minute-long gap.
// This bounds timer-induced waiting only; 1C process startup and network are not modeled.
const idleRunSeconds = wait(Math.min(25, windowSeconds), windowSeconds, reserve);
const schedulerPause = Number(readFileSync(join(resolve(process.argv[2]), "ScheduledJobs/АС_ПоискНоменклатурыАгрегатора/Ext/Schedule.xml"), "utf8").match(/RepeatPause="(\d+)"/)?.[1]);
function worstQueueWait(nextStart) {
  const runs = [];
  for (let start = 0; start < 600; start = nextStart(start + idleRunSeconds)) runs.push([start, start + idleRunSeconds]);
  let worst = 0;
  for (let click = 0; click < 300; click += 0.25) {
    const next = runs.find(([, end]) => end >= click);
    assert.ok(next);
    worst = Math.max(worst, Math.max(0, next[0] - click));
  }
  return worst;
}
const scheduledWait = worstQueueWait((end) => end + 60 + schedulerPause);
const timerWait = worstQueueWait((end) => (Math.floor(end / tickSeconds) + 1) * tickSeconds);
assert.ok(scheduledWait > ttl, "a request can expire while an enabled scheduled worker is idle");
assert.ok(timerWait <= tickSeconds, "a client timer removes the minute-long scheduling gap");
console.log(`File-mode restart model: queue wait ${scheduledWait}s with the scheduled dispatcher, <=${tickSeconds}s with the client timer; same job key, configured user, disable flag and failure pause preserved. Platform not run.`);
