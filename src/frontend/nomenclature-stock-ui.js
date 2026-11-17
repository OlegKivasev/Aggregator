import { createStockTable } from "./nomenclature-stock-table.js?v=stock-filters-2";

export function bootstrapNomenclatureStock() {
  const status = document.querySelector("#nomenclature-stock-status");
  const table = document.querySelector("#nomenclature-stock-table");
  const refresh = document.querySelector("#nomenclature-stock-refresh");
  const input = document.querySelector("#nomenclature-stock-query");
  const form = document.querySelector("#nomenclature-stock-search");
  const sentinel = document.querySelector("#nomenclature-stock-sentinel");
  const progress = document.querySelector("#nomenclature-stock-progress");
  const loading = document.querySelector("#nomenclature-stock-loading");
  const moreLoading = document.querySelector("#nomenclature-stock-more-loading");
  const retry = document.querySelector("#nomenclature-stock-retry");
  const statistics = document.querySelector("#nomenclature-stock-statistics");
  const availabilityEnabled = document.querySelector("#nomenclature-availability-enabled");
  const availability = document.querySelector("#nomenclature-availability");
  const priceEnabled = document.querySelector("#nomenclature-price-enabled");
  const priceType = document.querySelector("#nomenclature-price-type");
  const priceHeading = document.querySelector("#nomenclature-stock-price-heading");
  const priceLabel = document.querySelector("#nomenclature-stock-price-label");
  const loadingCell = document.querySelector(".nomenclature-stock-loading-cell");
  let totalCount;
  priceEnabled.disabled = true;
  let selectionCount = 0;
  const paintStatistics = () => { statistics.textContent = `Всего строк: ${totalCount === undefined ? "—" : totalCount.toLocaleString("ru-RU")}; Выделено: ${selectionCount.toLocaleString("ru-RU")}`; };
  const renderer = createStockTable(document.querySelector("#nomenclature-stock-rows"),
    document.querySelector("#nomenclature-stock-before"), document.querySelector("#nomenclature-stock-after"), (count) => { selectionCount = count; paintStatistics(); });
  let active = false;
  let controller;
  let generation = 0;
  let query = "";
  let timer;
  let busy = false;
  let blocked = false;
  let nextCursor = null;
  let bufferedPage;
  let total = 0;
  let sortField = "id";
  let sortDirection = "asc";
  const sortButtons = [...document.querySelectorAll("[data-nomenclature-sort]")];
  const identities = new Set();
  const cursors = new Set();
  const normalize = (value) => [...new Set(value.normalize("NFC").trim().toLocaleLowerCase("ru-RU").split(/\s+/).filter(Boolean))].sort().join(" ");
  const stop = () => { generation += 1; clearTimeout(timer); timer = undefined; controller?.abort(); controller = undefined; bufferedPage = undefined; busy = false; loading.hidden = true; moreLoading.hidden = true; retry.hidden = true; table.removeAttribute("aria-busy"); };
  const selectedPrice = () => priceEnabled.checked ? priceType.value : "";
  const selectedAvailability = () => availabilityEnabled.checked ? availability.value : "all";
  const syncSortHeaders = () => {
    for (const item of sortButtons) {
      const selected = item.dataset.nomenclatureSort === sortField && (sortField !== "price" || !!selectedPrice());
      item.classList.toggle("is-active", selected);
      item.closest("th").setAttribute("aria-sort", selected ? (sortDirection === "asc" ? "ascending" : "descending") : "none");
    }
  };
  const preloadDistance = 2000;
  const nearEnd = () => sentinel.getBoundingClientRect().top < window.innerHeight + preloadDistance;
  const load = async (first = false) => {
    if (!active || document.hidden || busy || blocked || (!first && !nextCursor)) return;
    // Keep one completed page ahead without downloading the entire catalogue.
    if (bufferedPage && !nearEnd()) return;
    const prepared = bufferedPage;
    bufferedPage = undefined;
    const attempt = generation;
    const abort = new AbortController();
    controller = abort; busy = true;
    progress.textContent = ""; retry.hidden = true;
    if (first) status.textContent = "";
    loading.hidden = !first; moreLoading.hidden = first; table.setAttribute("aria-busy", "true");
    const cursor = prepared?.cursor ?? nextCursor;
    try {
      const parameters = new URLSearchParams();
      parameters.set("details", "1"); parameters.set("availability", selectedAvailability());
      if (selectedPrice()) parameters.set("priceType", selectedPrice());
      if (cursor) parameters.set("after", cursor);
      if (query) parameters.set("q", query);
      if (sortField !== "id") { parameters.set("sort", sortField); parameters.set("direction", sortDirection); }
      let value = prepared?.value;
      if (!prepared) {
        const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(35_000)]);
        const response = await fetch(`/api/nomenclature/stock${parameters.size ? `?${parameters}` : ""}`, {
          cache: "no-store", signal,
        });
        try { value = await response.json(); }
        catch (error) {
          if (signal.aborted) throw signal.reason;
          if (error instanceof TypeError) throw error;
          throw new Error(response.ok ? "Сервер вернул пустой или неполный ответ. Обновите список."
            : `Сервер не смог загрузить остатки (HTTP ${response.status}). Обновите список.`);
        }
        if (!response.ok) throw new Error(typeof value?.message === "string" ? value.message : "Не удалось загрузить остатки из 1С.");
      }
      if (!value || !Array.isArray(value.products) || value.products.length > 100 || typeof value.hasMore !== "boolean"
        || !Number.isFinite(Date.parse(value.receivedAt)) || (value.hasMore ? value.products.length !== 100
          || typeof value.nextCursor !== "string" || value.nextCursor.length > 8192
          || !value.nextCursor || value.nextCursor === cursor || cursors.has(value.nextCursor) : value.nextCursor !== null)
        || value.products.some((item) => !item || typeof item.id !== "string" || identities.has(item.id)
          || typeof item.name !== "string" || typeof item.article !== "string"
          || typeof item.quantity !== "number" || !Number.isFinite(item.quantity)
          || selectedAvailability() === "available" && item.quantity <= 0 || selectedAvailability() === "absent" && item.quantity > 0
          || selectedPrice() && (item.price === undefined || item.price !== null && (typeof item.price.amount !== "number" || !Number.isFinite(item.price.amount)
            || item.price.amount < 0 || typeof item.price.currency !== "string" || !/^[A-Z]{3}$/.test(item.price.currency))))
        || first && (!Number.isSafeInteger(value.totalCount) || value.totalCount < value.products.length || !Array.isArray(value.priceTypes)
          || value.priceTypes.some((item) => !item || typeof item.id !== "string" || typeof item.name !== "string"))
        || new Set(value.products.map((item) => item.id)).size !== value.products.length) {
        throw new Error("Получен некорректный список остатков. Обновите список.");
      }
      if (attempt !== generation || !active) return;
      if (!first && !nearEnd()) { bufferedPage = { value, cursor }; return; }
      if (first) {
        totalCount = value.totalCount;
        const previous = priceType.value;
        const options = value.priceTypes.map((item) => { const option = document.createElement("option"); option.value = item.id; option.textContent = item.name; return option; });
        priceType.replaceChildren(...options);
        if (value.priceTypes.some((item) => item.id === previous)) priceType.value = previous;
        priceEnabled.disabled = options.length === 0;
        priceType.disabled = !priceEnabled.checked || !options.length;
        paintStatistics();
      }
      for (const item of value.products) identities.add(item.id);
      if (cursor) cursors.add(cursor);
      total += value.products.length;
      nextCursor = value.nextCursor;
      table.hidden = false;
      table.querySelector("table").setAttribute("aria-rowcount", value.hasMore ? "-1" : String(total + 1));
      renderer.append(value.products);
      status.textContent = total ? "" : "Товары не найдены.";
      status.dataset.tone = "notice";
      progress.textContent = "";
      progress.dataset.tone = "notice";
    } catch (error) {
      if (attempt !== generation || !active) return;
      blocked = true;
      const message = error?.name === "TimeoutError" ? "1С не ответила вовремя. Повторите загрузку."
        : error instanceof TypeError ? "Соединение с агрегатором прервано. Повторите загрузку."
          : error instanceof Error ? error.message : "Не удалось загрузить остатки из 1С.";
      const feedback = first ? status : progress;
      feedback.textContent = message;
      feedback.dataset.tone = "error";
      retry.hidden = first;
    } finally {
      if (attempt === generation && active) {
        controller = undefined; busy = false; loading.hidden = true; moreLoading.hidden = true; table.removeAttribute("aria-busy");
        if (nextCursor && !blocked) void load();
      }
    }
  };
  const restart = () => {
    stop(); totalCount = undefined; renderer.reset(!!selectedPrice(), query); identities.clear(); cursors.clear();
    total = 0; nextCursor = null; blocked = false; table.hidden = !active;
    progress.textContent = "";
    priceHeading.hidden = !selectedPrice();
    priceLabel.textContent = selectedPrice() ? priceType.selectedOptions[0]?.textContent ?? "Цена" : "Цена";
    priceHeading.title = priceLabel.textContent;
    document.querySelector("#nomenclature-stock-title").textContent = selectedAvailability() === "available" ? "Товары в наличии" : "Номенклатура";
    table.querySelector("table").classList.toggle("has-price", !!selectedPrice());
    for (const spacer of table.querySelectorAll(".nomenclature-stock-spacer")) spacer.colSpan = selectedPrice() ? 4 : 3;
    loadingCell.colSpan = selectedPrice() ? 4 : 3;
    if (active) void load(true);
  };
  const search = () => {
    const nextQuery = normalize(input.value);
    if (nextQuery === query && !timer) return;
    stop(); totalCount = undefined; renderer.reset(!!selectedPrice(), nextQuery); identities.clear(); cursors.clear(); total = 0; nextCursor = null;
    table.hidden = false; blocked = true;
    status.textContent = ""; progress.textContent = "";
    timer = setTimeout(() => { query = nextQuery; restart(); }, nextQuery ? 300 : 0);
  };
  input.addEventListener("input", (event) => { if (!event.isComposing) search(); });
  input.addEventListener("compositionend", search);
  form.addEventListener("submit", (event) => { event.preventDefault(); query = normalize(input.value); restart(); });
  refresh.addEventListener("click", () => { query = normalize(input.value); restart(); });
  retry.addEventListener("click", () => { if (!active || busy) return; blocked = false; void load(); });
  const filterChanged = () => {
    availability.disabled = !availabilityEnabled.checked;
    priceType.disabled = !priceEnabled.checked;
    if (priceEnabled.checked && !priceType.value) { priceEnabled.checked = false; priceType.disabled = true; return; }
    if (!selectedPrice() && sortField === "price") { sortField = "id"; sortDirection = "asc"; }
    syncSortHeaders();
    document.querySelector("#nomenclature-filter-summary").textContent = [
      selectedAvailability() === "available" ? "В наличии" : selectedAvailability() === "absent" ? "Отсутствуют" : "Все товары",
      selectedPrice() ? priceType.selectedOptions[0].textContent : "",
    ].filter(Boolean).join(" · ");
    query = normalize(input.value); restart();
  };
  for (const control of [availabilityEnabled, availability, priceEnabled, priceType]) control.addEventListener("change", filterChanged);
  for (const button of sortButtons) button.addEventListener("click", () => {
    const field = button.dataset.nomenclatureSort;
    sortDirection = field === sortField && sortDirection === "asc" ? "desc" : "asc";
    sortField = field;
    syncSortHeaders();
    query = normalize(input.value);
    restart();
  });
  new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) void load();
  }, { rootMargin: `${preloadDistance}px 0px` }).observe(sentinel);
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
