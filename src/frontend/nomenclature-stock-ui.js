const quantityFormat = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 3 });

export function bootstrapNomenclatureStock() {
  const status = document.querySelector("#nomenclature-stock-status");
  const table = document.querySelector("#nomenclature-stock-table");
  const rows = document.querySelector("#nomenclature-stock-rows");
  const refresh = document.querySelector("#nomenclature-stock-refresh");
  const previous = document.querySelector("#nomenclature-stock-previous");
  const next = document.querySelector("#nomenclature-stock-next");
  const pageLabel = document.querySelector("#nomenclature-stock-page");
  let active = false;
  let controller;
  let generation = 0;
  let cursors = [null];
  let index = 0;
  let nextCursor = null;
  const clear = () => { rows.replaceChildren(); table.hidden = true; nextCursor = null; };
  const stop = () => { generation += 1; controller?.abort(); controller = undefined; };
  const load = async () => {
    stop();
    clear();
    if (!active || document.hidden) return;
    const attempt = generation;
    const abort = new AbortController();
    controller = abort;
    previous.disabled = true;
    next.disabled = true;
    refresh.disabled = true;
    status.textContent = "Загружаем товары в наличии…";
    status.dataset.tone = "loading";
    pageLabel.textContent = "";
    try {
      const cursor = cursors[index];
      const response = await fetch(`/api/nomenclature/stock${cursor ? `?after=${encodeURIComponent(cursor)}` : ""}`, {
        cache: "no-store", signal: AbortSignal.any([abort.signal, AbortSignal.timeout(35_000)]),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value?.message || "Не удалось загрузить остатки из 1С.");
      if (!value || !Array.isArray(value.products) || value.products.length > 100 || typeof value.hasMore !== "boolean"
        || !Number.isFinite(Date.parse(value.receivedAt)) || (value.hasMore ? value.products.length !== 100
          || value.nextCursor !== value.products.at(-1)?.id || cursors.includes(value.nextCursor) : value.nextCursor !== null)
        || value.products.some((item) => !item || typeof item.name !== "string" || typeof item.article !== "string"
          || typeof item.quantity !== "number" || !Number.isFinite(item.quantity) || item.quantity <= 0)) {
        throw new Error("Получен некорректный список остатков. Повторите загрузку.");
      }
      if (attempt !== generation || !active) return;
      const fragment = document.createDocumentFragment();
      for (const product of value.products) {
        const row = document.createElement("tr");
        for (const text of [product.name, product.article || "—", quantityFormat.format(product.quantity)]) {
          const cell = document.createElement("td");
          cell.textContent = text;
          row.append(cell);
        }
        fragment.append(row);
      }
      rows.replaceChildren(fragment);
      table.hidden = value.products.length === 0;
      nextCursor = value.nextCursor;
      status.textContent = value.products.length ? `Получено из 1С в ${new Date(value.receivedAt).toLocaleTimeString("ru-RU")}`
        : index ? "На этой странице больше нет товаров в наличии. Обновите список." : "Товаров с положительным остатком нет.";
      status.dataset.tone = "notice";
      pageLabel.textContent = `Страница ${index + 1}`;
    } catch (error) {
      if (attempt !== generation || !active) return;
      status.textContent = error?.name === "TimeoutError" ? "1С не ответила вовремя. Повторите загрузку."
        : error instanceof Error ? error.message : "Не удалось загрузить остатки из 1С.";
      status.dataset.tone = "error";
    } finally {
      if (attempt === generation && active) {
        controller = undefined;
        refresh.disabled = false;
        previous.disabled = index === 0;
        next.disabled = !nextCursor;
      }
    }
  };
  refresh.addEventListener("click", () => { cursors = [null]; index = 0; void load(); });
  previous.addEventListener("click", () => { if (index) { index -= 1; void load(); } });
  next.addEventListener("click", () => {
    if (!nextCursor) return;
    cursors = cursors.slice(0, index + 1);
    cursors.push(nextCursor);
    index += 1;
    void load();
  });
  document.addEventListener("visibilitychange", () => { if (document.hidden) stop(); else if (active) void load(); });
  window.addEventListener("pagehide", stop);
  return {
    setActive(name) {
      const selected = name === "nomenclature";
      if (active === selected) return;
      active = selected;
      if (active) { cursors = [null]; index = 0; void load(); }
      else { stop(); clear(); status.textContent = ""; }
    },
  };
}
