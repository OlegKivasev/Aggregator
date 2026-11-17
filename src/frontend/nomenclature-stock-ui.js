import { createStockTable } from "./nomenclature-stock-table.js?v=stock-search-1";

export function bootstrapNomenclatureStock() {
  const status = document.querySelector("#nomenclature-stock-status");
  const table = document.querySelector("#nomenclature-stock-table");
  const refresh = document.querySelector("#nomenclature-stock-refresh");
  const input = document.querySelector("#nomenclature-stock-query");
  const form = document.querySelector("#nomenclature-stock-search");
  const sentinel = document.querySelector("#nomenclature-stock-sentinel");
  const progress = document.querySelector("#nomenclature-stock-progress");
  const retry = document.querySelector("#nomenclature-stock-retry");
  const renderer = createStockTable(document.querySelector("#nomenclature-stock-rows"),
    document.querySelector("#nomenclature-stock-before"), document.querySelector("#nomenclature-stock-after"));
  let active = false;
  let controller;
  let generation = 0;
  let query = "";
  let timer;
  let busy = false;
  let blocked = false;
  let nextCursor = null;
  let total = 0;
  const identities = new Set();
  const cursors = new Set();
  const normalize = (value) => value.normalize("NFC").trim().replace(/\s+/g, " ").toLocaleLowerCase("ru-RU");
  const stop = () => { generation += 1; clearTimeout(timer); timer = undefined; controller?.abort(); controller = undefined; busy = false; };
  const nearEnd = () => sentinel.getBoundingClientRect().top < window.innerHeight + 400;
  const load = async (first = false) => {
    if (!active || document.hidden || busy || blocked || (!first && !nextCursor)) return;
    const attempt = generation;
    const abort = new AbortController();
    controller = abort; busy = true; retry.hidden = true;
    progress.textContent = "Загружаем товары…";
    progress.dataset.tone = "loading";
    if (first) { status.textContent = "Загружаем товары в наличии…"; status.dataset.tone = "loading"; }
    const cursor = nextCursor;
    try {
      const parameters = new URLSearchParams();
      if (cursor) parameters.set("after", cursor);
      if (query) parameters.set("q", query);
      const response = await fetch(`/api/nomenclature/stock${parameters.size ? `?${parameters}` : ""}`, {
        cache: "no-store", signal: AbortSignal.any([abort.signal, AbortSignal.timeout(35_000)]),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(typeof value?.message === "string" ? value.message : "Не удалось загрузить остатки из 1С.");
      if (!value || !Array.isArray(value.products) || value.products.length > 100 || typeof value.hasMore !== "boolean"
        || !Number.isFinite(Date.parse(value.receivedAt)) || (value.hasMore ? value.products.length !== 100
          || value.nextCursor !== value.products.at(-1)?.id || cursors.has(value.nextCursor) : value.nextCursor !== null)
        || value.products.some((item) => !item || typeof item.id !== "string" || identities.has(item.id)
          || typeof item.name !== "string" || typeof item.article !== "string"
          || typeof item.quantity !== "number" || !Number.isFinite(item.quantity) || item.quantity <= 0)
        || new Set(value.products.map((item) => item.id)).size !== value.products.length) {
        throw new Error("Получен некорректный список остатков. Повторите загрузку.");
      }
      if (attempt !== generation || !active) return;
      for (const item of value.products) identities.add(item.id);
      if (cursor) cursors.add(cursor);
      total += value.products.length;
      nextCursor = value.nextCursor;
      table.hidden = total === 0;
      table.querySelector("table").setAttribute("aria-rowcount", value.hasMore ? "-1" : String(total + 1));
      renderer.append(value.products);
      status.textContent = total ? `Загружено товаров: ${total}. Получено из 1С в ${new Date(value.receivedAt).toLocaleTimeString("ru-RU")}`
        : query ? "По вашему запросу товаров в наличии не найдено." : "Товаров с положительным остатком нет.";
      status.dataset.tone = "notice";
      progress.textContent = nextCursor ? "Прокрутите вниз, чтобы загрузить ещё" : total ? "Все товары загружены" : "";
      progress.dataset.tone = "notice";
    } catch (error) {
      if (attempt !== generation || !active) return;
      blocked = true;
      progress.textContent = error?.name === "TimeoutError" ? "1С не ответила вовремя. Повторите загрузку."
        : error instanceof Error ? error.message : "Не удалось загрузить остатки из 1С.";
      progress.dataset.tone = "error";
      status.textContent = total ? `Загружено товаров: ${total}. Следующие товары пока не получены.` : progress.textContent;
      status.dataset.tone = "error";
      retry.hidden = false;
    } finally {
      if (attempt === generation && active) {
        controller = undefined; busy = false;
        if (nextCursor && !blocked && nearEnd()) void load();
      }
    }
  };
  const restart = () => {
    stop(); renderer.reset(); identities.clear(); cursors.clear();
    total = 0; nextCursor = null; blocked = false; table.hidden = true; retry.hidden = true;
    progress.textContent = "";
    if (active) void load(true);
  };
  const search = () => {
    const nextQuery = normalize(input.value);
    if (nextQuery === query && !timer) return;
    stop(); renderer.reset(); identities.clear(); cursors.clear(); total = 0; nextCursor = null;
    table.hidden = true; retry.hidden = true; blocked = true;
    status.textContent = "Ожидаем окончания ввода…"; status.dataset.tone = "notice"; progress.textContent = "";
    timer = setTimeout(() => { query = nextQuery; restart(); }, nextQuery ? 300 : 0);
  };
  input.addEventListener("input", (event) => { if (!event.isComposing) search(); });
  input.addEventListener("compositionend", search);
  form.addEventListener("submit", (event) => { event.preventDefault(); query = normalize(input.value); restart(); });
  refresh.addEventListener("click", () => { query = normalize(input.value); restart(); });
  retry.addEventListener("click", () => { blocked = false; void load(total === 0); });
  new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) void load();
  }, { rootMargin: "400px 0px" }).observe(sentinel);
  document.addEventListener("visibilitychange", () => { if (document.hidden) stop(); else if (active) { query = normalize(input.value); restart(); } });
  window.addEventListener("pagehide", stop);
  return {
    setActive(name) {
      const selected = name === "nomenclature";
      if (active === selected) return;
      active = selected;
      if (active) { query = normalize(input.value); restart(); }
      else { stop(); renderer.reset(); identities.clear(); cursors.clear(); status.textContent = ""; progress.textContent = ""; table.hidden = true; }
    },
  };
}
