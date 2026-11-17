import assert from "node:assert/strict";
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
assert.match(worker, /"requests\?waitSeconds=20&stock=5", Неопределено, ЗавершитьДо, ЗапасНаОбработку\)/);
assert.match(source, /Функция ЗапросНоменклатуры\(Настройки, Метод, Ресурс, Тело, НеПозднее, ЗапасНаОбработку = 0\)/);
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
console.log("Static worker timing model: 45-second window retained, poll <=15 seconds, >=30 seconds remain for accepted work; stock=5 and optional HTTP argument verified. Platform not run.");
