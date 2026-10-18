import { formatOrderDate } from "./order-date-formatting.js";
import { armtekReturnSource, formatArmtekReturnDays, hasPartKomWeekendDelivery } from "./order-notices.js";
import { historyItemRows } from "./order-history-presentation.js";

const suppliers = [
  ["part-kom", "PartKOM"], ["armtek", "Armtek"], ["forum-auto", "Forum Auto"], ["rossko", "Rossko"],
];
const money = new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB" });
const cancellationDate = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
const fulfillmentLabels = new Map([
  ["processing", ["В обработке", "◷"]], ["in_transit", ["В пути", "→"]],
  ["ready", ["На складе", "▣"]], ["delivered", ["Получен", "✓"]],
  ["cancelled", ["Отменён", "×"]],
  ["returned", ["Возвращён", "↶"]],
  ["unknown", ["Статус не уточнён", "?"]],
]);
const fulfillmentPriority = new Map([
  ["processing", 0], ["in_transit", 1], ["ready", 1],
  ["cancelled", 3], ["delivered", 4], ["returned", 5], ["unknown", 6],
]);
const acceptedFulfillments = new Set([...fulfillmentLabels.keys(), "partial", "partially_cancelled"]);
const statusGroups = new Map([
  ["", { label: "Все заказы", states: [] }],
  ["active", { label: "В работе", states: ["processing", "in_transit", "ready"] }],
  ["today", { label: "Придут сегодня", states: [] }],
  ["cancelled", { label: "Отменено", states: ["cancelled"] }],
  ["delivered", { label: "Получено", states: ["delivered"] }],
  ["returned", { label: "Возвращено", states: ["returned"] }],
]);

const dateValue = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

function orderMatchesFilters(order, values, today) {
  const terms = values.query.trim().toLocaleLowerCase("ru-RU").split(/\s+/).filter(Boolean);
  if (terms.length) {
    const text = [order.number, ...order.items.flatMap((item) => [item.article, item.brand, item.title])]
      .filter((value) => typeof value === "string").join(" ").toLocaleLowerCase("ru-RU");
    if (!terms.every((term) => text.includes(term))) return false;
  }
  const rows = order.items.flatMap(historyItemRows);
  const states = statusGroups.get(values.status).states;
  if (states.length && !rows.some((item) => states.includes(item.fulfillment))) return false;
  if (values.status === "today" && !rows.some((item) => {
    if (["delivered", "cancelled", "returned"].includes(item.fulfillment)) return false;
    const date = /^(\d{4}-\d{2}-\d{2})(?:[ T](?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?)?$/.exec(item.expectedDate ?? "")?.[1];
    return date === today;
  })) return false;
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
        && acceptedFulfillments.has(item.fulfillment)
        && item.quantity > 0 && item.quantity <= Number.MAX_SAFE_INTEGER
        && (item.cancelledQuantity === undefined || Number.isFinite(item.cancelledQuantity)
          && item.cancelledQuantity >= 0 && item.cancelledQuantity <= item.quantity)
        && (item.deliveredQuantity === undefined || Number.isFinite(item.deliveredQuantity)
          && item.deliveredQuantity >= 0 && item.deliveredQuantity <= item.quantity)
        && (item.cancelledQuantity ?? 0) + (item.deliveredQuantity ?? 0) <= item.quantity
        && (item.fulfillmentQuantities === undefined || item.fulfillment === "partially_cancelled"
          && item.fulfillmentQuantities && typeof item.fulfillmentQuantities === "object" && !Array.isArray(item.fulfillmentQuantities)
          && Number.isFinite(item.fulfillmentQuantities.delivered) && item.fulfillmentQuantities.delivered > 0
          && Number.isFinite(item.fulfillmentQuantities.cancelled) && item.fulfillmentQuantities.cancelled > 0
          && item.fulfillmentQuantities.delivered + item.fulfillmentQuantities.cancelled === item.quantity)
        && (item.price === null || Number.isFinite(item.price) && item.price >= 0 && item.price <= Number.MAX_SAFE_INTEGER)
        && [item.brand, item.title, item.status, item.expectedDate, item.guaranteedDate, item.warehouse]
          .every((field) => field === null || typeof field === "string")));
}

function validCancellationPage(value) {
  return value && typeof value === "object" && Number.isSafeInteger(value.total) && value.total >= 0
    && Array.isArray(value.notices) && value.notices.length === Math.min(value.total, 100)
    && new Set(value.notices.map((notice) => notice?.id)).size === value.notices.length
    && value.notices.every((notice) => notice && typeof notice.id === "string"
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(notice.id) && Number.isSafeInteger(notice.revision) && notice.revision > 0
      && suppliers.some(([id]) => id === notice.supplier) && typeof notice.detectedAt === "string"
      && Number.isFinite(Date.parse(notice.detectedAt)) && validHistory({ orders: [notice.order], limited: false })
      && notice.order.items.every((item) => item.fulfillment === "cancelled"));
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

function renderOrder(order, limited, supplierName, supplier) {
  const card = element("article", "history-card");
  const header = element("header", "history-card__header");
  const heading = element("div", "history-card__identity");
  heading.append(element("small", "", supplierName), element("h3", "", `Заказ № ${order.number}`));
  const states = new Map();
  const rows = order.items.flatMap(historyItemRows);
  for (const item of rows) states.set(item.fulfillment, (states.get(item.fulfillment) ?? 0) + 1);
  card.dataset.fulfillment = states.size === 1 ? states.keys().next().value : "mixed";
  card.classList.toggle("has-cancelled-items", states.has("cancelled"));
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
  const totalWrap = element("div", "history-card__total-wrap");
  const totalValue = element("strong", "history-card__total", total !== null && Number.isFinite(total) ? money.format(total) : "—");
  totalValue.title = total === null ? "Поставщик не передал цену для всех позиций" : "Сумма показанных позиций";
  totalWrap.append(totalValue);
  if (limited && total !== null) totalWrap.append(element("small", "history-card__total-note", "По показанным позициям"));
  header.append(totalWrap);
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
  for (const item of rows) {
    const row = element("tr");
    const part = element("td");
    part.append(element("strong", "", [item.brand, item.article].filter(Boolean).join(" ")));
    if (item.title) part.append(element("span", "", item.title));
    const delivery = element("td");
    const active = !["delivered", "cancelled", "returned"].includes(item.fulfillment);
    const highlightDelivery = active && hasPartKomWeekendDelivery(supplier, item.expectedDate);
    delivery.append(element("strong", highlightDelivery && item.expectedDate ? "delivery-date--warning" : "", formatOrderDate(item.expectedDate) ?? "Не указана"));
    if (item.guaranteedDate && item.guaranteedDate !== item.expectedDate) {
      const guaranteed = element("span", "", "Гарантировано: ");
      guaranteed.append(element("time", "", formatOrderDate(item.guaranteedDate)));
      delivery.append(guaranteed);
    }
    if (item.warehouse) delivery.append(element("span", "", item.warehouse));
    const status = element("td", "history-item-status");
    status.append(fulfillmentBadge(item.fulfillment));
    if (item.status) status.append(element("span", "history-status-detail", item.status));
    if (supplier === "armtek") {
      const terms = element("span", "order-return-terms", formatArmtekReturnDays(item.returnDays));
      if (Number.isInteger(item.returnDays) && item.returnDays >= 0 && item.returnDays <= 9999) {
        terms.title = armtekReturnSource;
        terms.append(element("small", "order-return-source", "Условия при оформлении"));
      }
      status.append(terms);
    }
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
      <section class="history-cancellation-notice" id="history-cancellation-notice" aria-labelledby="history-cancellation-title" hidden>
        <div aria-live="polite"><strong id="history-cancellation-title"></strong><p id="history-cancellation-description"></p></div>
        <div class="history-cancellation-actions">
          <button type="button" id="history-cancellation-view">Посмотреть</button>
          <button type="button" id="history-cancellation-done" hidden>Просмотрено, к истории</button>
          <button type="button" id="history-cancellation-back" hidden>К истории</button>
          <button type="button" id="history-cancellation-retry" hidden>Повторить проверку</button>
        </div>
      </section>
      <div class="history-status-tabs" id="history-status-tabs" role="tablist" aria-label="Статус заказа"></div>
      <form class="history-toolbar" id="history-toolbar" aria-label="Фильтры заказов" novalidate>
      <div class="history-period" id="history-period">
        <label>Дата заказа с <input type="date" id="history-from"></label>
        <label>по <input type="date" id="history-to"></label></div>
      <div class="history-actions"><button type="button" id="history-reset" hidden>Сбросить</button>
        <button type="button" id="history-reload">Обновить</button></div>
      <input type="search" class="history-search" id="history-search" maxlength="200" autocomplete="off" spellcheck="false"
        aria-label="Поиск в истории заказов" placeholder="Номер заказа, артикул, бренд или название товара"></form>
      <div id="history-results" role="tabpanel" aria-live="polite"></div></div>`;
  const tabs = dialog.querySelector("#history-tabs");
  const results = dialog.querySelector("#history-results");
  const from = dialog.querySelector("#history-from");
  const to = dialog.querySelector("#history-to");
  const search = dialog.querySelector("#history-search");
  const reset = dialog.querySelector("#history-reset");
  const statusTabs = dialog.querySelector("#history-status-tabs");
  const views = [...suppliers, ["all", "Все поставщики"]];
  const defaultPeriod = (end = new Date()) => {
    const start = new Date(end);
    start.setDate(start.getDate() - 29);
    return { from: dateValue(start), to: dateValue(end) };
  };
  const defaultFilters = (supplier) => {
    return { ...(supplier === "armtek" ? defaultPeriod() : { from: "", to: "" }), status: "", query: "" };
  };
  const defaults = new Map(views.map(([supplier]) => [supplier, defaultFilters(supplier)]));
  const filters = new Map([...defaults].map(([supplier, values]) => [supplier, { ...values }]));
  let selected = "part-kom";
  let histories = new Map();
  let cancellationPage = { notices: [], total: 0 };
  let cancellationController = null;
  let cancellationEpoch = 0;
  let cancellationRead = 0;
  let cancellationMutation = 0;
  let checkingCancellations = false;
  let lastCancellationScan = -Infinity;
  let cancellationError = "";
  let uncheckedSuppliers = [];
  let cancellationReview = null;
  let acknowledgingCancellations = false;
  let acknowledgmentController = null;
  const sharedHistoryRequests = new Map();
  const cancellationNotice = dialog.querySelector("#history-cancellation-notice");
  const cancellationView = dialog.querySelector("#history-cancellation-view");
  const cancellationDone = dialog.querySelector("#history-cancellation-done");
  const cancellationBack = dialog.querySelector("#history-cancellation-back");
  const cancellationRetry = dialog.querySelector("#history-cancellation-retry");
  const paintCancellations = () => {
    toggle.classList.toggle("has-cancellations", cancellationPage.total > 0);
    toggle.title = cancellationPage.total ? `История заказов: новые отмены — ${cancellationPage.total}` : "История заказов";
    toggle.setAttribute("aria-label", cancellationPage.total
      ? `Открыть историю заказов. Новые отмены: ${cancellationPage.total}.` : "Открыть историю заказов");
    if (!dialog.open) return;
    cancellationNotice.hidden = !checkingCancellations && !cancellationPage.total && !cancellationError && !uncheckedSuppliers.length && !cancellationReview;
    dialog.querySelector("#history-cancellation-title").textContent = cancellationPage.total
      ? `Новые отмены: ${cancellationPage.total}` : checkingCancellations ? "Проверяем отмены" : cancellationReview ? "Новые отмены" : "Не удалось проверить все отмены";
    const details = [];
    if (checkingCancellations) details.push("Проверяем историю всех поставщиков…");
    if (cancellationError) details.push(cancellationError);
    if (uncheckedSuppliers.length) details.push(`Не удалось проверить: ${uncheckedSuppliers.join(", ")}.`);
    if (cancellationReview && cancellationPage.total > cancellationReview.length) {
      details.push(`Показано ${cancellationReview.length} из ${cancellationPage.total}. Следующие отмены останутся непросмотренными.`);
    }
    if (!details.length && cancellationPage.total) details.push("Проверьте отменённые позиции и отметьте их просмотренными.");
    dialog.querySelector("#history-cancellation-description").textContent = details.join(" ");
    cancellationView.hidden = Boolean(cancellationReview) || !cancellationPage.notices.length;
    cancellationDone.hidden = !cancellationReview;
    cancellationBack.hidden = !cancellationReview;
    cancellationRetry.hidden = !cancellationError && !uncheckedSuppliers.length;
    cancellationRetry.disabled = checkingCancellations || acknowledgingCancellations;
    cancellationDone.disabled = cancellationBack.disabled = acknowledgingCancellations;
    cancellationDone.textContent = acknowledgingCancellations ? "Сохраняем…" : "Просмотрено, к истории";
    tabs.hidden = statusTabs.hidden = dialog.querySelector("#history-toolbar").hidden = Boolean(cancellationReview);
    dialog.querySelector("#history-title").textContent = cancellationReview ? "Новые отмены заказов" : "История заказов";
  };
  const saveFilters = () => {
    const values = filters.get(selected);
    filters.set(selected, { ...values, from: from.value, to: to.value, query: search.value });
  };
  const updateControls = () => {
    const values = filters.get(selected);
    const initial = defaults.get(selected);
    reset.hidden = values.status === "" && values.from === initial.from && values.to === initial.to && !values.query;
    for (const button of tabs.children) button.setAttribute("aria-selected", String(button.dataset.supplier === selected));
    for (const button of statusTabs.children) button.setAttribute("aria-selected", String(button.dataset.status === values.status));
    results.setAttribute("aria-labelledby", `history-tab-${selected} history-status-${values.status || "all"}`);
  };
  const showFilters = () => {
    const values = filters.get(selected);
    from.value = values.from;
    to.value = values.to;
    search.value = values.query;
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
    paintCancellations();
    if (cancellationReview) {
      const fragment = document.createDocumentFragment();
      for (const notice of cancellationReview) {
        const name = suppliers.find(([id]) => id === notice.supplier)[1];
        const card = renderOrder(notice.order, false, name, notice.supplier);
        card.dataset.cancellationId = notice.id;
        card.querySelector(".history-card__quantity > span").textContent = "Отменено позиций / штук";
        const total = card.querySelector(".history-card__total");
        if (total) total.title = "Сумма отменённых позиций";
        card.querySelector(".history-card__identity").append(element("small", "history-cancellation-time", `Обнаружено: ${cancellationDate.format(new Date(notice.detectedAt))}`));
        fragment.append(card);
      }
      results.setAttribute("aria-labelledby", "history-title");
      results.replaceChildren(fragment);
      return;
    }
    results.setAttribute("aria-labelledby", `history-tab-${selected} history-status-${filters.get(selected).status || "all"}`);
    const error = filterError();
    if (error) { message(error, true); return; }
    const values = filters.get(selected);
    const fragment = document.createDocumentFragment();
    const today = dateValue(new Date());
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
        if (orderMatchesFilters(order, values, today)) orders.push({ order, name, supplier, limited: history.payload.limited });
      }
    }
    if (loading.length) fragment.append(element("p", "history-loading", `Загружаем заказы: ${loading.join(", ")}…`));
    orders.sort((a, b) => (b.order.date ?? "").localeCompare(a.order.date ?? ""));
    for (const { order, name, supplier, limited } of orders) fragment.append(renderOrder(order, limited, name, supplier));
    if (!orders.length && !loading.length && !failures) {
      const empty = selected === "all" ? "В выбранной истории заказов нет."
        : `В выбранной истории ${suppliers.find(([id]) => id === selected)[1]} заказов нет.`;
      fragment.append(element("p", "history-message", total ? "По выбранным фильтрам заказов нет." : empty));
    }
    results.replaceChildren(fragment);
  };
  const fetchHistory = async (supplier, params, signal) => {
    const response = await fetch(`/api/order-history/${supplier}${params.size ? `?${params}` : ""}`, { signal });
    const payload = await response.json();
    if (!response.ok) throw new Error(typeof payload?.message === "string" ? payload.message : "Не удалось получить историю заказов.");
    if (!validHistory(payload)) throw new Error(`${suppliers.find(([id]) => id === supplier)[1]} вернул некорректную историю заказов.`);
    return payload;
  };
  const readCancellations = async (signal) => {
    const epoch = cancellationEpoch;
    const read = ++cancellationRead;
    const mutation = cancellationMutation;
    try {
      const response = await fetch("/api/order-cancellations", { signal });
      const page = await response.json();
      if (!response.ok || !validCancellationPage(page)) throw new Error("Не удалось загрузить уведомления об отменах.");
      if (signal.aborted || epoch !== cancellationEpoch || read !== cancellationRead || mutation !== cancellationMutation || acknowledgingCancellations) return;
      cancellationPage = page;
      cancellationError = "";
    } catch {
      if (signal.aborted || epoch !== cancellationEpoch || read !== cancellationRead || mutation !== cancellationMutation) return;
      cancellationError = "Не удалось загрузить уведомления об отменах. Повторите проверку.";
    }
    paintCancellations();
  };
  const scanCancellations = () => {
    lastCancellationScan = Date.now();
    cancellationController?.abort();
    cancellationController = new AbortController();
    const { signal } = cancellationController;
    const epoch = ++cancellationEpoch;
    checkingCancellations = true;
    uncheckedSuppliers = [];
    sharedHistoryRequests.clear();
    void readCancellations(signal);
    const loads = suppliers.map(([supplier, name]) => {
      const params = new URLSearchParams(supplier === "armtek" ? defaultPeriod() : {});
      const promise = fetchHistory(supplier, params, signal);
      sharedHistoryRequests.set(`${supplier}?${params}`, promise);
      return promise.then(() => null, () => name);
    });
    void Promise.all(loads).then(async (failures) => {
      if (signal.aborted || epoch !== cancellationEpoch) return;
      uncheckedSuppliers = failures.filter(Boolean);
      checkingCancellations = false;
      await readCancellations(signal);
      if (!signal.aborted && epoch === cancellationEpoch) paintCancellations();
    });
    paintCancellations();
  };
  const requestSource = async (supplier, force = false) => {
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
      const payload = await (sharedHistoryRequests.get(`${supplier}?${params}`) ?? fetchHistory(supplier, params, controller.signal));
      if (controller.signal.aborted || histories.get(supplier) !== history || !dialog.open) return;
      history.payload = payload;
      if (!checkingCancellations && cancellationController) void readCancellations(cancellationController.signal);
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
  toggle.addEventListener("click", () => {
    cancellationReview = null;
    showFilters(); document.body.append(dialog); dialog.showModal();
    scanCancellations(); load(); sharedHistoryRequests.clear();
  });
  dialog.querySelector("#history-close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    abortLoads(); cancellationController?.abort(); acknowledgmentController?.abort();
    cancellationEpoch++; cancellationRead++;
    histories.clear(); sharedHistoryRequests.clear(); dialog.remove(); toggle.focus();
  });
  dialog.querySelector("#history-toolbar").addEventListener("submit", (event) => { event.preventDefault(); applyFilters(); });
  for (const input of [from, to]) input.addEventListener("change", applyFilters);
  search.addEventListener("input", () => { filters.get(selected).query = search.value; updateControls(); render(); });
  search.addEventListener("keydown", (event) => { if (event.key === "Enter") event.preventDefault(); });
  dialog.querySelector("#history-reload").addEventListener("click", () => { scanCancellations(); load(); sharedHistoryRequests.clear(); });
  cancellationRetry.addEventListener("click", () => { scanCancellations(); sharedHistoryRequests.clear(); });
  cancellationView.addEventListener("click", () => {
    cancellationReview = cancellationPage.notices.slice();
    render(); cancellationDone.focus();
  });
  cancellationBack.addEventListener("click", () => { cancellationReview = null; render(); cancellationView.focus(); });
  cancellationDone.addEventListener("click", async () => {
    if (acknowledgingCancellations || !cancellationReview?.length) return;
    acknowledgmentController = new AbortController();
    const { signal } = acknowledgmentController;
    const epoch = cancellationEpoch;
    acknowledgingCancellations = true;
    cancellationMutation++;
    paintCancellations();
    try {
      const response = await fetch("/api/order-cancellations/seen", { method: "POST", signal, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notices: cancellationReview.map(({ id, revision }) => ({ id, revision })) }) });
      const page = await response.json();
      if (!response.ok || !validCancellationPage(page)) throw new Error("Не удалось сохранить просмотр отмен.");
      if (signal.aborted || epoch !== cancellationEpoch || !dialog.open) return;
      cancellationPage = page;
      cancellationError = "";
      cancellationReview = null;
    } catch {
      if (!signal.aborted && epoch === cancellationEpoch && dialog.open) cancellationError = "Не удалось сохранить просмотр отмен. Повторите попытку.";
    } finally {
      acknowledgingCancellations = false;
      cancellationMutation++;
      if (!signal.aborted && epoch === cancellationEpoch && dialog.open) {
        render();
        if (cancellationReview) cancellationDone.focus(); else dialog.querySelector("#history-close").focus();
        if (!cancellationReview && cancellationController) void readCancellations(cancellationController.signal);
      }
    }
  });
  reset.addEventListener("click", () => {
    const values = defaultFilters(selected);
    defaults.set(selected, values);
    filters.set(selected, { ...values });
    showFilters();
    applyFilters();
  });
  const checkBackgroundCancellations = () => {
    if (dialog.open || document.hidden || Date.now() - lastCancellationScan < 60_000) return;
    scanCancellations();
    sharedHistoryRequests.clear();
  };
  window.addEventListener("focus", checkBackgroundCancellations);
  document.addEventListener("visibilitychange", checkBackgroundCancellations);
  checkBackgroundCancellations();
}
