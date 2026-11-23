import { createNomenclatureNavigation } from "./nomenclature-navigation.js?v=panel-8";
import { createStockTable } from "./nomenclature-stock-table.js?v=product-card-3";

const stockDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Samara", year: "numeric", month: "2-digit", day: "2-digit" });
const readPeriod = (prefix) => Object.fromEntries(["enabled", "values", "from", "to", "source"].map(
  (key) => [key, document.querySelector(`#nomenclature-${prefix}-${key}`)],
));

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
  const receipts = readPeriod("receipt");
  const sales = readPeriod("sale");
  const salesCount = readPeriod("sales-count");
  const salesCountHeading = document.querySelector("#nomenclature-sales-count-heading");
  const salesCountError = document.querySelector("#nomenclature-sales-count-error");
  const oemEnabled = document.querySelector("#nomenclature-oem-enabled");
  const oemValues = document.querySelector("#nomenclature-oem-values");
  const oemPresence = document.querySelector("#nomenclature-oem-presence");
  const oemFilterBrand = document.querySelector("#nomenclature-oem-filter-brand");
  const filterSummary = document.querySelector("#nomenclature-filter-summary");
  let previousStockFilter;
  let defaultDay;
  const priceEnabled = document.querySelector("#nomenclature-price-enabled");
  const priceType = document.querySelector("#nomenclature-price-type");
  const priceHeading = document.querySelector("#nomenclature-stock-price-heading");
  const priceLabel = document.querySelector("#nomenclature-stock-price-label");
  const loadingCell = document.querySelector(".nomenclature-stock-loading-cell");
  const brand = document.querySelector("#nomenclature-oem-brand");
  const settings = document.querySelector("#nomenclature-search-settings");
  const menu = document.querySelector("#nomenclature-search-menu");
  let searchMode = "text";
  let navigationLoaded = false;
  let requestNavigation = true;
  const queries = { text: "", oem: "" };
  const navigation = createNomenclatureNavigation(() => { query = normalize(input.value); restart(); });
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
  const normalize = (value) => value.normalize("NFC").trim().toLocaleLowerCase("ru-RU").replace(/\s+/g, " ");
  const stop = () => { generation += 1; clearTimeout(timer); timer = undefined; controller?.abort(); controller = undefined; bufferedPage = undefined; busy = false; loading.hidden = true; moreLoading.hidden = true; retry.hidden = true; table.removeAttribute("aria-busy"); };
  const selectedPrice = () => priceEnabled.checked ? priceType.value : "";
  const selectedAvailability = () => availabilityEnabled.checked ? availability.value : "all";
  const showSalesCount = () => salesCount.enabled.checked && salesCount.from.value !== "" && salesCount.to.value !== ""
    && salesCount.from.value <= salesCount.to.value;
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
    if (!first && (sales.enabled.checked || showSalesCount() || query && searchMode === "text") && !nearEnd()) return;
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
      parameters.set("details", "1"); parameters.set("inventory", "1"); parameters.set("availability", selectedAvailability());
      for (const [prefix, period] of [["receipt", receipts], ["sale", sales]]) {
        if (!period.enabled.checked) continue;
        parameters.set(prefix + "From", period.from.value);
        parameters.set(prefix + "To", period.to.value);
        parameters.set(prefix + "Source", period.source.value);
      }
      if (showSalesCount()) {
        parameters.set("salesCountFrom", salesCount.from.value);
        parameters.set("salesCountTo", salesCount.to.value);
      }
      if (oemEnabled.checked) {
        parameters.set("oemPresence", oemPresence.value);
        if (oemFilterBrand.value) parameters.set("oemFilterBrand", oemFilterBrand.value);
      }
      parameters.set("searchMode", searchMode); parameters.set("navigation", requestNavigation ? "1" : "0");
      if (navigation.selected.category) parameters.set("category", navigation.selected.category);
      if (navigation.selected.group) parameters.set("group", navigation.selected.group);
      if (searchMode === "oem" && brand.value) parameters.set("oemBrand", brand.value);
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
          || showSalesCount() && !Number.isFinite(item.salesCount)
          || !item.incoming || ![item.incoming.original, item.incoming.replacement].every((count) => Number.isFinite(count) && count >= 0)
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
        if (requestNavigation) {
          navigation.update(value.navigation);
          for (const [select, label] of [[brand, "Все бренды OEM"], [oemFilterBrand, "Все марки"]]) {
            const selection = select.selectedOptions[0];
            const selectedBrand = selection?.value;
            select.replaceChildren(new Option(label, ""), ...value.navigation.oemBrands.map((item) => new Option(item.name, item.id)));
            if (selectedBrand) {
              if (!value.navigation.oemBrands.some((item) => item.id === selectedBrand)) select.append(selection);
              select.value = selectedBrand;
            }
          }
          navigationLoaded = true;
        }
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
    const today = stockDay.format(new Date());
    if (!defaultDay || receipts.from.value === defaultDay && receipts.to.value === defaultDay) {
      receipts.from.value = today;
      receipts.to.value = today;
    }
    if (!defaultDay) {
      sales.from.value = stockDay.format(new Date(Date.now() - 7 * 86_400_000));
      sales.to.value = today;
    }
    defaultDay = today;
    filterSummary.textContent = [
      selectedAvailability() === "available" ? "В наличии" : selectedAvailability() === "absent" ? "Отсутствуют" : "Все остатки",
      receipts.enabled.checked ? "Поступления" : "",
      sales.enabled.checked ? "Продажи" : "",
      showSalesCount() ? "Количество продаж" : "",
      oemEnabled.checked ? "OEM" : "",
      selectedPrice() ? priceType.selectedOptions[0]?.textContent : "",
    ].filter(Boolean).join(" · ");
    requestNavigation = !navigationLoaded;
    stop(); totalCount = undefined; renderer.reset(!!selectedPrice(), query, showSalesCount()); identities.clear(); cursors.clear();
    total = 0; nextCursor = null; blocked = false; table.hidden = !active;
    progress.textContent = "";
    priceHeading.hidden = !selectedPrice();
    priceLabel.textContent = selectedPrice() ? priceType.selectedOptions[0]?.textContent ?? "Цена" : "Цена";
    priceHeading.title = priceLabel.textContent;
    document.querySelector("#nomenclature-stock-title").textContent = selectedAvailability() === "available" ? "Товары в наличии" : "Номенклатура";
    table.querySelector("table").classList.toggle("has-price", !!selectedPrice());
    table.querySelector("table").classList.toggle("has-sales-count", showSalesCount());
    salesCountHeading.hidden = !showSalesCount();
    salesCountError.hidden = !salesCount.enabled.checked || showSalesCount();
    if (!showSalesCount() && sortField === "salesCount") { sortField = "id"; sortDirection = "asc"; }
    syncSortHeaders();
    const columnCount = 4 + Number(!!selectedPrice()) + Number(showSalesCount());
    for (const spacer of table.querySelectorAll(".nomenclature-stock-spacer")) spacer.colSpan = columnCount;
    loadingCell.colSpan = columnCount;
    if (!active) return;
    if ([receipts, sales].some(({ enabled, from, to }) => enabled.checked && (!from.value || !to.value || from.value > to.value))) {
      status.textContent = "Укажите начало и конец периода.";
      status.dataset.tone = "error";
    } else void load(true);
  };
  const search = () => {
    const nextQuery = normalize(input.value);
    if (nextQuery === query && !timer) return;
    stop(); totalCount = undefined; renderer.reset(!!selectedPrice(), nextQuery, showSalesCount()); identities.clear(); cursors.clear(); total = 0; nextCursor = null;
    table.hidden = false; blocked = true;
    status.textContent = ""; progress.textContent = "";
    timer = setTimeout(() => { query = nextQuery; restart(); }, nextQuery ? 300 : 0);
  };
  input.addEventListener("input", (event) => { if (!event.isComposing) search(); });
  input.addEventListener("compositionend", search);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const submitted = normalize(input.value);
    if (busy && !nextCursor && !timer && submitted === query) return;
    query = submitted;
    restart();
  });
  refresh.addEventListener("click", () => { navigationLoaded = false; query = normalize(input.value); restart(); });
  const closeMenu = () => { menu.hidden = true; settings.setAttribute("aria-expanded", "false"); };
  settings.addEventListener("click", () => { menu.hidden = !menu.hidden; settings.setAttribute("aria-expanded", String(!menu.hidden)); });
  document.addEventListener("click", (event) => { if (!event.target.closest(".nomenclature-search-settings")) closeMenu(); });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !menu.hidden) { closeMenu(); settings.focus(); } });
  for (const button of menu.querySelectorAll("[data-nomenclature-mode]")) button.addEventListener("click", () => {
    const next = button.dataset.nomenclatureMode;
    closeMenu();
    if (next === searchMode) return;
    queries[searchMode] = input.value; searchMode = next; input.value = queries[searchMode];
    input.placeholder = searchMode === "oem" ? "OEM-артикул" : "Название или артикул товара";
    input.setAttribute("aria-label", searchMode === "oem" ? "Поиск по OEM-артикулу" : "Поиск по наименованию или артикулу");
    brand.hidden = searchMode !== "oem";
    for (const item of menu.querySelectorAll("[data-nomenclature-mode]")) item.setAttribute("aria-pressed", String(item.dataset.nomenclatureMode === searchMode));
    query = normalize(input.value); restart(); input.focus();
  });
  brand.addEventListener("change", () => { query = normalize(input.value); restart(); });
  retry.addEventListener("click", () => { if (!active || busy) return; blocked = false; void load(); });
  const filterChanged = (event) => {
    if (event.target === salesCount.enabled && salesCount.enabled.checked) {
      const now = Date.now();
      salesCount.from.value ||= stockDay.format(new Date(now - 6 * 86_400_000));
      salesCount.to.value ||= stockDay.format(new Date(now));
    }
    if (event.target === sales.enabled) {
      if (sales.enabled.checked) {
        previousStockFilter = [availabilityEnabled.checked, availability.value];
        availability.value = "all";
      } else if (previousStockFilter) {
        [availabilityEnabled.checked, availability.value] = previousStockFilter;
      }
    }
    for (const period of [receipts, sales, salesCount]) period.values.hidden = !period.enabled.checked;
    oemValues.hidden = !oemEnabled.checked;
    availability.disabled = !availabilityEnabled.checked;
    priceType.disabled = !priceEnabled.checked;
    if (priceEnabled.checked && !priceType.value) { priceEnabled.checked = false; priceType.disabled = true; return; }
    if (!selectedPrice() && sortField === "price") { sortField = "id"; sortDirection = "asc"; }
    query = normalize(input.value); restart();
  };
  for (const control of [availabilityEnabled, availability, priceEnabled, priceType, oemEnabled, oemPresence, oemFilterBrand,
    ...[receipts, sales, salesCount].flatMap(({ enabled, from, to, source }) => [enabled, from, to, ...(source ? [source] : [])])]) {
    control.addEventListener("change", filterChanged);
  }
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
      if (active) { navigationLoaded = false; query = normalize(input.value); restart(); }
      else { stop(); renderer.reset(); identities.clear(); cursors.clear(); status.textContent = ""; progress.textContent = ""; table.hidden = true; }
    },
  };
}
