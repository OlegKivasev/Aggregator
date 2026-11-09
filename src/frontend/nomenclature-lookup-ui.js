const message = async (response, fallback) => {
  try { const value = await response.json(); return typeof value?.message === "string" ? value.message : fallback; } catch { return fallback; }
};
const readState = (value) => {
  if (!value || typeof value.configured !== "boolean" || typeof value.online !== "boolean") {
    throw new Error("Не удалось проверить подключение к 1С.");
  }
  return value;
};
const connectionText = (source) => !source?.configured ? "Подключение не настроено" : source.online ? "1С на связи" : "Нет связи с 1С";
const priceText = (price) => price === null ? "—" : new Intl.NumberFormat("ru-RU", {
  style: "currency", currency: price.currency, minimumFractionDigits: 2, maximumFractionDigits: 2,
}).format(price.amount);

export function bootstrapNomenclatureLookup() {
  const sourceStatus = document.querySelector("#nomenclature-source-status");
  const lookupStatus = document.querySelector("#nomenclature-lookup-feedback");
  const retry = document.querySelector("#nomenclature-lookup-retry");
  const choices = document.querySelector("#nomenclature-choices");
  const card = document.querySelector("#nomenclature-product");
  const title = document.querySelector("#nomenclature-product-name");
  const characteristic = document.querySelector("#nomenclature-product-characteristic");
  let state;
  let active = false;
  let generation = 0;
  let controller;
  let requestId;
  let lastBarcode = "";
  let sourcesPromise;

  const feedback = (text, tone = "notice") => { lookupStatus.textContent = text; lookupStatus.dataset.tone = tone; };
  const paintSource = () => {
    sourceStatus.textContent = connectionText(state);
    sourceStatus.dataset.tone = state?.online ? "success" : "notice";
  };
  const loadSources = () => {
    sourcesPromise = (async () => {
      const response = await fetch("/api/nomenclature/connection", { cache: "no-store", signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(await message(response, "Не удалось проверить подключение к 1С."));
      state = readState(await response.json());
      paintSource();
    })().catch(() => { state = undefined; sourceStatus.textContent = "Не удалось проверить подключение"; });
    return sourcesPromise;
  };
  const clear = () => {
    generation += 1;
    controller?.abort();
    controller = undefined;
    if (requestId) void fetch(`/api/nomenclature/lookups/${requestId}`, { method: "DELETE", keepalive: true }).catch(() => {});
    requestId = undefined;
    card.hidden = true;
    choices.replaceChildren();
    choices.hidden = true;
    retry.hidden = true;
    feedback("");
  };
  const showProduct = (product) => {
    title.textContent = product.name;
    characteristic.textContent = product.characteristicName ?? "";
    characteristic.hidden = !product.characteristicName;
    for (const key of ["purchase", "retail", "retailCashless"]) {
      document.querySelector(`[data-nomenclature-price="${key}"]`).textContent = priceText(product.prices[key]);
    }
    choices.hidden = true;
    card.hidden = false;
    feedback("");
    card.scrollIntoView({ block: "nearest" });
  };
  const validateLookup = (lookup, id, barcode) => {
    if (!lookup || typeof lookup.id !== "string" || !/^[a-f0-9-]{36}$/i.test(lookup.id) || (id && lookup.id !== id) || lookup.barcode !== barcode
      || !["pending", "found", "not_found", "error", "expired", "cancelled"].includes(lookup.status) || !Array.isArray(lookup.products)
      || lookup.products.length > 20 || !Number.isFinite(Date.parse(lookup.expiresAt))
      || lookup.products.some((product) => !product || typeof product.name !== "string" || !product.prices
        || !["purchase", "retail", "retailCashless"].every((key) => product.prices[key] === null
          || typeof product.prices[key]?.amount === "number" && Number.isFinite(product.prices[key].amount) && product.prices[key].amount >= 0
            && typeof product.prices[key].currency === "string" && /^[A-Z]{3}$/.test(product.prices[key].currency)))) {
      throw new Error("Получен некорректный ответ поиска. Повторите запрос.");
    }
    return lookup;
  };
  const start = async (barcode) => {
    clear();
    lastBarcode = barcode;
    if (!active) return;
    const attempt = generation;
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(new DOMException("Lookup timeout", "TimeoutError")), 40_000);
    controller = abort;
    feedback("Выполняется поиск", "loading");
    try {
      await (sourcesPromise ?? loadSources());
      if (attempt !== generation || !active) return;
      if (!state) throw new Error("Не удалось проверить подключение к 1С. Нажмите «Повторить поиск».");
      const response = await fetch("/api/nomenclature/lookups", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ barcode }), signal: abort.signal });
      if (!response.ok) throw new Error(await message(response, "Не удалось начать поиск товара."));
      let lookup = validateLookup((await response.json()).lookup, null, barcode);
      if (attempt !== generation) return;
      requestId = lookup.id;
      const deadline = Math.min(Date.parse(lookup.expiresAt) + 2000, Date.now() + 35_000);
      while (lookup.status === "pending") {
        if (Date.now() >= deadline) throw new Error("1С не ответила вовремя. Проверьте подключение и повторите поиск.");
        await new Promise((resolve, reject) => {
          const stopped = () => { clearTimeout(timer); reject(abort.signal.reason); };
          const timer = setTimeout(() => { abort.signal.removeEventListener("abort", stopped); resolve(); }, 650);
          if (abort.signal.aborted) stopped(); else abort.signal.addEventListener("abort", stopped, { once: true });
        });
        const poll = await fetch(`/api/nomenclature/lookups/${lookup.id}`, { cache: "no-store",
          signal: abort.signal });
        if (!poll.ok) throw new Error(await message(poll, "Не удалось получить карточку товара."));
        lookup = validateLookup((await poll.json()).lookup, requestId, barcode);
        if (attempt !== generation || !active) return;
      }
      requestId = undefined;
      if (lookup.status === "found" && lookup.products.length === 1) showProduct(lookup.products[0]);
      else if (lookup.status === "found" && lookup.products.length > 1) {
        feedback("По коду найдено несколько товаров. Выберите нужный.");
        choices.hidden = false;
        for (const product of lookup.products) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "btn btn-light";
          button.textContent = [product.name, product.characteristicName].filter(Boolean).join(" · ");
          button.addEventListener("click", () => { if (attempt === generation) showProduct(product); });
          choices.append(button);
        }
        choices.scrollIntoView({ block: "nearest" });
      } else if (lookup.status === "not_found") feedback("Товар с таким кодом в 1С не найден.");
      else throw new Error(lookup.status === "expired" ? "1С не ответила вовремя. Повторите поиск." : "1С не смогла получить карточку товара. Проверьте настройки и повторите поиск.");
      retry.hidden = false;
    } catch (error) {
      if (attempt !== generation || !active) return;
      feedback(error?.name === "TimeoutError" || abort.signal.reason?.name === "TimeoutError" ? "1С не ответила вовремя. Повторите поиск."
        : error instanceof Error ? error.message : "Не удалось получить карточку товара.", "error");
      retry.hidden = false;
    } finally { clearTimeout(timeout); }
  };
  retry.addEventListener("click", () => { void loadSources(); if (lastBarcode) void start(lastBarcode); });
  return {
    start,
    clear() { lastBarcode = ""; clear(); },
    setActive(name) { active = name === "nomenclature"; if (active) void loadSources(); else clear(); },
  };
}

export function bootstrapNomenclatureSettings() {
  const section = document.querySelector("#nomenclature-settings");
  const feedback = document.querySelector("#nomenclature-settings-feedback");
  const keyPanel = document.querySelector("#nomenclature-new-key");
  const keyInput = document.querySelector("#nomenclature-key-value");
  const drawer = document.querySelector("#settings-drawer");
  let state;
  let busy = false;
  let keyGeneration = 0;
  const clearKey = () => { keyGeneration += 1; keyInput.value = ""; keyPanel.hidden = true; };
  const paint = () => {
    section.querySelector("[data-connection-status]").textContent = connectionText(state);
    section.querySelector("[data-connection-key]").textContent = state.configured ? "Заменить ключ" : "Создать ключ";
    section.querySelector("[data-connection-disconnect]").disabled = !state.configured;
  };
  const request = async (path, options) => {
    if (busy) return;
    const attempt = keyGeneration;
    busy = true;
    feedback.textContent = "";
    section.querySelectorAll("button").forEach((element) => { element.disabled = true; });
    try {
      const response = await fetch(path, { cache: "no-store", ...options, signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(await message(response, "Не удалось сохранить настройки подключения."));
      const payload = await response.json();
      state = readState(payload);
      if (typeof payload.token === "string" && attempt === keyGeneration && section.open && !drawer.hidden) {
        keyInput.value = payload.token;
        keyPanel.hidden = false;
      }
    } catch (error) { feedback.textContent = error instanceof Error ? error.message : "Не удалось проверить подключение."; }
    finally {
      busy = false;
      section.querySelectorAll("button").forEach((element) => { element.disabled = false; });
      if (state) paint();
    }
  };
  section.addEventListener("toggle", () => { if (section.open) void request("/api/nomenclature/settings"); else clearKey(); });
  section.querySelector("summary").addEventListener("click", () => { if (section.open) clearKey(); });
  new MutationObserver(() => { if (drawer.hidden) clearKey(); }).observe(drawer, { attributes: true, attributeFilter: ["hidden"] });
  section.querySelector("[data-connection-key]").addEventListener("click", () => {
    if (state?.configured && !window.confirm("Заменить ключ? В 1С потребуется указать новый ключ подключения.")) return;
    clearKey();
    void request("/api/nomenclature/connection", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  });
  section.querySelector("[data-connection-disconnect]").addEventListener("click", () => {
    if (!window.confirm("Отключить поиск номенклатуры?")) return;
    clearKey();
    void request("/api/nomenclature/connection", { method: "DELETE" });
  });
  document.querySelector("#nomenclature-key-copy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(keyInput.value); }
    catch { keyInput.focus(); keyInput.select(); }
  });
}
