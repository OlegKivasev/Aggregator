import { escapeHtml, formatArticle, formatBrand, formatPrice } from "./result-formatting.js";
import { formatDeliveryDate } from "./supplier-search-summary.js";

const supplierNames = { armtek: "Armtek", "part-kom": "PartKOM", "forum-auto": "Forum Auto", rossko: "Rossko" };
const maximumQuantity = (result) => Number.isFinite(result.quantity) ? Math.min(1_000_000, Math.floor(result.quantity)) : 0;
const cartIcon = '<img src="/shopping-cart.png" alt="" aria-hidden="true">';
const cartPriceFormat = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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
    <input class="cart-quantity" type="number" min="1" max="${Math.max(1, maximum)}" step="1" value="1" inputmode="numeric"
      aria-label="Количество для ${escapeHtml(result.article)}" ${enabled ? "" : "disabled"}>
    <button type="button" class="cart-offer-button" data-cart-offer-id="${escapeHtml(result.offerId ?? "")}" ${enabled ? "" : "disabled"}
      aria-label="Добавить в корзину" title="${title}">${cartIcon}</button></div></td>`;
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

export const bootstrapCart = ({ getMarkupPrice }) => {
  const renderPrices = (result, quantity = 1) => `<span class="cart-price main-result-price" title="Цена с наценкой">${escapeHtml(cartPriceFormat.format(getMarkupPrice(result) * quantity))}</span>
    <span class="cart-purchase-price main-result-purchase-price" title="Закупочная цена">${escapeHtml(cartPriceFormat.format(result.price * quantity))}</span>`;
  const renderTotals = (items) => {
    const price = items.reduce((sum, item) => sum + getMarkupPrice(item.result) * item.quantity, 0);
    const purchasePrice = items.reduce((sum, item) => sum + item.result.price * item.quantity, 0);
    return `<strong class="cart-total-price" title="Сумма с наценкой">${escapeHtml(formatPrice(price))}</strong>
      <span class="cart-purchase-price main-result-purchase-price" title="Закупочная сумма">${escapeHtml(formatPrice(purchasePrice))}</span>`;
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
        <th>Запчасть</th><th>Наименование</th><th id="cart-supplier-column">Поставщик</th><th>Доставка</th><th class="cart-price-column">Цена, ₽</th><th class="cart-quantity-column">Кол-во</th><th class="cart-price-column">Стоимость, ₽</th><th><span class="visually-hidden">Удалить</span></th>
      </tr></thead><tbody id="cart-items"></tbody></table></div>
      <p id="cart-summary"></p>
      <p class="cart-status" id="cart-status" role="status" aria-live="polite"></p></div>
    <footer class="cart-footer"><div class="cart-footer__summary"><span>Итого</span><span>Дата поставки с учётом всех товаров</span>
      <div id="cart-total"></div><strong id="cart-delivery-date"></strong></div>
      <button type="button" class="btn btn-primary" id="cart-test-order">Оформить заказы</button></footer>`;
  document.body.append(modal);
  const clearDialog = document.createElement("dialog");
  clearDialog.id = "cart-clear-confirm";
  clearDialog.className = "cart-modal cart-clear-confirm";
  clearDialog.setAttribute("aria-labelledby", "cart-clear-title");
  clearDialog.innerHTML = `<h3 id="cart-clear-title"></h3><div class="cart-confirm-actions">
    <button type="button" class="btn btn-light" id="cart-clear-cancel" autofocus>Отмена</button>
    <button type="button" class="btn btn-primary" id="cart-clear-accept">Очистить</button></div>`;
  document.body.append(clearDialog);
  const orderDialog = document.createElement("dialog");
  orderDialog.id = "cart-order-confirm";
  orderDialog.className = "cart-modal cart-order-confirm";
  orderDialog.setAttribute("aria-labelledby", "cart-order-title");
  orderDialog.setAttribute("aria-describedby", "cart-order-note");
  orderDialog.innerHTML = `<header class="analogs-modal__header"><h2 id="cart-order-title">Подтверждение заказа</h2></header>
    <div class="cart-content"><p class="cart-order-intro">Внимательно проверьте товары, количество, склады, сроки доставки и суммы перед заказом.</p>
      <p class="cart-order-note" id="cart-order-note">Предложения обновлены у поставщиков перед подтверждением. Проверьте цену, остаток и срок: после нажатия «Заказать» заказ будет отправлен поставщикам.</p>
      <div id="cart-order-groups"></div><div id="cart-order-fields" class="cart-order-fields"></div>
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
  const testButton = modal.querySelector("#cart-test-order");
  const clearButton = modal.querySelector("#cart-clear");
  const clearCancel = clearDialog.querySelector("#cart-clear-cancel");
  const clearAccept = clearDialog.querySelector("#cart-clear-accept");
  const orderCancel = orderDialog.querySelector("#cart-order-cancel");
  const orderAccept = orderDialog.querySelector("#cart-order-accept");
  const orderStatus = orderDialog.querySelector("#cart-order-status");
  const orderFields = orderDialog.querySelector("#cart-order-fields");
  const orderReceipt = orderDialog.querySelector("#cart-order-receipt");
  let orderTarget = null;
  let clearTarget = null;
  let cart = null;
  let busy = false;
  let checking = false;
  let toastTimeout;
  let returnFocus = toggle;
  let activeSupplier = "all";

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
    const focusedSelector = focusedControl?.matches("input") ? ".cart-quantity" : ".cart-remove";
    const locked = busy || checking || cart.testing;
    const suppliers = Object.keys(supplierNames).filter((supplier) => cart.items.some((item) => item.result.supplier === supplier));
    if (activeSupplier !== "all" && !suppliers.includes(activeSupplier)) activeSupplier = "all";
    const items = activeSupplier === "all" ? cart.items : cart.items.filter((item) => item.result.supplier === activeSupplier);
    const count = items.reduce((sum, item) => sum + item.quantity, 0);
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
    toggle.hidden = cart.count === 0;
    toggle.setAttribute("aria-label", `Открыть корзину: ${cart.count} шт.`);
    modal.querySelector("#cart-summary").textContent = `Количество: ${count} шт.`;
    modal.querySelector("#cart-total").innerHTML = renderTotals(items);
    modal.querySelector("#cart-delivery-date").textContent = formatCartLatestDeliveryDate(items);
    const pending = new Set(cart.pendingIds ?? []);
    body.innerHTML = items.length ? items.map((item) => {
      const result = item.result;
      const unresolved = pending.has(item.id);
      return `<tr data-cart-item-id="${escapeHtml(item.id)}"><td class="cart-item-part"><span>${escapeHtml(formatBrand(result.brand))}</span><span class="cart-item-article">${escapeHtml(formatArticle(result.article))}</span></td>
        <td class="cart-item-name">${escapeHtml(result.title)}${unresolved ? '<span class="cart-item-check">Статус заказа требует сверки с поставщиком.</span>' : ""}</td>
        ${activeSupplier === "all" ? `<td class="cart-item-supplier">${escapeHtml(supplierNames[result.supplier] ?? result.supplier)}<span class="cart-item-warehouse">${escapeHtml(result.warehouse ?? "Склад не указан")}</span></td>` : ""}
        <td class="cart-item-delivery">${escapeHtml(formatDeliveryDate(result.deliveryDate, result.deliveryDateApproximate, result.deliveryDateTo))}${activeSupplier !== "all" ? `<span class="cart-item-warehouse">${escapeHtml(result.warehouse ?? "Склад не указан")}</span>` : ""}</td>
        <td class="cart-item-price">${renderPrices(result)}</td>
        <td class="cart-item-quantity"><input class="cart-quantity" type="number" min="1" max="${maximumQuantity(result)}" step="1" value="${item.quantity}" inputmode="numeric"
          aria-label="Количество для ${escapeHtml(result.article)}" ${locked || unresolved ? "disabled" : ""}><span class="cart-item-stock">из ${maximumQuantity(result)}</span></td>
        <td class="cart-item-sum">${renderPrices(result, item.quantity)}</td>
        <td><button type="button" class="cart-remove btn btn-light" aria-label="Удалить ${escapeHtml(result.article)}" title="Удалить" ${locked || unresolved ? "disabled" : ""}>×</button></td></tr>`;
    }).join("") : `<tr><td colspan="${activeSupplier === "all" ? 8 : 7}" class="cart-empty">Корзина пуста. Добавьте товары из таблицы предложений.</td></tr>`;
    testButton.disabled = locked || !items.length || items.some((item) => pending.has(item.id));
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
    if (busy || checking || cart?.testing) { notify("Дождитесь завершения действия в корзине."); return; }
    busy = true;
    if (source) source.disabled = true;
    try {
      if (!cart) await refresh();
      cart = validateCart(await api(path, { method, body: JSON.stringify({ revision: cart.revision, ...fields }) }));
      status.textContent = "";
      if (source?.matches(".cart-offer-button")) { flyToCart(source); notify("Товар добавлен в корзину."); }
    } catch (error) {
      notify(error.message, true);
      status.textContent = error.message;
      try { await refresh(); } catch { /* The original actionable error remains visible. */ }
    } finally { busy = false; if (source) source.disabled = false; render(); }
  };

  toggle.addEventListener("click", async () => {
    returnFocus = document.activeElement;
    activeSupplier = "all";
    if (!modal.open) modal.showModal();
    render();
    status.textContent = "";
    try { await refresh(); } catch (error) { status.textContent = error.message; }
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
    render();
    tabs.querySelector('[aria-selected="true"]').focus();
  });
  modal.addEventListener("click", (event) => { if (event.target === modal) {
    const rect = modal.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) modal.close();
  } });
  modal.addEventListener("close", () => {
    const target = returnFocus?.hidden ? document.querySelector("#submit-button") : returnFocus;
    target?.focus();
  });
  modal.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
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
      const input = button.parentElement.querySelector(".cart-quantity");
      if (!input.reportValidity()) return;
      void mutate("/api/cart/items", "POST", { offerId: button.dataset.cartOfferId, quantity: Number(input.value) }, button);
    }
    const remove = event.target.closest?.(".cart-remove");
    if (remove) void mutate(`/api/cart/items/${encodeURIComponent(remove.closest("tr").dataset.cartItemId)}`, "DELETE", {}, remove);
  });
  body.addEventListener("change", (event) => {
    const input = event.target.closest(".cart-quantity");
    if (!input || !input.reportValidity()) return;
    void mutate(`/api/cart/items/${encodeURIComponent(input.closest("tr").dataset.cartItemId)}`, "PATCH", { quantity: Number(input.value) });
  });

  const choiceOptions = (values) => {
    if (!Array.isArray(values) || !values.length || values.some((item) => !item || typeof item.id !== "string"
      || typeof item.label !== "string" || item.id.length > 200 || item.label.length > 500)) {
      throw new Error("Поставщик не вернул доступные параметры заказа.");
    }
    return `<option value="">Выберите вариант</option>${values.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.label)}</option>`).join("")}`;
  };
  const renderOrderFields = (items, choices) => {
    const suppliers = new Set(items.map((item) => item.result.supplier));
    const sections = [];
    if (suppliers.has("part-kom")) {
      const deliveries = choices?.partKom?.deliveries;
      sections.push(`<section class="cart-order-field-group"><h3>PartKOM — доставка</h3>
        <label>Способ доставки<select id="cart-partkom-delivery" required>${choiceOptions(deliveries)}</select></label>
        <div id="cart-partkom-contact" hidden><label>Получатель<input id="cart-partkom-name" maxlength="100" autocomplete="name"></label>
        <label>Телефон<input id="cart-partkom-phone" maxlength="40" autocomplete="tel"></label></div></section>`);
    }
    if (suppliers.has("rossko")) {
      const options = choices?.rossko;
      if (!Array.isArray(options?.deliveries) || options.deliveries.some((item) => item.addressId !== null && typeof item.addressId !== "string")) {
        throw new Error("Rossko не вернул способы доставки.");
      }
      sections.push(`<section class="cart-order-field-group"><h3>Rossko — данные заказа</h3>
        <label>Доставка<select id="cart-rossko-delivery" required>${choiceOptions(options.deliveries.map((item, index) => ({ id: String(index), label: item.label })))}</select></label>
        <label>Оплата<select id="cart-rossko-payment" required>${choiceOptions(options.payments)}</select></label>
        <label>Реквизиты<select id="cart-rossko-company"><option value="">Не выбраны</option>${Array.isArray(options.companies)
          ? options.companies.filter((item) => item && typeof item.id === "string" && typeof item.label === "string")
            .map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.label)}</option>`).join("") : ""}</select></label>
        <label>Контактное лицо<input id="cart-rossko-name" required maxlength="100" autocomplete="name"></label>
        <label>Телефон<input id="cart-rossko-phone" required maxlength="40" autocomplete="tel"></label>
        <label class="cart-order-checkbox"><input id="cart-rossko-parts" type="checkbox"> Доставлять заказ по частям</label></section>`);
    }
    orderFields.innerHTML = sections.join("");
    const partKomDelivery = orderFields.querySelector("#cart-partkom-delivery");
    const updatePartKomContact = () => {
      if (!partKomDelivery) return;
      const selected = choices.partKom.deliveries.find((item) => item.id === partKomDelivery.value);
      const pickup = selected?.type === "pickup";
      const contact = orderFields.querySelector("#cart-partkom-contact");
      contact.hidden = !pickup;
      for (const input of contact.querySelectorAll("input")) input.required = pickup;
    };
    partKomDelivery?.addEventListener("change", updatePartKomContact);
    updatePartKomContact();
  };
  const collectOrderDetails = (choices) => {
    const inputs = [...orderFields.querySelectorAll("input, select")];
    if (inputs.some((input) => !input.reportValidity())) return null;
    const details = {};
    const partKom = orderFields.querySelector("#cart-partkom-delivery");
    if (partKom) details.partKom = { deliveryId: partKom.value,
      name: orderFields.querySelector("#cart-partkom-name").value,
      phone: orderFields.querySelector("#cart-partkom-phone").value };
    const rossko = orderFields.querySelector("#cart-rossko-delivery");
    if (rossko) {
      const choice = choices.rossko.deliveries[Number(rossko.value)];
      if (!choice) throw new Error("Выберите способ доставки Rossko.");
      details.rossko = { deliveryId: choice.id, addressId: choice.addressId,
        paymentId: orderFields.querySelector("#cart-rossko-payment").value,
        companyId: orderFields.querySelector("#cart-rossko-company").value || null,
        name: orderFields.querySelector("#cart-rossko-name").value.trim(), phone: orderFields.querySelector("#cart-rossko-phone").value.trim(),
        deliveryParts: orderFields.querySelector("#cart-rossko-parts").checked };
    }
    return details;
  };
  testButton.addEventListener("click", async () => {
    if (busy || checking || cart?.testing || !cart?.items.length) return;
    const supplier = activeSupplier;
    busy = true;
    render();
    try {
      await refresh();
      if (!modal.open) return;
      if (cart.testing) throw new Error("Дождитесь завершения действия в корзине.");
      status.textContent = "Обновляем предложения у поставщиков…";
      cart = validateCart(await api("/api/cart/refresh", { method: "POST", body: JSON.stringify({ revision: cart.revision, supplier }) }));
      status.textContent = "";
      render();
      const items = supplier === "all" ? cart.items : cart.items.filter((item) => item.result.supplier === supplier);
      if (!items.length) throw new Error("Добавьте товары в выбранную вкладку корзины.");
      const choices = await api(`/api/cart/order-options?revision=${cart.revision}&supplier=${encodeURIComponent(supplier)}`);
      if (!modal.open) return;
      orderTarget = { supplier, revision: cart.revision, items: structuredClone(items), choices };
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
              <span class="cart-item-warehouse">${escapeHtml(formatDeliveryDate(result.deliveryDate, result.deliveryDateApproximate, result.deliveryDateTo))}</span></td>
              <td class="cart-item-quantity" data-label="Кол-во">${quantity}</td><td class="cart-item-price" data-label="Цена, ₽">${renderPrices(result)}</td>
              <td class="cart-item-sum" data-label="Стоимость, ₽">${renderPrices(result, quantity)}</td></tr>`).join("")}
          </tbody></table></div><p class="cart-order-delivery">Дата поставки с учётом всех товаров: ${escapeHtml(formatCartLatestDeliveryDate(group))}</p></section>`;
      }).join("");
      orderDialog.querySelector("#cart-order-total").innerHTML = renderTotals(items);
      renderOrderFields(items, choices);
      orderFields.hidden = false;
      orderReceipt.hidden = true;
      orderReceipt.textContent = "";
      orderStatus.textContent = "";
      orderStatus.classList.remove("is-error", "is-success");
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
    const { supplier, revision, items, choices } = orderTarget;
    let details;
    try { details = collectOrderDetails(choices); }
    catch (error) { orderStatus.textContent = error.message; orderStatus.classList.add("is-error"); return; }
    if (!details) return;
    checking = true;
    orderAccept.disabled = true;
    orderCancel.disabled = true;
    orderStatus.textContent = "Отправляем заказ поставщикам…";
    orderStatus.classList.remove("is-error", "is-success");
    render();
    try {
      if (cart.revision !== revision) throw new Error("Корзина изменилась. Вернитесь в корзину и проверьте заказ заново.");
      const result = await api("/api/cart/order", { method: "POST", body: JSON.stringify({ revision, supplier, details }) });
      if (result.supplier !== supplier || !Array.isArray(result.results) || !result.results.length) {
        throw new Error("Не удалось подтвердить результат заказа.");
      }
      const nextCart = validateCart(result.cart);
      const known = new Set(items.map((item) => item.id));
      const receipts = [];
      let accepted = 0;
      let failed = 0;
      for (const group of result.results) {
        if (!group || !Object.hasOwn(supplierNames, group.supplier) || !["confirmed", "uncertain"].includes(group.status)) {
          throw new Error("Некорректный результат заказа.");
        }
        if (group.status === "uncertain") {
          failed++;
          receipts.push(`${supplierNames[group.supplier]}: статус не подтверждён. Проверьте кабинет поставщика перед повторной попыткой.`);
          continue;
        }
        if (!Array.isArray(group.result?.confirmed) || !Array.isArray(group.result?.rejected)) throw new Error("Некорректный результат заказа.");
        for (const line of group.result.confirmed) {
          if (!known.has(line.id) || !Number.isSafeInteger(line.acceptedQuantity) || line.acceptedQuantity < 1
            || !Array.isArray(line.orderIds) || !line.orderIds.length || line.orderIds.some((id) => typeof id !== "string" || id.length > 100)) {
            throw new Error("Некорректное подтверждение поставщика.");
          }
          accepted++;
          receipts.push(`${supplierNames[group.supplier]}: заказ ${line.orderIds.join(", ")}, ${line.acceptedQuantity} шт.${line.message ? ` ${line.message}` : ""}`);
        }
        for (const line of group.result.rejected) {
          if (!known.has(line.id) || typeof line.message !== "string") throw new Error("Некорректный отказ поставщика.");
          failed++;
          receipts.push(`${supplierNames[group.supplier]}: ${line.message}`);
        }
      }
      cart = nextCart;
      render();
      const complete = accepted === items.length && failed === 0 && !items.some((item) => cart.items.some((remaining) => remaining.id === item.id));
      const message = complete ? "Заказ успешно оформлен. Заказанные товары удалены из корзины."
        : accepted ? "Часть заказа оформлена. Подтверждённые товары удалены из корзины; остальные оставлены для проверки."
          : "Заказ не подтверждён. Проверьте результат у поставщика перед повторной попыткой.";
      orderReceipt.replaceChildren(...receipts.map((entry) => { const row = document.createElement("p"); row.textContent = entry; return row; }));
      orderReceipt.hidden = false;
      orderFields.hidden = true;
      status.textContent = message;
      orderStatus.textContent = message;
      orderStatus.classList.toggle("is-success", complete);
      orderStatus.classList.toggle("is-error", !complete);
      orderDialog.querySelector("#cart-order-title").textContent = complete ? "Заказ успешно оформлен" : accepted ? "Часть заказа оформлена" : "Статус заказа";
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
};
