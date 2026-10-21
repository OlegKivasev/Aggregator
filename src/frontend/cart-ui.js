import { escapeHtml, formatArticle, formatBrand, formatPrice } from "./result-formatting.js";
import { formatDeliveryDate } from "./supplier-search-summary.js";
import { formatOrderDate } from "./order-date-formatting.js";
import { formatOrderStatus } from "./order-history-presentation.js";
import { armtekReturnSource, formatArmtekReturnDays, hasOfferDeliveryWarning, hasSupplierWeekendDelivery } from "./order-notices.js";

const supplierNames = { armtek: "Armtek", "part-kom": "PartKOM", "forum-auto": "Forum Auto", rossko: "Rossko" };
const maximumQuantity = (result) => Number.isFinite(result.quantity) ? Math.min(1_000_000, Math.floor(result.quantity)) : 0;
const cartIcon = '<img src="/shopping-cart.png" alt="" aria-hidden="true">';
const cartPriceFormat = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const partKomReceiptNode = (receipt, orderIds, acceptedQuantity) => {
  if (!receipt || typeof receipt !== "object" || typeof receipt.orderNumber !== "string"
    || receipt.orderNumber.length > 100 || !orderIds.includes(receipt.orderNumber)
    || !Number.isSafeInteger(receipt.quantity) || receipt.quantity < 1 || receipt.quantity > acceptedQuantity) return null;
  const card = document.createElement("section");
  card.className = "cart-partkom-receipt";
  const heading = document.createElement("h4");
  heading.textContent = `PartKOM · заказ № ${receipt.orderNumber}`;
  card.append(heading);
  const details = document.createElement("dl");
  const add = (label, value, status = false, highlightDate = false) => {
    if (value === null || value === undefined || value === "") return;
    if (typeof value !== "string" && typeof value !== "number") return;
    if (typeof value === "number" && !Number.isFinite(value) || typeof value === "string" && value.length > 500) return;
    const term = document.createElement("dt");
    term.textContent = label;
    const description = document.createElement("dd");
    description.textContent = status ? formatOrderStatus(String(value)) : String(value);
    if (status) description.className = "cart-partkom-receipt__state";
    if (highlightDate) {
      const date = document.createElement("span");
      date.className = "delivery-date--warning";
      date.textContent = String(value);
      description.replaceChildren(date);
    }
    details.append(term, description);
  };
  add("Дата заказа", formatOrderDate(receipt.orderDate));
  add("Деталь", [receipt.detailNum, receipt.maker, receipt.description].filter((value) => typeof value === "string" && value).join(" · "));
  add("Заказано", `${receipt.quantity} шт.`);
  const price = Number.isFinite(receipt.price) && receipt.price > 0 && Number.isFinite(receipt.price * receipt.quantity) ? receipt.price : null;
  add("Цена", price === null ? null : formatPrice(price));
  add("Сумма", price === null ? null : formatPrice(price * receipt.quantity));
  const highlightDelivery = hasSupplierWeekendDelivery("part-kom", receipt.expectedDate);
  add("Ожидаемый срок", formatOrderDate(receipt.expectedDate), false, highlightDelivery);
  add("Гарантированный срок", formatOrderDate(receipt.guaranteedDate));
  add("Склад", receipt.placement);
  for (const [label, value] of [["Отказано", receipt.refusalCount], ["В пути", receipt.storeCount], ["Отгружено", receipt.releaseCount]]) {
    if (Number.isSafeInteger(value) && value >= 0 && value <= receipt.quantity) add(label, value);
  }
  add("Состояние", receipt.stateTxt, true);
  add("Комментарий", receipt.comment);
  card.append(details);
  return card;
};

const forumAutoReceiptNode = (receipt, orderIds, acceptedQuantity) => {
  if (!receipt || typeof receipt !== "object" || typeof receipt.orderId !== "string"
    || receipt.orderId.length > 100 || !orderIds.includes(receipt.orderId)
    || !Number.isSafeInteger(receipt.orderedQuantity) || receipt.orderedQuantity !== acceptedQuantity) return null;
  const card = document.createElement("section");
  card.className = "cart-forum-receipt";
  const heading = document.createElement("h4");
  heading.textContent = `Forum Auto · заказ № ${receipt.orderId}`;
  card.append(heading);
  const details = document.createElement("dl");
  const add = (label, value, status = false, highlightDate = false) => {
    if (typeof value !== "string" && typeof value !== "number") return;
    if (typeof value === "string" && (!value || value.length > 500)
      || typeof value === "number" && !Number.isFinite(value)) return;
    const term = document.createElement("dt");
    term.textContent = label;
    const description = document.createElement("dd");
    description.textContent = status ? formatOrderStatus(String(value)) : String(value);
    if (highlightDate) {
      const date = document.createElement("span");
      date.className = "delivery-date--warning";
      date.textContent = String(value);
      description.replaceChildren(date);
    }
    if (status) description.className = "cart-forum-receipt__state";
    details.append(term, description);
  };
  add("Номер документа", receipt.documentNumber);
  add("Статус", receipt.status, true);
  add("Создан", formatOrderDate(receipt.createdAt));
  add("Доставка", formatOrderDate(receipt.deliveryAt), false, hasSupplierWeekendDelivery("forum-auto", receipt.deliveryAt));
  add("Товар", [receipt.article, receipt.brand, receipt.title].filter((value) => typeof value === "string" && value.length <= 500 && value).join(" · "));
  add("Заказано", `${receipt.orderedQuantity} шт.`);
  for (const [label, value] of [["Забронировано", receipt.reservedQuantity], ["Подтверждено", receipt.confirmedQuantity]]) {
    if (Number.isSafeInteger(value) && value >= 0 && value <= acceptedQuantity) add(label, value);
  }
  if (Number.isFinite(receipt.price) && receipt.price >= 0) add("Цена", formatPrice(receipt.price));
  if (Number.isFinite(receipt.total) && receipt.total >= 0) add("Сумма", formatPrice(receipt.total));
  card.append(details);
  return card;
};

const supplierOrderReceiptNode = (supplier, receipt, orderIds, acceptedQuantity, item) => {
  if (!receipt || typeof receipt !== "object" || typeof receipt.orderId !== "string"
    || !receipt.orderId || receipt.orderId.length > 100 || !orderIds.includes(receipt.orderId)
    || !Number.isSafeInteger(receipt.quantity) || receipt.quantity < 1 || receipt.quantity > acceptedQuantity) return null;
  const card = document.createElement("section");
  card.className = supplier === "rossko" ? "cart-rossko-receipt" : "cart-armtek-receipt";
  const heading = document.createElement("h4");
  heading.textContent = `${supplierNames[supplier]} · заказ № ${receipt.orderId}`;
  card.append(heading);
  const details = document.createElement("dl");
  const add = (label, value, status = false) => {
    if (typeof value !== "string" && typeof value !== "number") return;
    if (typeof value === "string" && (!value || value.length > 500)
      || typeof value === "number" && !Number.isFinite(value)) return;
    const term = document.createElement("dt");
    term.textContent = label;
    const description = document.createElement("dd");
    description.textContent = status ? formatOrderStatus(String(value)) : String(value);
    if (status) description.className = "cart-supplier-receipt__state";
    details.append(term, description);
  };
  add("Создан", formatOrderDate(receipt.createdAt));
  add(supplier === "armtek" ? "Статус заказа" : "Статус позиции", receipt.status, true);
  if (supplier === "armtek") add("Статус позиции", receipt.itemStatus, true);
  add("Товар", [item.result.article, item.result.brand, item.result.title].filter((value) => typeof value === "string" && value.length <= 500).join(" · "));
  add("Заказано", `${receipt.quantity} шт.`);
  if (Number.isFinite(receipt.price) && receipt.price > 0) add("Цена", formatPrice(receipt.price));
  if (Number.isFinite(receipt.total) && receipt.total > 0) add(supplier === "armtek" ? "Сумма заказа" : "Сумма позиции", formatPrice(receipt.total));
  if (supplier === "rossko" && Number.isFinite(receipt.orderTotal) && receipt.orderTotal > 0) add("Сумма заказа", formatPrice(receipt.orderTotal));
  add("Срок доставки", formatOrderDate(receipt.deliveryAt ?? receipt.deliveryEnd ?? receipt.deliveryStart));
  add("Склад", receipt.warehouse);
  add("Доставка", receipt.deliveryType);
  add("Адрес доставки", receipt.deliveryAddress);
  add("Оплата", receipt.paymentType);
  if (supplier === "armtek") {
    add("Возврат", formatArmtekReturnDays(receipt.returnDays));
    details.lastElementChild.title = armtekReturnSource;
    if (Number.isInteger(receipt.returnDays) && receipt.returnDays >= 0 && receipt.returnDays <= 9999) {
      add("Источник срока", armtekReturnSource);
    }
  }
  card.append(details);
  return card;
};

export const formatCartLatestDeliveryDate = (items) => {
  if (!items.length) return "Не указана";
  let latest = null;
  let approximate = false;
  for (const { result } of items) {
    const from = typeof result.deliveryDate === "string" ? Date.parse(result.deliveryDate) : Number.NaN;
    const end = result.deliveryDateTo ?? result.deliveryDate;
    const to = typeof end === "string" ? Date.parse(end) : Number.NaN;
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return "Не указана";
    if (latest === null || to > Date.parse(latest)) latest = end;
    approximate ||= result.deliveryDateApproximate === true;
  }
  return formatDeliveryDate(latest, approximate);
};

export const renderCartOfferControls = (result) => {
  const maximum = maximumQuantity(result);
  const supported = Object.hasOwn(supplierNames, result.supplier);
  const enabled = supported && maximum > 0 && typeof result.offerId === "string" && /^[0-9a-f-]{36}$/.test(result.offerId);
  const title = !supported ? "Корзина доступна для PartKOM, Armtek, Forum Auto и Rossko" : maximum < 1
    ? "Нет подтверждённого остатка" : !result.offerId ? "Повторите поиск для добавления в корзину" : "Добавить в корзину";
  return `<td class="cart-add-cell"><div class="cart-offer-controls">
    <button type="button" class="mobile-offer-menu" aria-label="Действия с предложением" aria-haspopup="menu" aria-controls="result-context-menu">⋯</button>
    <input class="cart-quantity" type="number" min="1" max="${Math.max(1, maximum)}" step="1" value="1" inputmode="numeric"
      aria-label="Количество для ${escapeHtml(result.article)}" ${enabled ? "" : "disabled"}>
    <div class="cart-offer-actions">
      <button type="button" class="cart-offer-button" data-cart-offer-id="${escapeHtml(result.offerId ?? "")}" ${enabled ? "" : "disabled"}
        aria-label="Добавить в корзину" title="${title}">${cartIcon}</button>
      <button type="button" class="garage-offer-button" draggable="${Boolean(result.offerId)}"
        data-garage-offer-id="${escapeHtml(result.offerId ?? "")}" data-garage-offer-quantity="${Number.isFinite(result.quantity) && result.quantity >= 0 ? result.quantity : ""}"
        aria-disabled="${!result.offerId}" aria-label="Добавить в гараж" title="Добавить в гараж"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="m5.1 9.75 1.25-3.2A2.25 2.25 0 0 1 8.45 5h7.1a2.25 2.25 0 0 1 2.1 1.55l1.25 3.2"/><path d="M4.5 10.25h15a1.5 1.5 0 0 1 1.5 1.5v4.75h-2.25V19H16.5v-2.5h-9V19H5.25v-2.5H3v-4.75a1.5 1.5 0 0 1 1.5-1.5Z"/><circle cx="7.25" cy="13.5" r="1"/><circle cx="16.75" cy="13.5" r="1"/></svg></button>
    </div></div></td>`;
};

const api = async (path, options = {}) => {
  const response = await fetch(path, { headers: { "Content-Type": "application/json" }, ...options });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof payload?.message === "string" ? payload.message : "Не удалось выполнить действие в корзине.");
  if (!payload || typeof payload !== "object") throw new Error("Не удалось получить корзину.");
  return payload;
};

const validateCart = (value) => {
  if (!Array.isArray(value.items) || value.items.length > 500 || !Number.isSafeInteger(value.revision) || value.revision < 0
    || !Number.isSafeInteger(value.count) || value.count < 0 || !Number.isFinite(value.total) || value.total < 0
    || typeof value.testing !== "boolean" || value.items.some((item) => !item || typeof item.id !== "string"
      || !/^[0-9a-f-]{36}$/.test(item.id) || !Number.isSafeInteger(item.quantity) || item.quantity < 1
      || !item.result || !Object.hasOwn(supplierNames, item.result.supplier)
      || [item.result.article, item.result.brand, item.result.title].some((text) => typeof text !== "string")
      || item.result.warehouse !== null && typeof item.result.warehouse !== "string"
      || !Number.isFinite(item.result.price) || item.result.price <= 0 || item.quantity > maximumQuantity(item.result))) {
    throw new Error("Некорректные данные корзины.");
  }
  if (value.count !== value.items.reduce((sum, item) => sum + item.quantity, 0)
    || Math.abs(value.total - value.items.reduce((sum, item) => sum + item.quantity * item.result.price, 0)) > .005) {
    throw new Error("Некорректные данные корзины.");
  }
  if (!Array.isArray(value.pendingIds) || value.pendingIds.some((id) => typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id))) {
    throw new Error("Некорректный статус заказов в корзине.");
  }
  return value;
};

export const bootstrapCart = ({ getMarkupPrice, showPurchasePrice }) => {
  const renderPrices = (result, quantity = 1) => `<span class="cart-price main-result-price" title="Цена с наценкой">${escapeHtml(cartPriceFormat.format(getMarkupPrice(result) * quantity))}</span>
    ${showPurchasePrice() ? `<span class="cart-purchase-price main-result-purchase-price" title="Закупочная цена">${escapeHtml(cartPriceFormat.format(result.price * quantity))}</span>` : ""}`;
  const renderTotals = (items) => {
    const price = items.reduce((sum, item) => sum + getMarkupPrice(item.result) * item.quantity, 0);
    const purchasePrice = items.reduce((sum, item) => sum + item.result.price * item.quantity, 0);
    return `<strong class="cart-total-price" title="Сумма с наценкой">${escapeHtml(formatPrice(price))}</strong>
      ${showPurchasePrice() ? `<span class="cart-purchase-price main-result-purchase-price" title="Закупочная сумма">${escapeHtml(formatPrice(purchasePrice))}</span>` : ""}`;
  };
  const toggle = document.querySelector("#cart-toggle");
  const badge = document.querySelector("#cart-badge");
  const modal = document.createElement("dialog");
  modal.id = "cart-modal";
  modal.className = "cart-modal";
  modal.setAttribute("aria-labelledby", "cart-title");
  modal.innerHTML = `<header class="analogs-modal__header"><h2 id="cart-title">Корзина</h2>
    <div class="cart-header-actions"><button type="button" class="btn btn-light cart-clear-button" id="cart-clear" aria-label="Очистить вкладку «Все»" title="Очистить вкладку «Все»"><img src="/recycle-bin.png" alt="" aria-hidden="true"></button>
      <button type="button" class="btn btn-light analogs-modal__close" id="cart-close" aria-label="Закрыть корзину">×</button></div></header>
    <div class="cart-tabs" id="cart-tabs" role="tablist" aria-label="Поставщики в корзине"></div>
    <div class="cart-content" id="cart-tab-panel" role="tabpanel" aria-labelledby="cart-tab-all">
      <div class="cart-table-scroll"><table class="table align-middle cart-table"><thead><tr>
        <th class="cart-select-column"><label class="cart-selection"><input id="cart-select-all" type="checkbox" aria-label="Выбрать все товары вкладки" title="Выбрать все товары вкладки"><span class="cart-mobile-label">Выбрать все</span></label></th><th>Запчасть</th><th>Наименование</th><th id="cart-supplier-column">Поставщик</th><th>Доставка</th><th class="cart-price-column">Цена, ₽</th><th class="cart-quantity-column">Кол-во</th><th class="cart-price-column">Стоимость, ₽</th><th><span class="visually-hidden">Удалить</span></th>
      </tr></thead><tbody id="cart-items"></tbody></table></div>
      <p id="cart-summary"></p>
      <p class="cart-status" id="cart-status" role="status" aria-live="polite"></p></div>
    <footer class="cart-footer"><div class="cart-footer__summary"><span>К заказу</span><span>Дата поставки выбранных товаров</span>
      <div id="cart-total"></div><strong id="cart-delivery-date"></strong></div>
      <button type="button" class="btn btn-primary" id="cart-test-order">Оформить заказы</button></footer>
    <div class="cart-refresh-overlay" id="cart-refresh-overlay" role="status" aria-live="polite" tabindex="-1" hidden>
      <div class="cart-refresh-overlay__message"><span class="cart-refresh-overlay__spinner" aria-hidden="true"></span>
        <strong>Обновляем корзину</strong><span>Проверяем цены, остатки и сроки у поставщиков…</span></div></div>`;
  document.body.append(modal);
  const clearDialog = document.createElement("dialog");
  clearDialog.id = "cart-clear-confirm";
  clearDialog.className = "cart-modal cart-clear-confirm";
  clearDialog.setAttribute("aria-labelledby", "cart-clear-title");
  clearDialog.innerHTML = `<h3 id="cart-clear-title"></h3><div class="cart-confirm-actions">
    <button type="button" class="btn btn-light" id="cart-clear-cancel" autofocus>Отмена</button>
    <button type="button" class="btn btn-primary" id="cart-clear-accept">Очистить</button></div>`;
  document.body.append(clearDialog);
  const resolveDialog = document.createElement("dialog");
  resolveDialog.id = "cart-resolve-confirm";
  resolveDialog.className = "cart-modal cart-resolve-confirm";
  resolveDialog.setAttribute("aria-labelledby", "cart-resolve-title");
  resolveDialog.innerHTML = `<h3 id="cart-resolve-title">Сверка заказа с поставщиком</h3>
    <p id="cart-resolve-description"></p>
    <fieldset class="cart-resolve-options"><legend>Результат проверки в кабинете поставщика</legend>
      <label><input type="radio" name="cart-resolution" value="placed">Заказ оформлен — убрать позицию из корзины</label>
      <label><input type="radio" name="cart-resolution" value="missing">Заказа нет — разблокировать позицию</label></fieldset>
    <p id="cart-resolve-consequence"></p>
    <label class="cart-resolve-acknowledgement"><input id="cart-resolve-checked" type="checkbox">
      <span id="cart-resolve-acknowledgement"></span></label>
    <p id="cart-resolve-status" role="status" aria-live="polite"></p>
    <div class="cart-confirm-actions"><button type="button" class="btn btn-light" id="cart-resolve-cancel" autofocus>Отмена</button>
      <button type="button" class="btn btn-primary" id="cart-resolve-accept" disabled>Подтвердить сверку</button></div>`;
  document.body.append(resolveDialog);
  const orderDialog = document.createElement("dialog");
  orderDialog.id = "cart-order-confirm";
  orderDialog.className = "cart-modal cart-order-confirm";
  orderDialog.setAttribute("aria-labelledby", "cart-order-title");
  orderDialog.setAttribute("aria-describedby", "cart-order-intro");
  orderDialog.innerHTML = `<header class="analogs-modal__header"><h2 id="cart-order-title">Подтверждение заказа</h2></header>
    <div class="cart-content"><p class="cart-order-intro" id="cart-order-intro">Внимательно проверьте товары, количество, склады, сроки доставки и суммы перед заказом.</p>
      <div id="cart-order-groups"></div>
      <div id="cart-order-receipt" class="cart-order-receipt" hidden></div>
      <p class="cart-order-status" id="cart-order-status" role="status" aria-live="polite"></p></div>
    <footer class="cart-footer"><div><span>Итого</span><div id="cart-order-total"></div></div>
      <div class="cart-confirm-actions"><button type="button" class="btn btn-light" id="cart-order-cancel" autofocus>Вернуться в корзину</button>
        <button type="button" class="btn cart-order-submit" id="cart-order-accept">Заказать</button></div></footer>`;
  document.body.append(orderDialog);
  const toast = document.createElement("div");
  toast.className = "cart-toast";
  toast.hidden = true;
  toast.setAttribute("role", "status");
  toast.setAttribute("aria-live", "polite");
  document.body.append(toast);
  const body = modal.querySelector("#cart-items");
  const tabs = modal.querySelector("#cart-tabs");
  const status = modal.querySelector("#cart-status");
  const refreshOverlay = modal.querySelector("#cart-refresh-overlay");
  const testButton = modal.querySelector("#cart-test-order");
  const clearButton = modal.querySelector("#cart-clear");
  const clearCancel = clearDialog.querySelector("#cart-clear-cancel");
  const clearAccept = clearDialog.querySelector("#cart-clear-accept");
  const resolveChecked = resolveDialog.querySelector("#cart-resolve-checked");
  const resolveAccept = resolveDialog.querySelector("#cart-resolve-accept");
  const orderCancel = orderDialog.querySelector("#cart-order-cancel");
  const orderAccept = orderDialog.querySelector("#cart-order-accept");
  const orderStatus = orderDialog.querySelector("#cart-order-status");
  const orderReceipt = orderDialog.querySelector("#cart-order-receipt");
  let orderTarget = null;
  let clearTarget = null;
  let resolveTarget = null;
  let cart = null;
  let busy = false;
  let checking = false;
  let toastTimeout;
  let returnFocus = toggle;
  let activeSupplier = "all";
  let refreshedRevision = null;
  let refreshedScope = null;
  let refreshedUntil = 0;
  const selectedIds = new Set();

  const setCartRefreshing = (refreshing) => {
    refreshOverlay.hidden = !refreshing;
    modal.classList.toggle("is-refreshing", refreshing);
    for (const section of modal.children) if (section !== refreshOverlay) section.inert = refreshing;
    if (refreshing && modal.open) refreshOverlay.focus();
    else if (!refreshing && modal.open && document.activeElement === refreshOverlay) modal.querySelector("#cart-close").focus();
  };

  const notify = (message, error = false) => {
    clearTimeout(toastTimeout);
    toast.textContent = message;
    toast.classList.toggle("is-error", error);
    toast.hidden = false;
    toastTimeout = setTimeout(() => { toast.hidden = true; }, 4000);
  };
  const render = () => {
    if (!cart) return;
    const focusedControl = document.activeElement.closest?.("#cart-items input, #cart-items button");
    const focusedTab = document.activeElement.closest?.(".cart-tab")?.dataset.cartSupplier;
    const focusedId = focusedControl?.closest("tr")?.dataset.cartItemId;
    const focusedSelector = focusedControl?.matches(".cart-item-select") ? ".cart-item-select"
      : focusedControl?.matches("input") ? ".cart-quantity" : ".cart-remove";
    const locked = busy || checking || cart.testing;
    const suppliers = Object.keys(supplierNames).filter((supplier) => cart.items.some((item) => item.result.supplier === supplier));
    if (activeSupplier !== "all" && !suppliers.includes(activeSupplier)) activeSupplier = "all";
    const items = activeSupplier === "all" ? cart.items : cart.items.filter((item) => item.result.supplier === activeSupplier);
    const count = items.reduce((sum, item) => sum + item.quantity, 0);
    const currentIds = new Set(cart.items.map((item) => item.id));
    for (const id of selectedIds) if (!currentIds.has(id)) selectedIds.delete(id);
    const pending = new Set(cart.pendingIds ?? []);
    const selected = items.filter((item) => selectedIds.has(item.id) && !pending.has(item.id));
    const selectable = items.filter((item) => !pending.has(item.id));
    tabs.innerHTML = ["all", ...suppliers].map((supplier) => {
      const name = supplier === "all" ? "Все" : supplierNames[supplier];
      const tabCount = supplier === "all" ? cart.count : cart.items.filter((item) => item.result.supplier === supplier).reduce((sum, item) => sum + item.quantity, 0);
      return `<button type="button" class="cart-tab" id="cart-tab-${supplier}" role="tab" data-cart-supplier="${supplier}"
        aria-selected="${activeSupplier === supplier}" aria-controls="cart-tab-panel" tabindex="${activeSupplier === supplier ? "0" : "-1"}"
        aria-label="${name}: ${tabCount} шт.">${name}<span class="cart-tab__count" aria-hidden="true">${tabCount}</span></button>`;
    }).join("");
    modal.querySelector("#cart-tab-panel").setAttribute("aria-labelledby", `cart-tab-${activeSupplier}`);
    modal.querySelector("#cart-supplier-column").hidden = activeSupplier !== "all";
    modal.querySelector(".cart-table").classList.toggle("is-supplier-view", activeSupplier !== "all");
    badge.textContent = String(cart.count);
    badge.hidden = cart.count === 0;
    toggle.hidden = cart.count === 0 && !toggle.closest("#garage-tools");
    toggle.setAttribute("aria-label", `Открыть корзину: ${cart.count} шт.`);
    modal.querySelector("#cart-summary").textContent = `Количество: ${count} шт. Выбрано к заказу: ${selected.reduce((sum, item) => sum + item.quantity, 0)} шт.`;
    modal.querySelector("#cart-total").innerHTML = renderTotals(selected);
    modal.querySelector("#cart-delivery-date").textContent = formatCartLatestDeliveryDate(selected);
    const selectAll = modal.querySelector("#cart-select-all");
    selectAll.disabled = locked || !selectable.length;
    selectAll.checked = selectable.length > 0 && selected.length === selectable.length;
    selectAll.indeterminate = selected.length > 0 && selected.length < selectable.length;
    body.innerHTML = items.length ? items.map((item) => {
      const result = item.result;
      const unresolved = pending.has(item.id);
      return `<tr data-cart-item-id="${escapeHtml(item.id)}" class="${selectedIds.has(item.id) ? "is-selected" : ""}"><td class="cart-select-cell"><label class="cart-selection"><input class="cart-item-select" type="checkbox" aria-label="Выбрать для заказа ${escapeHtml(result.article)}" ${selectedIds.has(item.id) ? "checked" : ""} ${locked || unresolved ? "disabled" : ""}><span class="cart-mobile-label">К заказу</span></label></td><td class="cart-item-part"><span>${escapeHtml(formatBrand(result.brand))}</span><span class="cart-item-article">${escapeHtml(formatArticle(result.article))}</span></td>
        <td class="cart-item-name">${escapeHtml(result.title)}${unresolved ? '<span class="cart-item-check">Статус заказа требует сверки с поставщиком.</span>' : ""}${unresolved ? `<button type="button" class="cart-resolve-button" ${locked ? "disabled" : ""}>Сверить заказ</button>` : ""}</td>
        ${activeSupplier === "all" ? `<td class="cart-item-supplier" data-label="Поставщик / склад">${escapeHtml(supplierNames[result.supplier] ?? result.supplier)}<span class="cart-item-warehouse">${escapeHtml(result.warehouse ?? "Склад не указан")}</span></td>` : ""}
        <td class="cart-item-delivery" data-label="Доставка"><span class="${hasOfferDeliveryWarning(result.supplier, result.deliveryDate, result.deliveryDateTo) ? "delivery-date--warning" : ""}">${escapeHtml(formatDeliveryDate(result.deliveryDate, result.deliveryDateApproximate, result.deliveryDateTo))}</span>${activeSupplier !== "all" ? `<span class="cart-item-warehouse">${escapeHtml(result.warehouse ?? "Склад не указан")}</span>` : ""}</td>
        <td class="cart-item-price" data-label="Цена, ₽">${renderPrices(result)}</td>
        <td class="cart-item-quantity" data-label="Количество"><input class="cart-quantity" type="number" min="1" max="${maximumQuantity(result)}" step="1" value="${item.quantity}" inputmode="numeric"
          aria-label="Количество для ${escapeHtml(result.article)}" ${locked || unresolved ? "disabled" : ""}><span class="cart-item-stock">из ${maximumQuantity(result)}</span></td>
        <td class="cart-item-sum" data-label="Стоимость, ₽">${renderPrices(result, item.quantity)}</td>
        <td class="cart-item-remove"><button type="button" class="cart-remove btn btn-light" aria-label="Удалить ${escapeHtml(result.article)}" title="Удалить" ${locked || unresolved ? "disabled" : ""}>×</button></td></tr>`;
    }).join("") : `<tr><td colspan="${activeSupplier === "all" ? 9 : 8}" class="cart-empty">Корзина пуста. Добавьте товары из таблицы предложений.</td></tr>`;
    testButton.disabled = locked || !selected.length;
    testButton.textContent = checking ? "Оформляем…" : activeSupplier === "all" ? "Оформить заказы" : "Оформить заказ";
    clearButton.disabled = locked || !items.length || items.some((item) => pending.has(item.id));
    const clearLabel = `Очистить вкладку «${activeSupplier === "all" ? "Все" : supplierNames[activeSupplier]}»`;
    clearButton.title = clearLabel;
    clearButton.setAttribute("aria-label", clearLabel);
    if (modal.open && focusedId) {
      const replacement = body.querySelector(`[data-cart-item-id="${CSS.escape(focusedId)}"] ${focusedSelector}`);
      if (replacement && !replacement.disabled) replacement.focus();
      else modal.querySelector("#cart-close").focus();
    }
    if (modal.open && focusedTab) (tabs.querySelector(`#cart-tab-${CSS.escape(focusedTab)}`) ?? tabs.querySelector('[aria-selected="true"]')).focus();
  };
  const refresh = async () => {
    cart = validateCart(await api("/api/cart"));
    render();
  };
  const flyToCart = (source) => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches || !source.isConnected || !source.getClientRects().length) return;
    const from = source.getBoundingClientRect();
    const to = toggle.getBoundingClientRect();
    const flying = document.createElement("span");
    flying.className = "cart-flying-icon";
    flying.innerHTML = cartIcon;
    flying.style.left = `${from.left + from.width / 2 - 18}px`;
    flying.style.top = `${from.top + from.height / 2 - 18}px`;
    document.body.append(flying);
    const dx = to.left + to.width / 2 - from.left - from.width / 2;
    const dy = to.top + to.height / 2 - from.top - from.height / 2;
    const animation = flying.animate([
      { transform: "translate(0, 0) scale(1)", opacity: 1 },
      { transform: `translate(${dx * 0.5}px, ${dy * 0.5 - 65}px) scale(.9)`, opacity: .95, offset: .5 },
      { transform: `translate(${dx}px, ${dy}px) scale(.35)`, opacity: .2 },
    ], { duration: 520, easing: "ease-in-out" });
    animation.finished.catch(() => {}).finally(() => flying.remove()); // Cancellation is normal when the page closes.
  };
  const mutate = async (path, method, fields, source) => {
    if (busy || checking || cart?.testing) { notify("Дождитесь завершения действия в корзине."); return false; }
    busy = true;
    if (source) source.disabled = true;
    try {
      if (!cart) await refresh();
      cart = validateCart(await api(path, { method, body: JSON.stringify({ revision: cart.revision, ...fields }) }));
      status.textContent = "";
      if (source?.matches(".cart-offer-button")) { flyToCart(source); notify("Товар добавлен в корзину."); }
      return true;
    } catch (error) {
      notify(error.message, true);
      status.textContent = error.message;
      try { await refresh(); } catch { /* The original actionable error remains visible. */ }
      return false;
    } finally { busy = false; if (source) source.disabled = false; render(); }
  };

  toggle.addEventListener("click", async () => {
    returnFocus = document.activeElement;
    activeSupplier = "all";
    selectedIds.clear();
    if (!modal.open) modal.showModal();
    if (busy || checking) return;
    busy = true;
    setCartRefreshing(true);
    render();
    status.textContent = "";
    try {
      await refresh();
      if (cart.items.length) {
        cart = validateCart(await api("/api/cart/refresh", { method: "POST", body: JSON.stringify({ revision: cart.revision, supplier: "all" }) }));
        refreshedRevision = cart.revision;
        refreshedScope = "all";
        refreshedUntil = Date.now() + 110_000;
      }
      status.textContent = "";
    } catch (error) { refreshedRevision = null; status.textContent = error.message; }
    finally { busy = false; setCartRefreshing(false); render(); }
  });
  modal.querySelector("#cart-close").addEventListener("click", () => modal.close());
  clearButton.addEventListener("click", () => {
    if (busy || checking || cart?.testing || !cart?.items.length) return;
    clearTarget = { supplier: activeSupplier, revision: cart.revision };
    clearDialog.querySelector("#cart-clear-title").textContent = `Очистить вкладку «${activeSupplier === "all" ? "Все" : supplierNames[activeSupplier]}»?`;
    clearDialog.showModal();
  });
  clearCancel.addEventListener("click", () => clearDialog.close());
  clearAccept.addEventListener("click", () => {
    const target = clearTarget;
    clearDialog.close();
    if (target) void mutate("/api/cart/items", "DELETE", target, clearButton);
  });
  clearDialog.addEventListener("close", () => {
    clearTarget = null;
    if (modal.open) (clearButton.disabled ? modal.querySelector("#cart-close") : clearButton).focus();
  });
  clearDialog.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    if (event.shiftKey && document.activeElement === clearCancel) { event.preventDefault(); clearAccept.focus(); }
    else if (!event.shiftKey && document.activeElement === clearAccept) { event.preventDefault(); clearCancel.focus(); }
  });
  tabs.addEventListener("click", (event) => {
    const tab = event.target.closest(".cart-tab");
    if (!tab) return;
    activeSupplier = tab.dataset.cartSupplier;
    status.textContent = "";
    render();
  });
  tabs.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const buttons = [...tabs.querySelectorAll(".cart-tab")];
    const current = buttons.findIndex((button) => button === event.target.closest(".cart-tab"));
    if (current < 0) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
      : (current + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
    activeSupplier = buttons[next].dataset.cartSupplier;
    status.textContent = "";
    render();
    tabs.querySelector('[aria-selected="true"]').focus();
  });
  modal.addEventListener("click", (event) => { if (event.target === modal && !modal.classList.contains("is-refreshing")) {
    const rect = modal.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) modal.close();
  } });
  modal.addEventListener("cancel", (event) => { if (modal.classList.contains("is-refreshing")) event.preventDefault(); });
  modal.addEventListener("close", () => {
    const target = returnFocus?.hidden ? document.querySelector("#submit-button") : returnFocus;
    target?.focus();
  });
  modal.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    if (modal.classList.contains("is-refreshing")) { event.preventDefault(); refreshOverlay.focus(); return; }
    const controls = [...modal.querySelectorAll('button:not(:disabled):not([tabindex="-1"]), input:not(:disabled), [tabindex="0"]')]
      .filter((node) => node.getClientRects().length > 0);
    const first = controls[0];
    const last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  document.addEventListener("input", (event) => {
    const input = event.target.closest?.(".cart-quantity");
    if (!input || input.value === "") return;
    const value = Number(input.value);
    if (Number.isFinite(value)) input.value = String(Math.max(1, Math.min(Number(input.max), Math.floor(value))));
  });
  document.addEventListener("click", (event) => {
    const button = event.target.closest?.(".cart-offer-button");
    if (button && !button.disabled) {
      event.stopPropagation();
      const input = button.closest(".cart-offer-controls").querySelector(".cart-quantity");
      if (!input.reportValidity()) return;
      void mutate("/api/cart/items", "POST", { offerId: button.dataset.cartOfferId, quantity: Number(input.value) }, button);
    }
    const remove = event.target.closest?.(".cart-remove");
    if (remove) void mutate(`/api/cart/items/${encodeURIComponent(remove.closest("tr").dataset.cartItemId)}`, "DELETE", {}, remove);
    const resolve = event.target.closest?.(".cart-resolve-button");
    if (resolve && !resolve.disabled) {
      const item = cart.items.find((candidate) => candidate.id === resolve.closest("tr").dataset.cartItemId);
      if (busy || checking || cart.testing || !item || !cart.pendingIds.includes(item.id)) return;
      resolveTarget = { id: item.id, revision: cart.revision };
      const supplier = supplierNames[item.result.supplier];
      resolveDialog.querySelector("#cart-resolve-title").textContent = `Сверка заказа ${supplier}`;
      resolveDialog.querySelector("#cart-resolve-description").textContent = `${item.result.brand} ${item.result.article} · ${item.quantity} шт. · ${item.result.warehouse ?? "Склад не указан"}. Проверьте товар и всё количество в кабинете ${supplier}.`;
      resolveDialog.querySelector("#cart-resolve-acknowledgement").textContent = `Я проверил кабинет ${supplier} и подтверждаю выбранный результат для всех ${item.quantity} шт.`;
      resolveDialog.querySelector("#cart-resolve-consequence").textContent = "Сверка сама по себе не отправляет и не отменяет заказ у поставщика.";
      resolveDialog.querySelector("#cart-resolve-status").textContent = "";
      for (const choice of resolveDialog.querySelectorAll('[name="cart-resolution"]')) choice.checked = false;
      resolveChecked.checked = false;
      resolveAccept.disabled = true;
      resolveAccept.textContent = "Подтвердить сверку";
      resolveDialog.showModal();
    }
  });
  resolveDialog.addEventListener("change", (event) => {
    const resolution = resolveDialog.querySelector('[name="cart-resolution"]:checked')?.value;
    if (event.target.name === "cart-resolution") resolveChecked.checked = false;
    resolveDialog.querySelector("#cart-resolve-consequence").textContent = resolution === "placed"
      ? "Позиция будет убрана из корзины. Заказ у поставщика останется без изменений."
      : resolution === "missing" ? "Позицию можно будет изменить или удалить. Повторное оформление отправит новый заказ."
        : "Сверка сама по себе не отправляет и не отменяет заказ у поставщика.";
    resolveAccept.textContent = resolution === "placed" ? "Убрать из корзины" : resolution === "missing" ? "Разблокировать" : "Подтвердить сверку";
    resolveAccept.disabled = busy || !resolveChecked.checked || !resolution;
  });
  resolveDialog.querySelector("#cart-resolve-cancel").addEventListener("click", () => { if (!busy) resolveDialog.close(); });
  resolveDialog.addEventListener("cancel", (event) => { if (busy) event.preventDefault(); });
  resolveAccept.addEventListener("click", async () => {
    const resolution = resolveDialog.querySelector('[name="cart-resolution"]:checked')?.value;
    if (busy || checking || !resolveTarget || !resolveChecked.checked || !resolution) return;
    busy = true;
    resolveAccept.disabled = true;
    for (const control of resolveDialog.querySelectorAll("input, button")) control.disabled = true;
    try {
      cart = validateCart(await api("/api/cart/uncertain/resolve", { method: "POST", body: JSON.stringify({
        ...resolveTarget, ...(resolution === "placed" ? { confirmedPlaced: true } : { confirmedAbsent: true }),
      }) }));
      selectedIds.delete(resolveTarget.id);
      refreshedRevision = null;
      status.textContent = resolution === "placed"
        ? "Позиция убрана из корзины после сверки. Заказ у поставщика не изменён."
        : "Блокировка снята после сверки. Позицию можно изменить, удалить или заказать заново.";
      resolveDialog.close();
    } catch (error) {
      resolveDialog.querySelector("#cart-resolve-status").textContent = error.message;
      try { await refresh(); } catch { /* Keep the original action error visible. */ }
    } finally {
      busy = false;
      for (const control of resolveDialog.querySelectorAll("input, button")) control.disabled = false;
      resolveAccept.disabled = !resolveChecked.checked || !resolveDialog.querySelector('[name="cart-resolution"]:checked');
      render();
    }
  });
  body.addEventListener("change", (event) => {
    const choice = event.target.closest(".cart-item-select");
    if (choice) {
      const id = choice.closest("tr").dataset.cartItemId;
      if (choice.checked) selectedIds.add(id); else selectedIds.delete(id);
      render();
      return;
    }
    const input = event.target.closest(".cart-quantity");
    if (!input || !input.reportValidity()) return;
    void mutate(`/api/cart/items/${encodeURIComponent(input.closest("tr").dataset.cartItemId)}`, "PATCH", { quantity: Number(input.value) });
  });
  modal.querySelector("#cart-select-all").addEventListener("change", (event) => {
    const items = activeSupplier === "all" ? cart.items : cart.items.filter((item) => item.result.supplier === activeSupplier);
    const pending = new Set(cart.pendingIds ?? []);
    for (const item of items) if (!pending.has(item.id)) {
      if (event.target.checked) selectedIds.add(item.id); else selectedIds.delete(item.id);
    }
    render();
  });

  const validateOrderChoices = (items, choices) => {
    const suppliers = new Set(items.map((item) => item.result.supplier));
    if (suppliers.has("part-kom")) {
      const deliveries = choices?.partKom?.deliveries;
      if (!Array.isArray(deliveries) || deliveries.length !== 1 || deliveries[0]?.id !== "regular" || deliveries[0]?.type !== "regular") {
        throw new Error("PartKOM не подтвердил обычную доставку.");
      }
    }
  };
  testButton.addEventListener("click", async () => {
    if (busy || checking || cart?.testing || !cart?.items.length || !selectedIds.size) return;
    const supplier = activeSupplier;
    busy = true;
    render();
    try {
      await refresh();
      if (!modal.open) return;
      if (cart.testing) throw new Error("Дождитесь завершения действия в корзине.");
      if (refreshedRevision !== cart.revision || refreshedUntil <= Date.now()
        || refreshedScope !== "all" && refreshedScope !== supplier) {
        setCartRefreshing(true);
        try {
          cart = validateCart(await api("/api/cart/refresh", { method: "POST", body: JSON.stringify({ revision: cart.revision, supplier }) }));
        } finally { setCartRefreshing(false); }
        refreshedRevision = cart.revision;
        refreshedScope = supplier;
        refreshedUntil = Date.now() + 110_000;
      }
      status.textContent = "";
      render();
      const items = (supplier === "all" ? cart.items : cart.items.filter((item) => item.result.supplier === supplier))
        .filter((item) => selectedIds.has(item.id) && !cart.pendingIds.includes(item.id));
      if (!items.length) throw new Error("Выберите товары для заказа.");
      const itemIds = items.map((item) => item.id);
      const choices = await api("/api/cart/order-options", { method: "POST", body: JSON.stringify({ revision: cart.revision, supplier, itemIds }) });
      if (!modal.open) return;
      orderTarget = { supplier, revision: cart.revision, items: structuredClone(items), itemIds, choices };
      orderDialog.classList.remove("is-success");
      orderDialog.querySelector("#cart-order-title").textContent = "Подтверждение заказа";
      orderDialog.querySelector("#cart-order-groups").innerHTML = Object.entries(supplierNames).map(([supplier, name]) => {
        const group = items.filter((item) => item.result.supplier === supplier);
        if (!group.length) return "";
        const count = group.reduce((sum, item) => sum + item.quantity, 0);
        return `<section class="cart-order-group" data-cart-order-supplier="${supplier}" aria-labelledby="cart-order-group-${supplier}">
          <header class="cart-order-group-header"><div><h3 id="cart-order-group-${supplier}">${name}</h3><span>${group.length} поз. / ${count} шт.</span></div>
            <div class="cart-order-group-total">${renderTotals(group)}</div></header>
          <div class="cart-table-scroll"><table class="cart-table cart-order-table"><thead><tr><th>Запчасть</th><th>Наименование / доставка</th>
            <th class="cart-quantity-column">Кол-во</th><th class="cart-price-column">Цена, ₽</th><th class="cart-price-column">Стоимость, ₽</th></tr></thead><tbody>
            ${group.map(({ result, quantity }) => `<tr><td class="cart-item-part"><span>${escapeHtml(formatBrand(result.brand))}</span>
              <span class="cart-item-article">${escapeHtml(formatArticle(result.article))}</span></td><td class="cart-item-name">${escapeHtml(result.title)}
              <span class="cart-item-warehouse">${escapeHtml(result.warehouse ?? "Склад не указан")}</span>
              <span class="cart-item-warehouse"><span class="${hasOfferDeliveryWarning(result.supplier, result.deliveryDate, result.deliveryDateTo) ? "delivery-date--warning" : ""}">${escapeHtml(formatDeliveryDate(result.deliveryDate, result.deliveryDateApproximate, result.deliveryDateTo))}</span></span></td>
              <td class="cart-item-quantity" data-label="Кол-во">${quantity}</td><td class="cart-item-price" data-label="Цена, ₽">${renderPrices(result)}</td>
              <td class="cart-item-sum" data-label="Стоимость, ₽">${renderPrices(result, quantity)}</td></tr>`).join("")}
          </tbody></table></div><p class="cart-order-delivery">Дата поставки с учётом всех товаров: ${escapeHtml(formatCartLatestDeliveryDate(group))}</p></section>`;
      }).join("");
      orderDialog.querySelector("#cart-order-total").innerHTML = renderTotals(items);
      validateOrderChoices(items, choices);
      orderReceipt.hidden = true;
      orderReceipt.textContent = "";
      orderStatus.textContent = "";
      orderStatus.classList.remove("is-error");
      orderAccept.hidden = false;
      orderAccept.disabled = false;
      orderCancel.textContent = "Вернуться в корзину";
      orderDialog.showModal();
    } catch (error) { status.textContent = error.message; }
    finally { busy = false; render(); }
  });
  orderCancel.addEventListener("click", () => orderDialog.close());
  orderDialog.addEventListener("cancel", (event) => { if (checking) event.preventDefault(); });
  orderDialog.addEventListener("close", () => {
    orderTarget = null;
    if (modal.open) (testButton.disabled ? modal.querySelector("#cart-close") : testButton).focus();
  });
  orderDialog.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    const controls = [...orderDialog.querySelectorAll("button:not(:disabled), input:not(:disabled), select:not(:disabled)")]
      .filter((element) => element.getClientRects().length > 0);
    const first = controls[0];
    const last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  orderAccept.addEventListener("click", async () => {
    if (busy || checking || !orderTarget || !orderDialog.open) return;
    const { supplier, revision, items, itemIds, choices } = orderTarget;
    const details = choices?.partKom ? { partKom: { deliveryId: "regular" } } : {};
    checking = true;
    orderAccept.disabled = true;
    orderCancel.disabled = true;
    orderStatus.textContent = "Отправляем заказ поставщикам…";
    orderStatus.classList.remove("is-error");
    render();
    try {
      if (cart.revision !== revision) throw new Error("Корзина изменилась. Вернитесь в корзину и проверьте заказ заново.");
      const result = await api("/api/cart/order", { method: "POST", body: JSON.stringify({ revision, supplier, itemIds, details }) });
      if (result.supplier !== supplier || !Array.isArray(result.results) || !result.results.length) {
        throw new Error("Не удалось подтвердить результат заказа.");
      }
      const nextCart = validateCart(result.cart);
      const known = new Set(items.map((item) => item.id));
      const receipts = [];
      let accepted = 0;
      let failed = 0;
      let uncertain = 0;
      for (const group of result.results) {
        if (!group || !Object.hasOwn(supplierNames, group.supplier) || !["confirmed", "uncertain"].includes(group.status)) {
          throw new Error("Некорректный результат заказа.");
        }
        if (group.status === "uncertain") {
          failed++;
          uncertain++;
          const row = document.createElement("p");
          row.textContent = typeof group.message === "string" && group.message.length <= 300
            ? group.message : `${supplierNames[group.supplier]}: статус не подтверждён. Проверьте кабинет поставщика перед повторной попыткой.`;
          receipts.push(row);
          continue;
        }
        if (!Array.isArray(group.result?.confirmed) || !Array.isArray(group.result?.rejected)) throw new Error("Некорректный результат заказа.");
        for (const line of group.result.confirmed) {
          if (!known.has(line.id) || !Number.isSafeInteger(line.acceptedQuantity) || line.acceptedQuantity < 1
            || !Array.isArray(line.orderIds) || !line.orderIds.length || line.orderIds.some((id) => typeof id !== "string" || id.length > 100)) {
            throw new Error("Некорректное подтверждение поставщика.");
          }
          accepted++;
          const partKomOrders = group.supplier === "part-kom" && Array.isArray(line.partKomOrders)
            ? line.partKomOrders.map((receipt) => partKomReceiptNode(receipt, line.orderIds, line.acceptedQuantity)).filter(Boolean) : [];
          const forumAutoOrder = group.supplier === "forum-auto"
            ? forumAutoReceiptNode(line.forumAutoOrder, line.orderIds, line.acceptedQuantity) : null;
          const selectedItem = items.find((item) => item.id === line.id);
          const supplierOrders = selectedItem && (group.supplier === "rossko" || group.supplier === "armtek")
            ? (group.supplier === "rossko" ? line.rosskoOrders : line.armtekOrders)
            : null;
          const supplierReceipts = Array.isArray(supplierOrders)
            ? supplierOrders.map((receipt) => supplierOrderReceiptNode(group.supplier, receipt, line.orderIds, line.acceptedQuantity, selectedItem)).filter(Boolean) : [];
          if (partKomOrders.length || forumAutoOrder || supplierReceipts.length) {
            receipts.push(...partKomOrders);
            if (forumAutoOrder) receipts.push(forumAutoOrder);
            receipts.push(...supplierReceipts);
            if (typeof line.message === "string" && line.message) {
              const note = document.createElement("p");
              note.textContent = line.message;
              receipts.push(note);
            }
          }
          else {
            const row = document.createElement("p");
            row.textContent = `${supplierNames[group.supplier]}: заказ ${line.orderIds.join(", ")}, ${line.acceptedQuantity} шт.${line.message ? ` ${line.message}` : ""}`;
            receipts.push(row);
          }
        }
        for (const line of group.result.rejected) {
          if (!known.has(line.id) || typeof line.message !== "string") throw new Error("Некорректный отказ поставщика.");
          failed++;
          const row = document.createElement("p");
          row.textContent = `${supplierNames[group.supplier]}: ${line.message}`;
          receipts.push(row);
        }
      }
      if (uncertain && !result.results.some((group) => group.supplier === "armtek" && group.status === "uncertain")
        && accepted + failed < items.length) {
        const row = document.createElement("p");
        row.textContent = `Остальные выбранные товары не отправлялись: ${items.length - accepted - failed} поз.`;
        receipts.push(row);
      }
      cart = nextCart;
      selectedIds.clear();
      render();
      const complete = accepted === items.length && failed === 0 && !items.some((item) => cart.items.some((remaining) => remaining.id === item.id));
      const message = complete ? ""
        : accepted ? "Часть заказа оформлена. Подтверждённые товары удалены из корзины; остальные оставлены для проверки."
          : uncertain ? "Заказ не подтверждён. Проверьте результат у поставщика перед повторной попыткой."
            : "Заказ не оформлен. Поставщик отклонил выбранные товары.";
      orderReceipt.replaceChildren(...receipts);
      orderReceipt.hidden = false;
      orderReceipt.classList.toggle("is-error", !complete);
      status.textContent = message;
      orderStatus.textContent = message;
      orderDialog.classList.toggle("is-success", complete);
      orderStatus.classList.toggle("is-error", !complete);
      orderDialog.querySelector("#cart-order-title").textContent = complete ? "Заказ" : accepted ? "Часть заказа оформлена"
        : uncertain ? "Статус заказа" : "Заказ не оформлен";
      orderAccept.hidden = true;
      orderCancel.textContent = "Закрыть";
    } catch (error) {
      status.textContent = error.message;
      orderStatus.textContent = error.message;
      orderStatus.classList.add("is-error");
    }
    finally {
      checking = false;
      orderCancel.disabled = false;
      orderCancel.focus();
      try { await refresh(); } catch { render(); } // The saved receipt remains visible if the optional refresh fails.
    }
  });
  document.addEventListener("visibilitychange", () => { if (!document.hidden && !busy && !checking) void refresh().catch(() => {}); }); // Background refresh is optional.
  void refresh().catch(() => { badge.hidden = true; }); // Opening the cart shows any loading error.
  return { renderPrices: render, async addOffers(offers, source) {
    const added = await mutate("/api/cart/items/batch", "POST", { offers: offers.map(({ offerId, quantity }) => ({ offerId, quantity })) }, source);
    if (added && source) flyToCart(source);
    return added;
  } };
};
