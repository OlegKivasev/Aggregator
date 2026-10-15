const suppliers = [
  ["part-kom", "PartKOM"], ["armtek", "Armtek"], ["forum-auto", "Forum Auto"], ["rossko", "Rossko"],
];
const money = new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB" });

function element(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined) node.textContent = value;
  return node;
}

function formatDate(value) {
  if (typeof value !== "string") return "Не указана";
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(value);
  return match ? `${match[3]}.${match[2]}.${match[1]}${match[4] ? ` ${match[4]}:${match[5]}` : ""}` : value;
}

function validHistory(value) {
  return value && typeof value === "object" && Array.isArray(value.orders) && value.orders.length <= 500
    && typeof value.limited === "boolean" && value.orders.every((order) => order && typeof order.number === "string"
      && (order.date === null || typeof order.date === "string") && Array.isArray(order.items) && order.items.length > 0
      && order.items.every((item) => item && typeof item.article === "string" && Number.isSafeInteger(item.quantity)
        && item.quantity > 0 && (item.price === null || Number.isFinite(item.price) && item.price >= 0)
        && [item.brand, item.title, item.status, item.expectedDate, item.guaranteedDate, item.warehouse]
          .every((field) => field === null || typeof field === "string")));
}

function appendMeta(parent, label, value) {
  const meta = element("div", "history-card__meta");
  meta.append(element("span", "", label), element("strong", "", value));
  parent.append(meta);
}

function renderOrder(order, limited) {
  const card = element("article", "history-card");
  const header = element("header", "history-card__header");
  const heading = element("div");
  heading.append(element("small", "", "PartKOM"), element("h3", "", `Заказ № ${order.number}`));
  header.append(heading);
  appendMeta(header, "Заказано", formatDate(order.date));
  appendMeta(header, "Позиций / штук", `${order.items.length} / ${order.items.reduce((sum, item) => sum + item.quantity, 0)}`);
  const total = order.items.every((item) => item.price !== null)
    ? order.items.reduce((sum, item) => sum + item.price * item.quantity, 0) : null;
  if (!limited && total !== null && Number.isFinite(total)) header.append(element("strong", "history-card__total", money.format(total)));
  card.append(header);

  const wrap = element("div", "history-card__table-wrap");
  const table = element("table");
  const thead = element("thead");
  const headRow = element("tr");
  for (const title of ["Запчасть", "Доставка", "Статус", "Цена × кол-во", "Сумма"]) headRow.append(element("th", "", title));
  thead.append(headRow);
  const tbody = element("tbody");
  for (const item of order.items) {
    const row = element("tr");
    const part = element("td");
    part.append(element("strong", "", [item.brand, item.article].filter(Boolean).join(" ")));
    if (item.title) part.append(element("span", "", item.title));
    const delivery = element("td");
    delivery.append(element("strong", "", formatDate(item.expectedDate)));
    if (item.guaranteedDate && item.guaranteedDate !== item.expectedDate) {
      delivery.append(element("span", "", `Гарантировано: ${formatDate(item.guaranteedDate)}`));
    }
    if (item.warehouse) delivery.append(element("span", "", item.warehouse));
    const status = element("td", "", item.status ?? "Не указан");
    const price = element("td", "history-number", item.price === null ? `— × ${item.quantity} шт.` : `${money.format(item.price)} × ${item.quantity} шт.`);
    const sum = element("td", "history-number", item.price === null ? "—" : money.format(item.price * item.quantity));
    row.append(part, delivery, status, price, sum);
    tbody.append(row);
  }
  table.append(thead, tbody);
  wrap.append(table);
  card.append(wrap);
  return card;
}

export function bootstrapOrderHistory() {
  const toggle = document.querySelector("#history-toggle");
  if (!toggle) return;
  const dialog = element("dialog", "cart-modal history-modal");
  dialog.id = "history-modal";
  dialog.setAttribute("aria-labelledby", "history-title");
  dialog.innerHTML = `<header class="analogs-modal__header"><h2 id="history-title">История заказов</h2>
    <button type="button" class="btn btn-light analogs-modal__close" id="history-close" aria-label="Закрыть историю заказов">×</button></header>
    <div class="cart-tabs" id="history-tabs" role="tablist" aria-label="Поставщики"></div>
    <div class="cart-content history-content"><div class="history-toolbar" id="history-toolbar">
      <button type="button" id="history-current" aria-pressed="true">Текущие</button>
      <button type="button" id="history-archive" aria-pressed="false">Архив</button>
      <button type="button" class="history-reload" id="history-reload">Обновить</button></div>
      <div id="history-results" role="status" aria-live="polite"></div></div>`;
  document.body.append(dialog);
  const tabs = dialog.querySelector("#history-tabs");
  const results = dialog.querySelector("#history-results");
  const toolbar = dialog.querySelector("#history-toolbar");
  const current = dialog.querySelector("#history-current");
  const archived = dialog.querySelector("#history-archive");
  let selected = "part-kom";
  let archive = false;
  let pending = null;

  const message = (value, error = false) => {
    results.replaceChildren(element("p", `history-message${error ? " is-error" : ""}`, value));
  };
  const load = async () => {
    pending?.abort();
    if (selected !== "part-kom") {
      toolbar.hidden = true;
      message(`История заказов ${suppliers.find(([id]) => id === selected)?.[1]} пока не подключена.`);
      return;
    }
    toolbar.hidden = false;
    const controller = new AbortController();
    pending = controller;
    message("Загружаем заказы PartKOM…");
    try {
      const response = await fetch(`/api/order-history/part-kom?archive=${archive ? "1" : "0"}`, { signal: controller.signal });
      const payload = await response.json();
      if (!response.ok) throw new Error(typeof payload?.message === "string" ? payload.message : "Не удалось получить историю заказов.");
      if (!validHistory(payload)) throw new Error("PartKOM вернул некорректную историю заказов.");
      if (controller.signal.aborted || !dialog.open) return;
      if (!payload.orders.length) {
        message(archive ? "В архиве PartKOM заказов нет." : "Текущих заказов PartKOM нет.");
        return;
      }
      const fragment = document.createDocumentFragment();
      if (payload.limited) fragment.append(element("p", "history-limit", "Показаны первые 500 позиций. Для полной истории используйте кабинет PartKOM."));
      for (const order of payload.orders) fragment.append(renderOrder(order, payload.limited));
      results.replaceChildren(fragment);
    } catch (error) {
      if (!controller.signal.aborted && dialog.open) message(error.message || "Не удалось получить историю заказов.", true);
    } finally {
      if (pending === controller) pending = null;
    }
  };
  const updateTabs = () => {
    tabs.replaceChildren();
    for (const [id, name] of suppliers) {
      const button = element("button", "cart-tab", name);
      button.type = "button";
      button.id = `history-tab-${id}`;
      button.setAttribute("role", "tab");
      button.setAttribute("aria-selected", String(selected === id));
      button.addEventListener("click", () => { if (selected !== id) { selected = id; updateTabs(); void load(); } });
      tabs.append(button);
    }
  };
  toggle.addEventListener("click", () => { updateTabs(); dialog.showModal(); void load(); });
  dialog.querySelector("#history-close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => { pending?.abort(); toggle.focus(); });
  current.addEventListener("click", () => {
    if (archive) { archive = false; current.setAttribute("aria-pressed", "true"); archived.setAttribute("aria-pressed", "false"); void load(); }
  });
  archived.addEventListener("click", () => {
    if (!archive) { archive = true; archived.setAttribute("aria-pressed", "true"); current.setAttribute("aria-pressed", "false"); void load(); }
  });
  dialog.querySelector("#history-reload").addEventListener("click", () => void load());
}
