import { escapeHtml, formatArticle, formatBrand, formatPrice } from "./result-formatting.js";

const supplierNames = { armtek: "Armtek", "part-kom": "PartKOM" };
const maximumQuantity = (result) => Number.isFinite(result.quantity) ? Math.min(1_000_000, Math.floor(result.quantity)) : 0;
const cartIcon = '<img src="/shopping-cart.png" alt="" aria-hidden="true">';

export const renderCartOfferControls = (result) => {
  const maximum = maximumQuantity(result);
  const supported = Object.hasOwn(supplierNames, result.supplier);
  const enabled = supported && maximum > 0 && typeof result.offerId === "string" && /^[0-9a-f-]{36}$/.test(result.offerId);
  const title = !supported ? "Корзина пока доступна для PartKOM и Armtek" : maximum < 1
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
  return value;
};

export const bootstrapCart = () => {
  const toggle = document.querySelector("#cart-toggle");
  const badge = document.querySelector("#cart-badge");
  const modal = document.createElement("dialog");
  modal.id = "cart-modal";
  modal.className = "cart-modal";
  modal.setAttribute("aria-labelledby", "cart-title");
  modal.innerHTML = `<header class="analogs-modal__header"><div><h2 id="cart-title">Корзина</h2><p id="cart-summary"></p></div>
    <button type="button" class="btn btn-light analogs-modal__close" id="cart-close" aria-label="Закрыть корзину">×</button></header>
    <div class="cart-content"><p class="cart-test-note">Тестовая проверка PartKOM и Armtek. Товары не заказываются и не оплачиваются.</p>
      <div class="cart-table-scroll"><table class="table align-middle cart-table"><thead><tr>
        <th>Товар</th><th>Поставщик / склад</th><th>Количество</th><th>Цена закупки</th><th>Сумма</th><th><span class="visually-hidden">Удалить</span></th>
      </tr></thead><tbody id="cart-items"></tbody></table></div>
      <p class="cart-status" id="cart-status" role="status" aria-live="polite"></p></div>
    <footer class="cart-footer"><div><span>Итого по закупке</span><strong id="cart-total"></strong></div>
      <button type="button" class="btn btn-primary" id="cart-test-order">Проверить заказ</button></footer>`;
  document.body.append(modal);
  const toast = document.createElement("div");
  toast.className = "cart-toast";
  toast.hidden = true;
  toast.setAttribute("role", "status");
  toast.setAttribute("aria-live", "polite");
  document.body.append(toast);
  const body = modal.querySelector("#cart-items");
  const status = modal.querySelector("#cart-status");
  const testButton = modal.querySelector("#cart-test-order");
  let cart = null;
  let busy = false;
  let checking = false;
  let testResults = new Map();
  let testedRevision = null;
  let toastTimeout;
  let returnFocus = toggle;

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
    const focusedId = focusedControl?.closest("tr")?.dataset.cartItemId;
    const focusedSelector = focusedControl?.matches("input") ? ".cart-quantity" : ".cart-remove";
    const locked = busy || checking || cart.testing;
    badge.textContent = String(cart.count);
    badge.hidden = cart.count === 0;
    toggle.setAttribute("aria-label", `Открыть корзину: ${cart.count} шт.`);
    modal.querySelector("#cart-summary").textContent = `Позиций: ${cart.items.length}, ${cart.count} шт.`;
    modal.querySelector("#cart-total").textContent = formatPrice(cart.total);
    if (testedRevision !== cart.revision) testResults.clear();
    body.innerHTML = cart.items.length ? cart.items.map((item) => {
      const result = item.result;
      const checked = testResults.get(item.id);
      const checkClass = checked?.status === "accepted" ? "is-accepted" : "is-unconfirmed";
      return `<tr data-cart-item-id="${escapeHtml(item.id)}"><td><strong>${escapeHtml(formatBrand(result.brand))} ${escapeHtml(formatArticle(result.article))}</strong>
        <span class="cart-item-title">${escapeHtml(result.title)}</span>${checked ? `<span class="cart-item-check ${checkClass}">${escapeHtml(checked.message)}</span>` : ""}</td>
        <td>${escapeHtml(supplierNames[result.supplier] ?? result.supplier)}<span class="cart-item-warehouse">${escapeHtml(result.warehouse ?? "Склад не указан")}</span></td>
        <td><input class="cart-quantity" type="number" min="1" max="${maximumQuantity(result)}" step="1" value="${item.quantity}" inputmode="numeric"
          aria-label="Количество для ${escapeHtml(result.article)}" ${locked ? "disabled" : ""}><span class="cart-item-stock">из ${maximumQuantity(result)}</span></td>
        <td>${escapeHtml(formatPrice(result.price))}</td><td>${escapeHtml(formatPrice(result.price * item.quantity))}</td>
        <td><button type="button" class="cart-remove btn btn-light" aria-label="Удалить ${escapeHtml(result.article)}" title="Удалить" ${locked ? "disabled" : ""}>×</button></td></tr>`;
    }).join("") : '<tr><td colspan="6" class="cart-empty">Корзина пуста. Добавьте товары из таблицы предложений.</td></tr>';
    testButton.disabled = locked || !cart.items.length;
    testButton.textContent = checking ? "Проверяем…" : "Проверить заказ";
    if (modal.open && focusedId) {
      const replacement = body.querySelector(`[data-cart-item-id="${CSS.escape(focusedId)}"] ${focusedSelector}`);
      if (replacement && !replacement.disabled) replacement.focus();
      else modal.querySelector("#cart-close").focus();
    }
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
      testedRevision = null;
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
    if (!modal.open) modal.showModal();
    status.textContent = "";
    try { await refresh(); } catch (error) { status.textContent = error.message; }
  });
  modal.querySelector("#cart-close").addEventListener("click", () => modal.close());
  modal.addEventListener("click", (event) => { if (event.target === modal) {
    const rect = modal.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) modal.close();
  } });
  modal.addEventListener("close", () => returnFocus?.focus());
  modal.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    const controls = [...modal.querySelectorAll('button:not(:disabled), input:not(:disabled), [tabindex="0"]')]
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
  testButton.addEventListener("click", async () => {
    if (busy || checking || !cart?.items.length) return;
    checking = true;
    status.textContent = "Проверяем товары у поставщиков…";
    render();
    try {
      const result = await api("/api/cart/test-order", { method: "POST", body: JSON.stringify({ revision: cart.revision }) });
      if (result.testOnly !== true || !Array.isArray(result.results) || result.revision !== cart.revision
        || result.results.length !== cart.items.length || new Set(result.results.map((item) => item?.id)).size !== cart.items.length
        || result.results.some((item) => !item || typeof item.message !== "string" || !cart.items.some((line) => line.id === item.id)
          || !["accepted", "rejected", "unconfirmed"].includes(item.status)
          || item.status === "accepted" && item.acceptedQuantity !== cart.items.find((line) => line.id === item.id).quantity)) throw new Error("Тестовая проверка не подтверждена.");
      testResults = new Map(result.results.map((item) => [item.id, item]));
      testedRevision = result.revision;
      status.textContent = result.results.length === cart.items.length && result.results.every((item) => item.status === "accepted")
        ? "Тестовая проверка пройдена. Реальный заказ не создан." : "Проверка завершена. Посмотрите результат под каждой позицией.";
    } catch (error) { status.textContent = error.message; }
    finally {
      checking = false;
      try { await refresh(); } catch { render(); } // Keep the check result visible if the optional reload fails.
    }
  });
  document.addEventListener("visibilitychange", () => { if (!document.hidden && !busy && !checking) void refresh().catch(() => {}); }); // Background refresh is optional.
  void refresh().catch(() => { badge.hidden = true; }); // Opening the cart shows any loading error.
};
