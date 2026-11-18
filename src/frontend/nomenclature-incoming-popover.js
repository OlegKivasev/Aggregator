const amount = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 3 });
const date = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

function renderOrder(order) {
  const item = document.createElement("li");
  item.className = "nomenclature-incoming-order";
  const supplier = document.createElement("div");
  supplier.className = "nomenclature-incoming-supplier";
  supplier.textContent = [order.supplier || "Поставщик не указан", order.number && `№ ${order.number}`].filter(Boolean).join(" · ");
  const product = document.createElement("strong");
  product.textContent = order.article ? `${order.name} · ${order.article}` : order.name;
  const facts = document.createElement("dl");
  for (const [label, value] of [
    ["Заказано", order.ordered === null ? "—" : amount.format(order.ordered)],
    ["К поступлению", amount.format(order.quantity)],
    ["Ближайшая дата", order.expectedDate ? date.format(new Date(order.expectedDate)) : "Не указана"],
  ]) {
    const fact = document.createElement("div");
    const term = document.createElement("dt"); term.textContent = label;
    const detail = document.createElement("dd"); detail.textContent = value;
    fact.append(term, detail);
    facts.append(fact);
  }
  item.append(supplier, product, facts);
  return item;
}

export function createIncomingPopover(container = document.body, id = "nomenclature-incoming-popover") {
  const panel = document.createElement("section");
  panel.id = id;
  panel.className = "nomenclature-incoming-popover";
  panel.hidden = true;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-labelledby", `${id}-heading`);
  panel.innerHTML = `
    <header>
      <div><h3 tabindex="-1"></h3><p></p></div>
      <button class="nomenclature-incoming-close" type="button" aria-label="Закрыть поставки">×</button>
    </header>
    <div class="nomenclature-incoming-content">
      <ul></ul>
      <p role="status"></p>
      <button type="button" class="btn btn-light nomenclature-incoming-more" hidden>Показать ещё</button>
    </div>`;
  container.append(panel);
  const title = panel.querySelector("h3");
  title.id = `${id}-heading`;
  const subtitle = panel.querySelector("header p");
  const list = panel.querySelector("ul");
  const status = panel.querySelector("[role=status]");
  const content = panel.querySelector(".nomenclature-incoming-content");
  const more = panel.querySelector(".nomenclature-incoming-more");
  let anchor;
  let position;
  let request;
  let params;
  let endpoint;
  let frame;

  const close = (restoreFocus = false) => {
    request?.abort();
    request = undefined;
    if (!anchor) return;
    anchor.setAttribute("aria-expanded", "false");
    const previousAnchor = anchor;
    anchor = undefined;
    panel.hidden = true;
    if (restoreFocus && previousAnchor.isConnected) previousAnchor.focus({ preventScroll: true });
  };
  const reposition = () => {
    if (!anchor || frame !== undefined) return;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      if (!anchor.isConnected || rect.bottom <= 0 || rect.top >= window.innerHeight) { close(); return; }
      const { width, height } = panel.getBoundingClientRect();
      const x = rect.left + rect.width * position.x;
      const y = rect.top + rect.height * position.y;
      const below = y + 12;
      const above = y - height - 12;
      const top = below + height <= window.innerHeight - 8 ? below : above >= 8 ? above : window.innerHeight - height - 8;
      panel.style.left = `${Math.max(8, Math.min(x + 12, window.innerWidth - width - 8))}px`;
      panel.style.top = `${Math.max(8, top)}px`;
    });
  };
  const load = async () => {
    if (!anchor || request) return;
    const current = new AbortController();
    request = current;
    status.textContent = "Загружаются заказы…";
    more.hidden = true;
    reposition();
    try {
      const signal = AbortSignal.any([current.signal, AbortSignal.timeout(35_000)]);
      const url = new URL(endpoint, location.origin);
      for (const [key, value] of params) url.searchParams.set(key, value);
      const response = await fetch(url, { signal, cache: "no-store" });
      const data = await response.json();
      if (request !== current) return;
      if (!response.ok) throw new Error(data.message || "Не удалось загрузить заказы.");
      if (!Array.isArray(data.orders) || typeof data.hasMore !== "boolean" || data.hasMore && data.orders.length === 0) {
        throw new Error("Получен неполный список заказов.");
      }
      list.append(...data.orders.map(renderOrder));
      status.textContent = list.childElementCount ? "" : "Открытых поставок больше нет.";
      if (data.hasMore) {
        const last = data.orders.at(-1);
        params.set("after", `${last.orderId}.${last.productId}`);
        more.textContent = "Показать ещё";
        more.hidden = false;
      }
    } catch (error) {
      if (request !== current) return;
      status.textContent = error.name === "TimeoutError" ? "1С не ответила вовремя." :
        error instanceof TypeError || error instanceof SyntaxError ? "Не удалось загрузить заказы." : error.message;
      more.textContent = "Повторить";
      more.hidden = false;
    } finally {
      if (request === current) { request = undefined; reposition(); }
    }
  };
  panel.querySelector(".nomenclature-incoming-close").addEventListener("click", () => close(true));
  more.addEventListener("click", load);
  document.addEventListener("click", (event) => {
    if (anchor && !panel.contains(event.target) && !event.target.closest("[data-incoming-side]")) close();
  });
  document.addEventListener("keydown", (event) => {
    if (anchor && event.key === "Escape") { event.preventDefault(); close(true); }
  });
  window.addEventListener("scroll", reposition, { capture: true, passive: true });
  window.addEventListener("resize", reposition);
  return {
    open(button, product, event, source = "/api/nomenclature/incoming") {
      if (button === anchor) { close(true); return; }
      close();
      anchor = button;
      endpoint = source;
      const rect = button.getBoundingClientRect();
      position = event.detail && rect.width && rect.height ? {
        x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
        y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
      } : { x: 0.5, y: 1 };
      const side = button.dataset.incomingSide;
      params = new URLSearchParams({ product: product.id, side });
      title.textContent = side === "original" ? "Поставки оригинала" : "Поставки замен";
      subtitle.textContent = product.name;
      list.replaceChildren();
      panel.hidden = false;
      content.scrollTop = 0;
      button.setAttribute("aria-expanded", "true");
      title.focus({ preventScroll: true });
      void load();
    },
    close,
    reposition,
  };
}
