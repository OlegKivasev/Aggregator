const supplierNames = { armtek: "Armtek", "part-kom": "PartKOM", "forum-auto": "Forum Auto", rossko: "Rossko" };
const labels = { new: "Новый заказ", cancelled: "Отменено", received: "Получено", missing: "Проверьте заказ" };
const money = new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB" });
const date = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Samara" });
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const text = (value, max) => typeof value === "string" && value.length <= max;
const validFeed = (value) => value && integer(value.unreadCount) && integer(value.latestId)
  && integer(value.unreadCancellationCount) && value.unreadCancellationCount <= value.unreadCount
  && (value.nextBefore === null || integer(value.nextBefore) && value.nextBefore > 0)
  && (value.nextBefore === null ? value.nextBeforePriority === null : [0, 1].includes(value.nextBeforePriority))
  && Array.isArray(value.entries) && value.entries.length <= 30
  && value.entries.every((entry) => entry && integer(entry.id) && entry.id > 0 && entry.id <= value.latestId
    && Object.hasOwn(supplierNames, entry.supplier) && Object.hasOwn(labels, entry.kind)
    && text(entry.number, 200) && text(entry.createdAt, 32) && Number.isFinite(Date.parse(entry.createdAt))
    && typeof entry.read === "boolean" && integer(entry.remainingItems) && Array.isArray(entry.items) && entry.items.length <= 100
    && entry.items.every((item) => item && text(item.article, 200) && (item.brand === null || text(item.brand, 200))
      && (item.title === null || text(item.title, 500)) && Number.isFinite(item.quantity) && item.quantity > 0 && item.quantity <= 1_000_000_000
      && (item.price === null || Number.isFinite(item.price) && item.price >= 0 && item.price <= Number.MAX_SAFE_INTEGER)));

function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

export function bootstrapOrderNotifications() {
  const trigger = document.querySelector("#order-notifications-trigger");
  if (!trigger) return;
  const badge = document.querySelector("#order-notifications-count");
  const panel = element("section", "order-notifications-panel");
  panel.id = "order-notifications-panel"; panel.hidden = true;
  panel.setAttribute("role", "dialog"); panel.setAttribute("aria-labelledby", "order-notifications-title");
  panel.innerHTML = `<header><h2 id="order-notifications-title">Уведомления</h2><button type="button" class="order-notifications-close" aria-label="Закрыть уведомления">×</button></header>
    <div class="order-notifications-toolbar"><span id="order-notifications-summary" role="status"></span><button type="button" id="order-notifications-read" disabled>Прочитать все</button></div>
    <div class="order-notifications-error" role="alert" hidden><span></span><button type="button">Повторить</button></div>
    <div class="order-notifications-scroll"><div class="order-notifications-empty" hidden></div><ol class="order-notifications-list"></ol><button type="button" id="order-notifications-more" hidden>Показать ещё</button></div>`;
  document.body.append(panel);
  const list = panel.querySelector("ol");
  const scroll = panel.querySelector(".order-notifications-scroll");
  const empty = panel.querySelector(".order-notifications-empty");
  const error = panel.querySelector('[role="alert"]');
  const summary = panel.querySelector("#order-notifications-summary");
  const read = panel.querySelector("#order-notifications-read");
  const more = panel.querySelector("#order-notifications-more");
  const closeButton = panel.querySelector(".order-notifications-close");
  const entries = new Map();
  const expanded = new Set();
  const prioritized = new Set();
  let latestId = 0;
  let unreadCount = 0;
  let unreadCancellationCount = 0;
  let nextBefore = null;
  let nextBeforePriority = null;
  let loaded = false;
  let pending = false;
  let moreRequested = false;
  let refreshRequested = false;
  let timer = null;
  let controller = null;

  const readVisible = () => {
    if (panel.hidden || document.hidden || !loaded || pending || !error.hidden) return;
    const bounds = scroll.getBoundingClientRect();
    const ids = [...list.querySelectorAll(".is-unread .order-notification-card__number")].filter((node) => {
      const target = node.getBoundingClientRect();
      const width = Math.max(0, Math.min(bounds.right, target.right) - Math.max(bounds.left, target.left));
      const height = Math.max(0, Math.min(bounds.bottom, target.bottom) - Math.max(bounds.top, target.top));
      return target.width > 0 && target.height > 0 && width * height >= target.width * target.height / 2;
    }).map((node) => Number(node.closest("[data-notification-id]").dataset.notificationId)).slice(0, 100);
    if (ids.length) void request({ seen: { ids } });
  };
  const visibilityObserver = new IntersectionObserver(readVisible, { root: scroll, threshold: .5 });
  const observeVisible = () => {
    visibilityObserver.disconnect();
    if (!panel.hidden && !document.hidden) {
      for (const number of list.querySelectorAll(".is-unread .order-notification-card__number")) visibilityObserver.observe(number);
    }
  };

  const position = () => {
    if (panel.hidden) return;
    const anchor = trigger.getBoundingClientRect();
    const width = Math.min(460, innerWidth - 24);
    panel.style.width = `${width}px`;
    panel.style.left = `${Math.max(12, Math.min(anchor.right - width, innerWidth - width - 12))}px`;
    const top = Math.max(12, Math.min(anchor.bottom + 10, innerHeight - 180));
    panel.style.top = `${top}px`; panel.style.maxHeight = `${Math.max(150, innerHeight - top - 12)}px`;
  };
  const updateBadge = () => {
    badge.hidden = unreadCount === 0; badge.textContent = unreadCount > 99 ? "99+" : String(unreadCount);
    trigger.classList.toggle("has-unread", unreadCount > 0);
    trigger.classList.toggle("has-cancellations", unreadCancellationCount > 0);
    trigger.setAttribute("aria-label", unreadCount ? `Уведомления о заказах, непрочитанных: ${unreadCount}` : "Уведомления о заказах");
    summary.textContent = !loaded ? error.hidden ? "Загружаем…" : "Не удалось загрузить" : unreadCount ? `Непрочитанных: ${unreadCount}` : "Всё прочитано";
    read.disabled = pending || unreadCount === 0;
  };
  const render = () => {
    const focusedId = list.contains(document.activeElement) && document.activeElement.matches(".order-notification-card__expand")
      ? document.activeElement.closest("[data-notification-id]").dataset.notificationId : null;
    const anchor = scroll.scrollTop > 0 ? [...list.querySelectorAll("[data-notification-id]")]
      .find((card) => card.getBoundingClientRect().bottom > scroll.getBoundingClientRect().top) : null;
    const anchorId = anchor?.dataset.notificationId;
    const anchorTop = anchor?.getBoundingClientRect().top;
    visibilityObserver.disconnect();
    updateBadge(); list.replaceChildren();
    let previousRead = null;
    for (const entry of [...entries.values()].sort((a, b) => Number(prioritized.has(b.id)) - Number(prioritized.has(a.id)) || b.id - a.id)) {
      if (previousRead !== null && previousRead !== entry.read) {
        const label = entry.read ? "Прочитанные" : "Непрочитанные";
        const divider = element("li", `order-notifications-divider${entry.read ? "" : " is-unread"}`, label);
        divider.setAttribute("role", "separator"); divider.setAttribute("aria-label", label);
        list.append(divider);
      }
      previousRead = entry.read;
      const row = element("li");
      const card = element("article", `order-notification-card order-notification-card--${entry.kind}${entry.read ? "" : " is-unread"}`);
      card.dataset.notificationId = String(entry.id);
      const heading = element("div", "order-notification-card__heading");
      heading.append(element("strong", "order-notification-card__status", labels[entry.kind]), element("span", "order-notification-card__supplier", supplierNames[entry.supplier]));
      const number = element("div", "order-notification-card__number", `Заказ № ${entry.number}`);
      const time = element("time", "order-notification-card__time", date.format(new Date(entry.createdAt)));
      time.dateTime = entry.createdAt; time.title = "Самарское время (UTC+4)";
      card.append(heading, number);
      if (entry.kind === "missing") card.append(element("p", "order-notification-card__note", "Исчез из активных заказов Forum Auto. Уточните у поставщика: товар мог быть получен или отменён."));
      const products = element("ul", "order-notification-products");
      const visibleItems = expanded.has(entry.id) ? entry.items : entry.items.slice(0, 3);
      for (const item of visibleItems) {
        const product = element("li");
        const description = element("div");
        description.append(element("strong", "", [item.brand, item.article].filter(Boolean).join(" ")));
        if (item.title) description.append(element("span", "order-notification-products__title", item.title));
        const amount = element("div", "order-notification-products__amount");
        amount.append(element("strong", "", `${item.quantity.toLocaleString("ru-RU")} шт.`));
        if (item.price !== null) amount.append(element("span", "", money.format(item.quantity * item.price)));
        product.append(description, amount); products.append(product);
      }
      card.append(products);
      if (entry.items.length > 3) {
        const expand = element("button", "order-notification-card__expand", expanded.has(entry.id) ? "Свернуть товары" : `Ещё товаров: ${entry.items.length - 3}`);
        expand.type = "button"; expand.setAttribute("aria-expanded", String(expanded.has(entry.id)));
        expand.addEventListener("click", () => {
          if (expanded.has(entry.id)) expanded.delete(entry.id); else expanded.add(entry.id);
          render(); list.querySelector(`[data-notification-id="${entry.id}"] .order-notification-card__expand`)?.focus({ preventScroll: true });
        }); card.append(expand);
      }
      if (entry.remainingItems) card.append(element("p", "order-notification-card__note", `Ещё ${entry.remainingItems} позиций — в истории заказов.`));
      card.append(time); row.append(card); list.append(row);
    }
    empty.hidden = entries.size > 0;
    empty.textContent = loaded ? "Пока нет новых событий. Заказы проверяются автоматически каждые 10 минут с учётом настроенной ночной паузы. Первая проверка запоминает текущие заказы." : "Загружаем уведомления…";
    more.hidden = nextBefore === null; more.disabled = pending;
    if (anchorId) {
      const restored = list.querySelector(`[data-notification-id="${anchorId}"]`);
      if (restored) scroll.scrollTop += restored.getBoundingClientRect().top - anchorTop;
    }
    if (focusedId) list.querySelector(`[data-notification-id="${focusedId}"] .order-notification-card__expand`)?.focus({ preventScroll: true });
    observeVisible();
  };
  const close = (restoreFocus = true) => {
    visibilityObserver.disconnect();
    panel.hidden = true; trigger.setAttribute("aria-expanded", "false");
    if (restoreFocus) trigger.focus({ preventScroll: true });
  };
  const schedule = () => {
    clearTimeout(timer);
    if (!document.hidden) timer = setTimeout(() => void request(), 30_000);
  };
  const request = async ({ before = null, priority = null, seen = null, fresh = false } = {}) => {
    if (pending) { if (fresh) refreshRequested = true; else if (before !== null) moreRequested = true; return; }
    pending = true; updateBadge(); more.disabled = true;
    controller = new AbortController(); const active = controller;
    const timeout = setTimeout(() => active.abort(), 15_000);
    try {
      const response = await fetch(seen ? "/api/notifications/orders/seen" : `/api/notifications/orders${before === null ? "" : `?before=${before}&priority=${priority}`}`, {
        method: seen ? "POST" : "GET", signal: active.signal,
        ...(seen ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(seen) } : {}),
      });
      if (!response.ok) throw new Error("Notification request failed");
      const value = await response.json();
      if (!validFeed(value) || new Set(value.entries.map((entry) => entry.id)).size !== value.entries.length) throw new Error("Invalid notification feed");
      if (seen) for (const entry of entries.values()) {
        if (seen.ids ? seen.ids.includes(entry.id) : entry.id <= seen.throughId) entry.read = true;
      }
      const reset = before === null && (fresh || value.latestId > latestId);
      if (reset && (fresh || panel.hidden)) { entries.clear(); prioritized.clear(); }
      for (const entry of value.entries) {
        entries.set(entry.id, entry);
        if (!entry.read && entry.kind === "cancelled") prioritized.add(entry.id);
      }
      // A fresh head starts pagination again so a long absence cannot leave gaps in the feed.
      if (before !== null || !loaded || reset) { nextBefore = value.nextBefore; nextBeforePriority = value.nextBeforePriority; }
      unreadCount = value.unreadCount; unreadCancellationCount = value.unreadCancellationCount;
      latestId = value.latestId; loaded = true; error.hidden = true;
      if (panel.hidden) updateBadge(); else render();
    } catch {
      if (!active.signal.aborted || !document.hidden) {
        error.hidden = false; error.querySelector("span").textContent = seen ? "Не удалось отметить уведомления. Попробуйте ещё раз." : "Не удалось загрузить уведомления. Попробуйте ещё раз.";
        if (!loaded) empty.textContent = "Уведомления пока недоступны.";
      }
    } finally {
      clearTimeout(timeout); controller = null; pending = false; updateBadge(); more.disabled = false; schedule();
      const loadMore = moreRequested && nextBefore !== null && !panel.hidden;
      const refresh = refreshRequested && !panel.hidden;
      moreRequested = false;
      refreshRequested = false;
      if (refresh) void request({ fresh: true });
      else if (loadMore) void request({ before: nextBefore, priority: nextBeforePriority }); else readVisible();
    }
  };
  trigger.addEventListener("click", () => {
    if (!panel.hidden) { close(); return; }
    prioritized.clear();
    for (const entry of entries.values()) if (!entry.read && entry.kind === "cancelled") prioritized.add(entry.id);
    scroll.scrollTop = 0;
    panel.hidden = false; trigger.setAttribute("aria-expanded", "true"); render(); position(); closeButton.focus(); void request({ fresh: true });
  });
  closeButton.addEventListener("click", () => close());
  read.addEventListener("click", () => void request({ seen: { throughId: latestId } }));
  more.addEventListener("click", () => { if (nextBefore !== null) void request({ before: nextBefore, priority: nextBeforePriority }); });
  error.querySelector("button").addEventListener("click", () => void request());
  document.addEventListener("pointerdown", (event) => { if (!panel.hidden && !panel.contains(event.target) && !trigger.contains(event.target)) close(false); });
  document.addEventListener("keydown", (event) => {
    if (!panel.hidden && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
  });
  document.addEventListener("visibilitychange", () => {
    observeVisible();
    if (document.hidden) { clearTimeout(timer); controller?.abort(); } else void request();
  });
  window.addEventListener("resize", position);
  window.addEventListener("pagehide", () => { visibilityObserver.disconnect(); clearTimeout(timer); controller?.abort(); });
  window.addEventListener("pageshow", () => { observeVisible(); void request(); });
  void request();
}

if (typeof document !== "undefined") bootstrapOrderNotifications();
