const endpoint = "/api/purchasing/supplier-orders";
const quantity = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 3 });
const decimals = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const currencyCodes = { 643: "RUB", 810: "RUB", 840: "USD", 978: "EUR", 156: "CNY", 398: "KZT", 933: "BYN",
  826: "GBP", 784: "AED", 392: "JPY", 756: "CHF", 949: "TRY" };
const currencyFormats = new Map();

function formatMoney(value, currency) {
  if (value === null) return "—";
  const code = currencyCodes[currency] ?? currency;
  if (!/^[A-Z]{3}$/.test(code)) return decimals.format(value) + (code ? " " + code : "");
  if (!currencyFormats.has(code)) currencyFormats.set(code, new Intl.NumberFormat("ru-RU", { style: "currency", currency: code }));
  return currencyFormats.get(code).format(value);
}

function formatDate(date) {
  return date ? date.slice(0, 10).split("-").reverse().join(".") : "—";
}

function element(tag, content, className) {
  const node = document.createElement(tag);
  if (content !== undefined) node.textContent = content;
  if (className) node.className = className;
  return node;
}

function cell(row, value, className, label) {
  const node = element("td", undefined, className);
  node.setAttribute("role", "cell");
  if (label) {
    const caption = element("span", label, "supplier-orders-label");
    caption.setAttribute("aria-hidden", "true");
    node.append(caption);
  }
  node.append(typeof value === "string" ? element("span", value) : value);
  row.append(node);
  return node;
}

async function read(path, controller) {
  const response = await fetch(path, { signal: controller.signal });
  if (!response.ok) {
    const failure = await response.json().catch(() => null);
    throw new Error(failure?.message || "Не удалось получить данные из 1С.");
  }
  return response.json();
}

export function bootstrapSupplierOrders(section) {
  const byId = (id) => document.getElementById(id);
  const table = byId("supplier-orders-table");
  const rows = byId("supplier-orders-rows");
  const status = byId("supplier-orders-status");
  const refresh = byId("supplier-orders-refresh");
  const more = byId("supplier-orders-more");
  const pagination = byId("supplier-orders-pagination");
  const dialog = byId("supplier-order-dialog");
  const title = byId("supplier-order-title");
  const date = byId("supplier-order-date");
  const feedback = byId("supplier-order-status");
  const facts = byId("supplier-order-facts");
  const goodsTitle = byId("supplier-order-goods-title");
  const goodsTable = byId("supplier-order-goods");
  const footer = byId("supplier-order-footer");
  const total = byId("supplier-order-total");
  const retry = byId("supplier-order-retry");
  const open = byId("supplier-order-open");

  let active = false;
  let nextCursor = null;
  let listRead;
  let orderRead;
  let selected;
  const seen = new Set();

  function renderRow(order) {
    const row = element("tr");
    row.setAttribute("role", "row");
    const preview = element("button", undefined, "btn btn-light supplier-orders-preview");
    preview.type = "button";
    preview.title = "Быстрый просмотр";
    preview.setAttribute("aria-label", `Быстрый просмотр заказа № ${order.number}`);
    const eye = element("span", undefined, "supplier-orders-eye");
    eye.setAttribute("aria-hidden", "true");
    preview.append(eye);
    preview.addEventListener("click", () => void show(order, "preview"));

    const number = element("button", order.number, "repair-order-link supplier-orders-number");
    number.type = "button";
    number.setAttribute("aria-label", `Открыть заказ № ${order.number}`);
    number.addEventListener("click", () => void show(order, "order"));

    cell(row, preview, "supplier-orders-action");
    cell(row, formatDate(order.date), "supplier-orders-date");
    cell(row, number, "supplier-orders-link");
    cell(row, order.supplier || "—", "supplier-orders-supplier");
    cell(row, order.buyer || "—", order.buyer ? "supplier-orders-buyer" : "supplier-orders-blank", "Покупатель");
    cell(row, formatMoney(order.amount, order.currency), order.amount === null ? "supplier-orders-money supplier-orders-blank" : "supplier-orders-money", "Сумма");
    row.addEventListener("click", (event) => {
      if (event.target.closest("button") || !window.getSelection()?.isCollapsed) return;
      number.focus({ preventScroll: true });
      void show(order, "order");
    });
    return row;
  }

  async function loadList(append = false) {
    if (!active || listRead || append && !nextCursor) return;
    const controller = new AbortController();
    listRead = controller;
    refresh.disabled = more.disabled = true;
    section.setAttribute("aria-busy", "true");
    status.textContent = append ? "Загружаются следующие заказы…" : "Загружаются заказы…";
    try {
      const query = append ? `?after=${encodeURIComponent(nextCursor)}` : "";
      const page = await read(endpoint + query, controller);
      if (controller.signal.aborted) return;
      if (!append) {
        seen.clear();
        rows.replaceChildren();
      }
      const batch = document.createDocumentFragment();
      for (const order of page.orders) {
        if (seen.has(order.id)) continue;
        seen.add(order.id);
        batch.append(renderRow(order));
      }
      rows.append(batch);
      nextCursor = page.nextCursor;
      pagination.hidden = !nextCursor;
      table.hidden = !seen.size;
      status.textContent = seen.size ? "" : "Нет заказов поставщикам в работе.";
      if (append && !nextCursor) {
        const last = rows.lastElementChild?.querySelector(".supplier-orders-number");
        last?.focus({ preventScroll: true });
      }
    } catch (error) {
      if (!controller.signal.aborted) status.textContent = error.message;
    } finally {
      if (listRead === controller) {
        listRead = undefined;
        section.removeAttribute("aria-busy");
        refresh.disabled = more.disabled = false;
      }
    }
  }

  function renderProducts(products, order) {
    const detail = Boolean(order);
    const pricedSupplier = detail && !order.market;
    const titles = [["name", "Номенклатура"], ["article", "Артикул"], ["quantity", "Количество"]];
    if (pricedSupplier) titles.push(["price", "Цена"]);
    if (detail) titles.push(["stock", "Остаток"]);
    if (pricedSupplier) titles.push(["returnDays", "Дней на возврат"], ["expectedDate", "Дата поступления"], ["amount", "Сумма"]);
    if (detail) titles.push(["receipt", "Поступление"]);
    byId("supplier-order-columns").replaceChildren(...titles.map(([key, label]) => {
      const node = element("th", label, `supplier-order-${key}`);
      node.scope = "col";
      node.setAttribute("role", "columnheader");
      return node;
    }));
    const batch = document.createDocumentFragment();
    for (const product of products) {
      const row = element("tr");
      row.setAttribute("role", "row");
      const values = {
        ...product, article: product.article || "—", quantity: quantity.format(product.quantity),
        ...(detail && { stock: quantity.format(product.stock), returnDays: quantity.format(product.returnDays),
          price: formatMoney(product.price, order.currency), amount: formatMoney(product.amount, order.currency),
          expectedDate: formatDate(product.expectedDate) }),
      };
      for (const [key, label] of titles) {
        const node = cell(row, values[key], `supplier-order-${key}`, key === "name" ? "" : label);
        if (key === "stock" && product.stock <= 0) node.classList.add("supplier-order-no-stock");
        if (key === "receipt") node.dataset.receipt = product.receipt === "Пришёл" ? "received"
          : product.receipt.startsWith("Пришло ") ? "partial" : "waiting";
      }
      batch.append(row);
    }
    byId("supplier-order-products").replaceChildren(batch);
    goodsTable.hidden = !products.length;
    if (!products.length) feedback.textContent = "В заказе нет товаров.";
  }

  function renderOrder(order) {
    for (const [label, value] of [["Поставщик", order.supplier], ["Договор", order.contract], ["Заказ покупателя", order.buyer]]) {
      if (!value) continue;
      const fact = element("div");
      fact.append(element("dt", label), element("dd", value));
      facts.append(fact);
    }
    facts.hidden = !facts.childElementCount;
    goodsTitle.hidden = !order.products.length;
    if (order.amount !== null) {
      total.querySelector("strong").textContent = formatMoney(order.amount, order.currency);
      footer.hidden = total.hidden = false;
    }
    renderProducts(order.products, order);
  }

  async function show(order, view) {
    if (!active) return;
    orderRead?.abort();
    const controller = new AbortController();
    orderRead = controller;
    selected = { order, view };
    dialog.dataset.view = view;
    title.textContent = view === "preview" ? `Товары заказа № ${order.number}` : `Заказ поставщику № ${order.number}`;
    date.textContent = formatDate(order.date);
    facts.replaceChildren();
    facts.hidden = goodsTitle.hidden = goodsTable.hidden = retry.hidden = footer.hidden = total.hidden = open.hidden = true;
    byId("supplier-order-content").scrollTop = 0;
    feedback.textContent = "Загружаются товары…";
    if (!dialog.open) dialog.showModal();
    title.focus();
    try {
      const data = await read(`${endpoint}/${order.id}${view === "preview" ? "/preview" : ""}`, controller);
      if (controller.signal.aborted || !dialog.open) return;
      feedback.textContent = "";
      if (view === "preview") {
        renderProducts(data);
        footer.hidden = open.hidden = false;
      } else {
        title.textContent = `Заказ поставщику № ${data.number}`;
        date.textContent = formatDate(data.date);
        renderOrder(data);
      }
    } catch (error) {
      if (controller.signal.aborted || !dialog.open) return;
      feedback.textContent = error.message;
      retry.hidden = false;
    }
  }

  function clear() {
    active = false;
    listRead?.abort();
    listRead = undefined;
    orderRead?.abort();
    section.removeAttribute("aria-busy");
    refresh.disabled = more.disabled = false;
    rows.replaceChildren();
    seen.clear();
    nextCursor = null;
    table.hidden = pagination.hidden = true;
    status.textContent = "";
    if (dialog.open) dialog.close();
  }

  refresh.addEventListener("click", () => void loadList());
  more.addEventListener("click", () => void loadList(true));
  open.addEventListener("click", () => { if (selected) void show(selected.order, "order"); });
  retry.addEventListener("click", () => { if (selected) void show(selected.order, selected.view); });
  byId("supplier-order-back").addEventListener("click", () => dialog.close());
  byId("supplier-order-close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    if (dialog.open) return;
    orderRead?.abort();
    selected = orderRead = undefined;
    facts.replaceChildren();
    byId("supplier-order-products").replaceChildren();
  });
  document.addEventListener("aggregator-auth-ready", clear);
  return {
    setActive(name) {
      const user = window.aggregatorAuthState?.user;
      const allowed = user?.isAdmin || user?.permissions?.includes("purchasing");
      const next = name === "purchasing" && !section.hidden && allowed;
      if (next && !active) {
        active = true;
        void loadList();
      } else if (!next && active) clear();
    },
  };
}
