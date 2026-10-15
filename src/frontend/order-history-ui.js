const suppliers = [
  ["part-kom", "PartKOM"], ["armtek", "Armtek"], ["forum-auto", "Forum Auto"], ["rossko", "Rossko"],
];
const money = new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB" });
const fulfillmentLabels = new Map([
  ["processing", ["В обработке", "◷"]], ["in_transit", ["В пути", "→"]],
  ["ready", ["На складе", "▣"]], ["delivered", ["Получен", "✓"]],
  ["cancelled", ["Отменён", "×"]], ["partial", ["Частичная поставка", "◐"]],
  ["returned", ["Возвращён", "↶"]], ["attention", ["Требует внимания", "!"]],
  ["unknown", ["Статус не уточнён", "?"]],
]);
const fulfillmentPriority = new Map([
  ["processing", 0], ["in_transit", 1], ["ready", 1], ["partial", 2],
  ["cancelled", 3], ["delivered", 4], ["returned", 5], ["attention", 6], ["unknown", 7],
]);

function orderPriority(order) {
  return order.items.reduce((priority, item) => Math.min(priority, fulfillmentPriority.get(item.fulfillment)), Infinity);
}

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
      && order.items.every((item) => item && typeof item.article === "string" && Number.isFinite(item.quantity)
        && fulfillmentLabels.has(item.fulfillment)
        && item.quantity > 0 && item.quantity <= Number.MAX_SAFE_INTEGER
        && (item.price === null || Number.isFinite(item.price) && item.price >= 0 && item.price <= Number.MAX_SAFE_INTEGER)
        && [item.brand, item.title, item.status, item.expectedDate, item.guaranteedDate, item.warehouse]
          .every((field) => field === null || typeof field === "string")));
}

function appendMeta(parent, name, label, value) {
  const meta = element("div", `history-card__meta history-card__${name}`);
  meta.append(element("span", "", label), element("strong", "", value));
  parent.append(meta);
}

function fulfillmentBadge(fulfillment, count) {
  const [label, symbol] = fulfillmentLabels.get(fulfillment);
  const badge = element("span", `history-status history-status--${fulfillment}`);
  const icon = element("b", "history-status__icon", symbol);
  icon.setAttribute("aria-hidden", "true");
  badge.append(icon, document.createTextNode(count === undefined ? label : `${label} · ${count}`));
  return badge;
}

function renderOrder(order, limited, supplierName) {
  const card = element("article", "history-card");
  const header = element("header", "history-card__header");
  const heading = element("div", "history-card__identity");
  heading.append(element("small", "", supplierName), element("h3", "", `Заказ № ${order.number}`));
  const states = new Map();
  for (const item of order.items) states.set(item.fulfillment, (states.get(item.fulfillment) ?? 0) + 1);
  card.dataset.fulfillment = states.size === 1 ? states.keys().next().value : "mixed";
  const summary = element("div", "history-card__states");
  summary.setAttribute("aria-label", limited ? "Состояние показанных позиций" : "Состояние позиций заказа");
  for (const [state, count] of [...states].sort(([a], [b]) => fulfillmentPriority.get(a) - fulfillmentPriority.get(b))) {
    summary.append(fulfillmentBadge(state, states.size > 1 ? count : undefined));
  }
  heading.append(summary);
  header.append(heading);
  appendMeta(header, "ordered", "Заказано", formatDate(order.date));
  appendMeta(header, "quantity", limited ? "Показано позиций / штук" : "Позиций / штук", `${order.items.length} / ${order.items.reduce((sum, item) => sum + item.quantity, 0)}`);
  const total = order.items.every((item) => item.price !== null)
    ? order.items.reduce((sum, item) => sum + item.price * item.quantity, 0) : null;
  if (!limited && total !== null && Number.isFinite(total)) header.append(element("strong", "history-card__total", money.format(total)));
  card.append(header);

  const wrap = element("div", "history-card__table-wrap");
  const table = element("table");
  const columns = element("colgroup");
  for (const name of ["part", "delivery", "status", "price", "sum"]) columns.append(element("col", `history-column--${name}`));
  const thead = element("thead");
  const headRow = element("tr");
  for (const [index, title] of ["Запчасть", "Доставка", "Статус", "Цена × кол-во", "Сумма"].entries()) {
    const th = element("th", index >= 3 ? "history-number" : "", title);
    th.scope = "col";
    headRow.append(th);
  }
  thead.append(headRow);
  const tbody = element("tbody");
  for (const item of order.items) {
    const row = element("tr");
    const part = element("td");
    part.append(element("strong", "", [item.brand, item.article].filter(Boolean).join(" ")));
    if (item.title) part.append(element("span", "", item.title));
    const delivery = element("td");
    if (supplierName === "Rossko" && item.expectedDate) delivery.append(element("span", "", "Желаемая дата"));
    delivery.append(element("strong", "", formatDate(item.expectedDate)));
    if (item.guaranteedDate && item.guaranteedDate !== item.expectedDate) {
      delivery.append(element("span", "", `Гарантировано: ${formatDate(item.guaranteedDate)}`));
    }
    if (item.warehouse) delivery.append(element("span", "", item.warehouse));
    const status = element("td", "history-item-status");
    status.append(fulfillmentBadge(item.fulfillment));
    if (item.status) status.append(element("span", "history-status-detail", item.status));
    const price = element("td", "history-number");
    price.append(element("strong", "", item.price === null ? "—" : money.format(item.price)), element("span", "", `${item.quantity} шт.`));
    const sum = element("td", "history-number", item.price === null ? "—" : money.format(item.price * item.quantity));
    row.append(part, delivery, status, price, sum);
    tbody.append(row);
  }
  table.append(columns, thead, tbody);
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
      <div class="history-period" id="history-period" hidden>
        <label>С <input type="date" id="history-from" required></label>
        <label>По <input type="date" id="history-to" required></label></div>
      <button type="button" class="history-reload" id="history-reload">Обновить</button></div>
      <p class="history-scope" id="history-scope" hidden></p>
      <div id="history-results" role="status" aria-live="polite"></div></div>`;
  const tabs = dialog.querySelector("#history-tabs");
  const results = dialog.querySelector("#history-results");
  const period = dialog.querySelector("#history-period");
  const from = dialog.querySelector("#history-from");
  const to = dialog.querySelector("#history-to");
  const scope = dialog.querySelector("#history-scope");
  const reload = dialog.querySelector("#history-reload");
  const dateValue = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const today = new Date();
  to.value = dateValue(today);
  today.setDate(today.getDate() - 29);
  from.value = dateValue(today);
  let selected = "part-kom";
  let pending = null;

  const message = (value, error = false) => {
    results.replaceChildren(element("p", `history-message${error ? " is-error" : ""}`, value));
  };
  const load = async () => {
    pending?.abort();
    const supplier = selected;
    const name = suppliers.find(([id]) => id === supplier)[1];
    period.hidden = supplier !== "armtek";
    reload.textContent = supplier === "armtek" ? "Показать" : "Обновить";
    scope.textContent = supplier === "armtek" ? "Заказы за выбранный период, не более 93 дней. По умолчанию — последние 30 дней."
      : supplier === "forum-auto" ? "Активные заказы. API Forum Auto не возвращает общую историю аннулированных и выданных заказов."
        : supplier === "rossko" ? "Последние 500 заказов Rossko, включая отгруженные и отменённые." : "";
    scope.hidden = !scope.textContent;
    const controller = new AbortController();
    pending = controller;
    try {
      const params = new URLSearchParams();
      if (supplier === "armtek") {
        if (!from.value || !to.value || !from.checkValidity() || !to.checkValidity() || from.value > to.value
          || Date.parse(to.value) - Date.parse(from.value) > 92 * 86400000) {
          throw new Error("Выберите корректный период Armtek: не более 93 дней.");
        }
        params.set("from", from.value);
        params.set("to", to.value);
      }
      message(`Загружаем заказы ${name}…`);
      const response = await fetch(`/api/order-history/${supplier}${params.size ? `?${params}` : ""}`, { signal: controller.signal });
      const payload = await response.json();
      if (!response.ok) throw new Error(typeof payload?.message === "string" ? payload.message : "Не удалось получить историю заказов.");
      if (!validHistory(payload)) throw new Error(`${name} вернул некорректную историю заказов.`);
      if (controller.signal.aborted || !dialog.open) return;
      if (!payload.orders.length) {
        message(`В выбранной истории ${name} заказов нет.`);
        return;
      }
      const fragment = document.createDocumentFragment();
      if (payload.limited) fragment.append(element("p", "history-limit", `Показана ограниченная выборка заказов и позиций. Для полной истории используйте кабинет ${name}.`));
      const orders = [...payload.orders].sort((a, b) => orderPriority(a) - orderPriority(b)
        || (b.date ?? "").localeCompare(a.date ?? ""));
      for (const order of orders) fragment.append(renderOrder(order, payload.limited, name));
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
  toggle.addEventListener("click", () => { updateTabs(); document.body.append(dialog); dialog.showModal(); void load(); });
  dialog.querySelector("#history-close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => { pending?.abort(); dialog.remove(); toggle.focus(); });
  reload.addEventListener("click", () => void load());
}
