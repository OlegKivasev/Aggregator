import { formatOrderDate } from "./order-date-formatting.js";

const suppliers = [
  ["part-kom", "PartKOM"], ["armtek", "Armtek"], ["forum-auto", "Forum Auto"], ["rossko", "Rossko"],
];
const money = new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB" });
const fulfillmentLabels = new Map([
  ["processing", ["В обработке", "◷"]], ["in_transit", ["В пути", "→"]],
  ["ready", ["На складе", "▣"]], ["delivered", ["Получен", "✓"]],
  ["cancelled", ["Отменён", "×"]], ["partial", ["Частичная поставка", "◐"]],
  ["returned", ["Возвращён", "↶"]],
  ["unknown", ["Статус не уточнён", "?"]],
]);
const fulfillmentPriority = new Map([
  ["processing", 0], ["in_transit", 1], ["ready", 1], ["partial", 2],
  ["cancelled", 3], ["delivered", 4], ["returned", 5], ["unknown", 6],
]);
const statusGroups = new Map([
  ["", { label: "Все заказы", states: [] }],
  ["active", { label: "В работе", states: ["processing", "in_transit", "ready"] }],
  ["partial", { label: "Частичная поставка", states: ["partial"] }],
  ["cancelled", { label: "Отменено", states: ["cancelled"] }],
  ["delivered", { label: "Получено", states: ["delivered"] }],
  ["returned", { label: "Возвращено", states: ["returned"] }],
]);

function orderMatchesFilters(order, values) {
  const states = statusGroups.get(values.status).states;
  if (states.length && !order.items.some((item) => states.includes(item.fulfillment))) return false;
  if (!values.from && !values.to) return true;
  const date = order.date?.slice(0, 10);
  const parsed = typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00Z`) : null;
  return parsed && Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date
    && (!values.from || date >= values.from) && (!values.to || date <= values.to);
}

function element(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined) node.textContent = value;
  return node;
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
  appendMeta(header, "ordered", "Заказано", formatOrderDate(order.date) ?? "Не указана");
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
    delivery.append(element("strong", "", formatOrderDate(item.expectedDate) ?? "Не указана"));
    if (item.guaranteedDate && item.guaranteedDate !== item.expectedDate) {
      delivery.append(element("span", "", `Гарантировано: ${formatOrderDate(item.guaranteedDate)}`));
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
    <div class="cart-content history-content">
      <div class="history-status-tabs" id="history-status-tabs" role="tablist" aria-label="Статус заказа"></div>
      <form class="history-toolbar" id="history-toolbar" aria-label="Фильтры заказов" novalidate>
      <div class="history-period" id="history-period">
        <label>Дата заказа с <input type="date" id="history-from"></label>
        <label>по <input type="date" id="history-to"></label></div>
      <div class="history-actions"><button type="button" id="history-reset" hidden>Сбросить</button>
        <button type="button" id="history-reload">Обновить</button></div></form>
      <div id="history-results" role="tabpanel" aria-live="polite"></div></div>`;
  const tabs = dialog.querySelector("#history-tabs");
  const results = dialog.querySelector("#history-results");
  const from = dialog.querySelector("#history-from");
  const to = dialog.querySelector("#history-to");
  const reset = dialog.querySelector("#history-reset");
  const statusTabs = dialog.querySelector("#history-status-tabs");
  const views = [...suppliers, ["all", "Все поставщики"]];
  const dateValue = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const defaultPeriod = (end = new Date()) => {
    const start = new Date(end);
    start.setDate(start.getDate() - 29);
    return { from: dateValue(start), to: dateValue(end) };
  };
  const defaultFilters = (supplier) => {
    return { ...(supplier === "armtek" ? defaultPeriod() : { from: "", to: "" }), status: "" };
  };
  const defaults = new Map(views.map(([supplier]) => [supplier, defaultFilters(supplier)]));
  const filters = new Map([...defaults].map(([supplier, values]) => [supplier, { ...values }]));
  let selected = "part-kom";
  let histories = new Map();
  const saveFilters = () => {
    const values = filters.get(selected);
    filters.set(selected, { ...values, from: from.value, to: to.value });
  };
  const updateControls = () => {
    const values = filters.get(selected);
    const initial = defaults.get(selected);
    reset.hidden = values.status === "" && values.from === initial.from && values.to === initial.to;
    for (const button of tabs.children) button.setAttribute("aria-selected", String(button.dataset.supplier === selected));
    for (const button of statusTabs.children) button.setAttribute("aria-selected", String(button.dataset.status === values.status));
    results.setAttribute("aria-labelledby", `history-tab-${selected} history-status-${values.status || "all"}`);
  };
  const showFilters = () => {
    const values = filters.get(selected);
    from.value = values.from;
    to.value = values.to;
    from.required = to.required = selected === "armtek";
    updateControls();
  };

  const message = (value, error = false) => {
    results.replaceChildren(element("p", `history-message${error ? " is-error" : ""}`, value));
  };
  const filterError = () => {
    const values = filters.get(selected);
    if ([from, to].some((input) => !input.checkValidity() || input.value && !/^\d{4}-\d{2}-\d{2}$/.test(input.value))) {
      return "Укажите корректные даты заказа.";
    }
    return values.from && values.to && values.from > values.to
      ? "Выберите корректный период заказа: дата начала не должна быть позже даты окончания." : null;
  };
  const render = () => {
    if (!dialog.open) return;
    const error = filterError();
    if (error) { message(error, true); return; }
    const values = filters.get(selected);
    const fragment = document.createDocumentFragment();
    const orders = [];
    const loading = [];
    let failures = 0;
    let total = 0;
    for (const [supplier, history] of histories) {
      const name = suppliers.find(([id]) => id === supplier)[1];
      if (history.loading) loading.push(name);
      if (history.error) { fragment.append(element("p", "history-message is-error", `${name}: ${history.error}`)); failures++; }
      if (!history.payload) continue;
      total += history.payload.orders.length;
      for (const order of history.payload.orders) {
        if (orderMatchesFilters(order, values)) orders.push({ order, name, limited: history.payload.limited });
      }
    }
    if (loading.length) fragment.append(element("p", "history-loading", `Загружаем заказы: ${loading.join(", ")}…`));
    orders.sort((a, b) => (b.order.date ?? "").localeCompare(a.order.date ?? ""));
    for (const { order, name, limited } of orders) fragment.append(renderOrder(order, limited, name));
    if (!orders.length && !loading.length && !failures) {
      const empty = selected === "all" ? "В выбранной истории заказов нет."
        : `В выбранной истории ${suppliers.find(([id]) => id === selected)[1]} заказов нет.`;
      fragment.append(element("p", "history-message", total ? "По выбранным фильтрам заказов нет." : empty));
    }
    results.replaceChildren(fragment);
  };
  const requestSource = async (supplier, force = false) => {
    const name = suppliers.find(([id]) => id === supplier)[1];
    const params = new URLSearchParams();
    let queryError = null;
    if (supplier === "armtek") {
      const values = filters.get(selected);
      const period = defaultPeriod(values.to ? new Date(`${values.to}T12:00:00`) : new Date());
      const start = values.from || period.from;
      const end = values.to || period.to;
      if (start > end || Date.parse(end) - Date.parse(start) > 92 * 86400000) {
        queryError = "Выберите корректный период Armtek: не более 93 дней.";
      }
      params.set("from", start);
      params.set("to", end);
    }
    const key = params.toString();
    const previous = histories.get(supplier);
    if (!force && previous?.key === key) return;
    previous?.controller?.abort();
    const controller = new AbortController();
    const history = { controller, key, payload: null, error: queryError, loading: !queryError };
    histories.set(supplier, history);
    render();
    if (queryError) return;
    try {
      const response = await fetch(`/api/order-history/${supplier}${params.size ? `?${params}` : ""}`, { signal: controller.signal });
      const payload = await response.json();
      if (!response.ok) throw new Error(typeof payload?.message === "string" ? payload.message : "Не удалось получить историю заказов.");
      if (!validHistory(payload)) throw new Error(`${name} вернул некорректную историю заказов.`);
      if (controller.signal.aborted || histories.get(supplier) !== history || !dialog.open) return;
      history.payload = payload;
    } catch (error) {
      if (!controller.signal.aborted) history.error = error.message || "Не удалось получить историю заказов.";
    } finally {
      if (!controller.signal.aborted && histories.get(supplier) === history && dialog.open) { history.loading = false; render(); }
    }
  };
  const abortLoads = () => { for (const history of histories.values()) history.controller?.abort(); };
  const load = () => {
    abortLoads();
    histories = new Map();
    const error = filterError();
    if (error) { message(error, true); return; }
    const sources = selected === "all" ? suppliers : suppliers.filter(([id]) => id === selected);
    for (const [id] of sources) histories.set(id, { loading: true });
    for (const [id] of sources) void requestSource(id, true);
  };
  const applyFilters = () => {
    saveFilters();
    updateControls();
    if (!filterError() && !histories.size) { load(); return; }
    if (!filterError() && histories.has("armtek")) void requestSource("armtek");
    render();
  };
  for (const [id, name] of views) {
    const button = element("button", "cart-tab", name);
    if (id === "all") button.classList.add("history-tab--all");
    button.type = "button";
    button.id = `history-tab-${id}`;
    button.dataset.supplier = id;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-controls", "history-results");
    button.addEventListener("click", () => {
      if (selected !== id) { saveFilters(); selected = id; showFilters(); load(); }
    });
    tabs.append(button);
  }
  for (const [id, group] of statusGroups) {
    const button = element("button", `history-status-tab history-status-tab--${id || "all"}`, group.label);
    button.type = "button";
    button.id = `history-status-${id || "all"}`;
    button.dataset.status = id;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-controls", "history-results");
    if (id === "active") button.title = group.states.map((state) => fulfillmentLabels.get(state)[0]).join(", ");
    button.addEventListener("click", () => { filters.get(selected).status = id; updateControls(); render(); });
    statusTabs.append(button);
  }
  toggle.addEventListener("click", () => { showFilters(); document.body.append(dialog); dialog.showModal(); load(); });
  dialog.querySelector("#history-close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => { abortLoads(); histories.clear(); dialog.remove(); toggle.focus(); });
  dialog.querySelector("#history-toolbar").addEventListener("submit", (event) => { event.preventDefault(); applyFilters(); });
  for (const input of [from, to]) input.addEventListener("change", applyFilters);
  dialog.querySelector("#history-reload").addEventListener("click", load);
  reset.addEventListener("click", () => {
    const values = defaultFilters(selected);
    defaults.set(selected, values);
    filters.set(selected, { ...values });
    showFilters();
    applyFilters();
  });
}
