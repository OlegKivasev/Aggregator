import { createIncomingPopover } from "./nomenclature-incoming-popover.js?v=stock-popup-1";
import { stockQuantity } from "./stock-details.js?v=stock-popup-1";

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

function createNoteEditor() {
  const dialog = document.getElementById("supplier-note-dialog");
  const form = document.getElementById("supplier-note-form");
  const productName = document.getElementById("supplier-note-product");
  const text = document.getElementById("supplier-note-text");
  const status = document.getElementById("supplier-note-status");
  const current = document.getElementById("supplier-note-current");
  const cancel = document.getElementById("supplier-note-cancel");
  const save = document.getElementById("supplier-note-save");
  let editing;

  function setSaving(saving) {
    text.readOnly = save.disabled = cancel.disabled = saving;
  }

  cancel.addEventListener("click", () => dialog.close());
  dialog.addEventListener("cancel", (event) => {
    if (save.disabled) event.preventDefault();
  });
  dialog.addEventListener("close", () => {
    if (dialog.open) return;
    editing = undefined;
    text.value = current.textContent = productName.textContent = status.textContent = "";
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const state = editing;
    if (!state || save.disabled) return;
    const draft = text.value.trim();
    if (draft === (state.product.note?.text ?? "")) {
      dialog.close();
      return;
    }
    setSaving(true);
    status.textContent = "Сохраняем…";
    try {
      const response = await fetch(`${endpoint}/${state.orderId}/items/${state.product.noteKey}/note`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: draft, revision: state.product.note?.revision ?? null }),
        signal: AbortSignal.timeout(10000),
      });
      const result = await response.json().catch(() => null);
      if (editing !== state || !dialog.open) return;
      if (!result || !response.ok && response.status !== 409) {
        status.textContent = result?.message || "Не удалось сохранить заметку. Повторите попытку.";
        return;
      }
      state.product.note = result.note;
      state.updateButton();
      if (response.ok) {
        dialog.close();
      } else {
        status.textContent = "Заметку уже изменили. Сверьте текст и сохраните снова.";
        current.textContent = result.note?.text ?? "Заметка очищена.";
        current.hidden = false;
      }
    } catch {
      if (editing === state && dialog.open) status.textContent = "Не удалось сохранить заметку. Повторите попытку.";
    } finally {
      if (editing === state) setSaving(false);
    }
  });

  return {
    open(orderId, product, updateButton) {
      editing = { orderId, product, updateButton };
      productName.textContent = product.name;
      text.value = product.note?.text ?? "";
      status.textContent = "";
      current.hidden = true;
      setSaving(false);
      dialog.showModal();
    },
    close() { if (dialog.open) dialog.close(); },
  };
}

export function bootstrapSupplierOrders(section) {
  const byId = (id) => document.getElementById(id);
  const rows = byId("supplier-orders-rows");
  const status = byId("supplier-orders-status");
  const search = byId("supplier-orders-search");
  const queryInput = byId("supplier-orders-query");
  const sortButtons = [...section.querySelectorAll("[data-supplier-sort]")];
  const refresh = byId("supplier-orders-refresh");
  const more = byId("supplier-orders-more");
  const pagination = byId("supplier-orders-pagination");
  const dialog = byId("supplier-order-dialog");
  const stockPopover = createIncomingPopover(dialog, "supplier-order-stock-popover");
  const noteEditor = createNoteEditor();
  const title = byId("supplier-order-title");
  const date = byId("supplier-order-date");
  const feedback = byId("supplier-order-status");
  const facts = byId("supplier-order-facts");
  const goodsTitle = byId("supplier-order-goods-title");
  const goodsTable = byId("supplier-order-goods");
  const footer = byId("supplier-order-footer");
  const total = byId("supplier-order-total");
  const retry = byId("supplier-order-retry");

  let active = false;
  let nextCursor = null;
  let listRead;
  let searchTimer;
  let query = "";
  let sortField = "date";
  let direction = "desc";
  let orderRead;
  let selected;
  const seen = new Set();

  function renderRow(order) {
    const row = element("tr");
    row.setAttribute("role", "row");
    const number = element("button", order.number, "repair-order-link supplier-orders-number");
    number.type = "button";
    number.setAttribute("aria-label", `Открыть заказ № ${order.number}`);
    number.addEventListener("click", () => void show(order));

    cell(row, formatDate(order.date), "supplier-orders-date");
    cell(row, number, "supplier-orders-link");
    cell(row, order.supplier || "—", "supplier-orders-supplier");
    cell(row, order.buyer || "—", order.buyer ? "supplier-orders-buyer" : "supplier-orders-blank", "Покупатель");
    cell(row, formatMoney(order.amount, order.currency), order.amount === null ? "supplier-orders-money supplier-orders-blank" : "supplier-orders-money", "Сумма");
    row.addEventListener("click", (event) => {
      if (event.target.closest("button") || !window.getSelection()?.isCollapsed) return;
      number.focus({ preventScroll: true });
      void show(order);
    });
    return row;
  }

  function clearRows() {
    rows.replaceChildren();
    seen.clear();
    nextCursor = null;
    pagination.hidden = true;
  }

  function cancelList() {
    listRead?.controller.abort();
    listRead = undefined;
    rows.removeAttribute("aria-busy");
    refresh.disabled = more.disabled = false;
  }

  function normalizedQuery() {
    return queryInput.value.normalize("NFC").trim().replace(/\s+/g, " ").toLocaleLowerCase("ru-RU");
  }

  async function loadList(append = false) {
    clearTimeout(searchTimer);
    const params = new URLSearchParams();
    if (sortField !== "date" || direction !== "desc") {
      params.set("sort", sortField);
      params.set("direction", direction);
    }
    if (query) params.set("q", query);
    const key = params.toString();
    if (!active || append && (!nextCursor || listRead) || listRead?.key === key && !listRead.append) return;
    cancelList();
    if (append) params.set("after", nextCursor);
    else clearRows();
    const controller = new AbortController();
    const request = { controller, key, append };
    listRead = request;
    refresh.disabled = more.disabled = true;
    rows.setAttribute("aria-busy", "true");
    status.textContent = append ? "Загружаются следующие заказы…" : query ? "Выполняется поиск…" : "Загружаются заказы…";
    try {
      const page = await read(params.size ? `${endpoint}?${params}` : endpoint, controller);
      if (controller.signal.aborted) return;
      const batch = document.createDocumentFragment();
      for (const order of page.orders) {
        if (seen.has(order.id)) continue;
        seen.add(order.id);
        batch.append(renderRow(order));
      }
      rows.append(batch);
      nextCursor = page.nextCursor;
      pagination.hidden = !nextCursor;
      status.textContent = seen.size ? "" : query ? "Заказы по запросу не найдены." : "Нет заказов поставщикам в работе.";
      if (append && !nextCursor) {
        const last = rows.lastElementChild?.querySelector(".supplier-orders-number");
        last?.focus({ preventScroll: true });
      }
    } catch (error) {
      if (!controller.signal.aborted) status.textContent = error.message;
    } finally {
      if (listRead === request) {
        listRead = undefined;
        rows.removeAttribute("aria-busy");
        refresh.disabled = more.disabled = false;
      }
    }
  }

  function renderProducts(products, order) {
    const pricedSupplier = !order.market;
    const titles = [["name", "Номенклатура"], ["article", "Артикул"], ["quantity", "Количество"]];
    if (pricedSupplier) titles.push(["price", "Цена"]);
    titles.push(["stock", "Остаток"]);
    if (pricedSupplier) titles.push(["returnDays", "Дней на возврат"], ["expectedDate", "Дата поступления"], ["amount", "Сумма"]);
    titles.push(["receipt", "Поступление"]);
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
        stock: stockQuantity(product, product.stock, stockPopover), returnDays: quantity.format(product.returnDays),
        price: formatMoney(product.price, order.currency), amount: formatMoney(product.amount, order.currency),
        expectedDate: formatDate(product.expectedDate),
      };
      if (product.noteKey) {
        const name = document.createDocumentFragment();
        const button = element("button", undefined, "supplier-note-button");
        const label = element("span");
        const preview = element("span", undefined, "supplier-note-preview");
        button.type = "button";
        button.append(label, preview);
        const updateButton = () => {
          const action = product.note ? "Заметка" : "Добавить заметку";
          label.textContent = action;
          button.setAttribute("aria-label", `${action}: ${product.name}`);
          preview.textContent = product.note?.text ?? "";
          preview.hidden = !product.note;
        };
        updateButton();
        button.addEventListener("click", () => {
          stockPopover.close();
          noteEditor.open(order.id, product, updateButton);
        });
        name.append(element("span", product.name), button);
        values.name = name;
      }
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
      footer.hidden = false;
    }
    renderProducts(order.products, order);
  }

  async function show(order) {
    if (!active) return;
    stockPopover.close();
    orderRead?.abort();
    const controller = new AbortController();
    orderRead = controller;
    selected = order;
    title.textContent = `Заказ поставщику № ${order.number}`;
    date.textContent = formatDate(order.date);
    facts.replaceChildren();
    facts.hidden = goodsTitle.hidden = goodsTable.hidden = retry.hidden = footer.hidden = true;
    byId("supplier-order-content").scrollTop = 0;
    feedback.textContent = "Загружаются товары…";
    if (!dialog.open) dialog.showModal();
    title.focus();
    try {
      const data = await read(`${endpoint}/${order.id}`, controller);
      if (controller.signal.aborted || !dialog.open) return;
      feedback.textContent = "";
      title.textContent = `Заказ поставщику № ${data.number}`;
      date.textContent = formatDate(data.date);
      renderOrder(data);
    } catch (error) {
      if (controller.signal.aborted || !dialog.open) return;
      feedback.textContent = error.message;
      retry.hidden = false;
    }
  }

  function clear() {
    active = false;
    clearTimeout(searchTimer);
    cancelList();
    clearRows();
    orderRead?.abort();
    status.textContent = "";
    noteEditor.close();
    if (dialog.open) dialog.close();
  }

  refresh.addEventListener("click", () => void loadList());
  more.addEventListener("click", () => void loadList(true));
  search.addEventListener("submit", (event) => {
    event.preventDefault();
    query = normalizedQuery();
    void loadList();
  });
  function scheduleSearch(event) {
    if (event.isComposing) return;
    const nextQuery = normalizedQuery();
    if (nextQuery === query) return;
    query = nextQuery;
    clearTimeout(searchTimer);
    cancelList();
    clearRows();
    status.textContent = "";
    searchTimer = setTimeout(() => void loadList(), 250);
  }
  queryInput.addEventListener("input", scheduleSearch);
  queryInput.addEventListener("compositionend", scheduleSearch);
  for (const button of sortButtons) {
    button.addEventListener("click", () => {
      const field = button.dataset.supplierSort;
      direction = field === sortField ? (direction === "asc" ? "desc" : "asc") : (field === "date" ? "desc" : "asc");
      sortField = field;
      for (const heading of sortButtons) {
        heading.classList.toggle("is-active", heading === button);
        heading.closest("th").setAttribute("aria-sort", heading !== button ? "none" : direction === "asc" ? "ascending" : "descending");
      }
      void loadList();
    });
  }
  retry.addEventListener("click", () => { if (selected) void show(selected); });
  byId("supplier-order-back").addEventListener("click", () => dialog.close());
  byId("supplier-order-close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    if (dialog.open) return;
    noteEditor.close();
    stockPopover.close();
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
