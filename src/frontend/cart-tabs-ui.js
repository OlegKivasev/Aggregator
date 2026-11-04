import { escapeHtml } from "./result-formatting.js";
import { setupTabCloseMenu } from "./tab-close-menu.js";
import { cartTabItems, moveCartItem, normalizeCartTabs, reorderCartTab } from "./cart-tab-state.js";

const storageKey = "autoservice.cartTabs";

export const setupCartTabs = ({ modal, supplierNames, getCart, isLocked, onChange, notify }) => {
  const strip = modal.querySelector("#cart-tabs");
  const options = document.createElement("label");
  options.className = "cart-tab-options";
  options.hidden = true;
  options.innerHTML = '<input type="checkbox" id="cart-tab-exclude"> Не показывать товары этой вкладки в «Все»';
  strip.after(options);
  const exclude = options.querySelector("input");
  const menu = document.createElement("div");
  menu.id = "cart-tab-context-menu";
  menu.className = "tab-context-menu";
  menu.setAttribute("role", "menu");
  menu.hidden = true;
  menu.innerHTML = `<button type="button" id="cart-tab-rename" role="menuitem">Переименовать вкладку</button>
    <div class="tab-close-control">
      <button type="button" data-tab-close-toggle role="menuitem" aria-haspopup="menu" aria-expanded="false" aria-controls="cart-tab-close-submenu">Закрыть <span aria-hidden="true">›</span></button>
      <div class="tab-close-submenu" id="cart-tab-close-submenu" role="menu" aria-label="Закрыть вкладки корзины" hidden>
        <button type="button" data-tab-close-action="current" role="menuitem">Закрыть вкладку</button>
        <button type="button" data-tab-close-action="others" role="menuitem">Закрыть все, кроме выделенной</button>
        <button type="button" data-tab-close-action="right" role="menuitem">Закрыть все правее</button>
        <button type="button" data-tab-close-action="left" role="menuitem">Закрыть все левее</button>
      </div>
    </div>`;
  modal.append(menu);
  const rename = document.createElement("dialog");
  rename.id = "cart-tab-rename-dialog";
  rename.className = "cart-modal cart-tab-rename-dialog";
  rename.setAttribute("aria-labelledby", "cart-tab-rename-title");
  rename.innerHTML = `<form><h3 id="cart-tab-rename-title">Название вкладки</h3>
    <input id="cart-tab-name" aria-label="Название вкладки" maxlength="100" required>
    <div class="cart-confirm-actions"><button type="button" class="btn btn-light" id="cart-tab-rename-cancel">Отмена</button>
      <button type="submit" class="btn btn-primary">Сохранить</button></div></form>`;
  document.body.append(rename);
  const nameInput = rename.querySelector("input");
  let customTabs = [];
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored && stored.length <= 256_000) customTabs = normalizeCartTabs(JSON.parse(stored));
  } catch { /* Corrupt or unavailable browser storage must not prevent cart use. */ }
  let activeId = "all";
  let contextId = null;
  let renameId = null;
  let drag = null;
  let stripHtml = "";
  let storageWarningShown = false;
  const getItems = (tabId = activeId) => cartTabItems(getCart()?.items ?? [], customTabs, tabId);
  const getName = () => customTabs.find((tab) => tab.id === activeId)?.name ?? supplierNames[activeId] ?? "Все";
  const getSupplier = () => Object.hasOwn(supplierNames, activeId) ? activeId : "all";
  const focusActive = () => strip.querySelector('[aria-selected="true"]')?.focus();
  const persist = () => {
    try { localStorage.setItem(storageKey, JSON.stringify({ version: 1, tabs: customTabs })); }
    catch {
      if (!storageWarningShown) notify("Не удалось сохранить вкладки в браузере. Изменения доступны до перезагрузки страницы.", true);
      storageWarningShown = true;
    }
  };
  const hideMenu = (restoreFocus = false) => {
    closeMenu.hide();
    menu.hidden = true;
    if (restoreFocus) strip.querySelector(`[data-cart-supplier="${contextId}"]`)?.focus();
    contextId = null;
  };
  const closeTabs = (ids) => {
    if (isLocked()) return;
    ids = ids.filter((id) => customTabs.some((tab) => tab.id === id));
    if (!ids.length) return;
    customTabs = customTabs.filter((tab) => !ids.includes(tab.id));
    if (ids.includes(activeId)) activeId = "all";
    hideMenu();
    persist();
    onChange();
    focusActive();
  };
  const closeMenu = setupTabCloseMenu(menu, { getTabs: () => customTabs, getSelectedId: () => contextId, closeTabs });
  const showMenu = (tab, x, y) => {
    if (isLocked() || !customTabs.some((item) => item.id === tab.dataset.cartSupplier)) return;
    contextId = tab.dataset.cartSupplier;
    closeMenu.refresh();
    menu.hidden = false;
    const bounds = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(x, innerWidth - bounds.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, innerHeight - bounds.height - 8))}px`;
    menu.querySelector("button").focus();
  };
  const openRename = (id) => {
    if (isLocked()) return;
    const tab = customTabs.find((item) => item.id === id);
    if (!tab) return;
    renameId = id;
    nameInput.value = tab.name;
    hideMenu();
    rename.showModal();
    nameInput.select();
  };
  menu.querySelector("#cart-tab-rename").addEventListener("click", () => openRename(contextId));
  rename.querySelector("form").addEventListener("submit", (event) => {
    event.preventDefault();
    const name = nameInput.value.trim();
    if (!name || isLocked()) return;
    customTabs = customTabs.map((tab) => tab.id === renameId ? { ...tab, name } : tab);
    persist();
    rename.close();
    onChange();
    focusActive();
  });
  rename.querySelector("#cart-tab-rename-cancel").addEventListener("click", () => rename.close());
  rename.addEventListener("close", () => { renameId = null; focusActive(); });
  exclude.addEventListener("change", () => {
    if (isLocked()) return;
    customTabs = customTabs.map((tab) => tab.id === activeId ? { ...tab, excludeFromAll: exclude.checked } : tab);
    persist();
    onChange();
  });
  strip.addEventListener("click", (event) => {
    if (isLocked()) return;
    const close = event.target.closest("[data-cart-close-tab]");
    if (close) return closeTabs([close.dataset.cartCloseTab]);
    if (event.target.closest("#cart-new-tab")) {
      if (customTabs.length >= 100) return notify("Можно создать не более 100 вкладок корзины.", true);
      let number = 1;
      while (customTabs.some((tab) => tab.name === `Вкладка ${number}`)) number++;
      activeId = `custom-${crypto.randomUUID()}`;
      customTabs.push({ id: activeId, name: `Вкладка ${number}`, excludeFromAll: false, itemIds: [] });
      persist();
    } else {
      const tab = event.target.closest(".cart-tab");
      if (!tab) return;
      activeId = tab.dataset.cartSupplier;
    }
    hideMenu();
    onChange();
    focusActive();
    strip.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  });
  strip.addEventListener("dblclick", (event) => {
    const tab = event.target.closest(".cart-tab");
    if (tab) openRename(tab.dataset.cartSupplier);
  });
  strip.addEventListener("contextmenu", (event) => {
    const tab = event.target.closest(".cart-tab");
    if (!tab) return;
    event.preventDefault();
    showMenu(tab, event.clientX, event.clientY);
  });
  strip.addEventListener("keydown", (event) => {
    const tab = event.target.closest(".cart-tab");
    if (!tab || isLocked()) return;
    if (event.key === "ContextMenu" || event.shiftKey && event.key === "F10") {
      event.preventDefault();
      const bounds = tab.getBoundingClientRect();
      showMenu(tab, bounds.left, bounds.bottom);
      return;
    }
    if (!["ArrowLeft", "ArrowRight", "Home", "End", "Delete"].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "Delete") return closeTabs([tab.dataset.cartSupplier]);
    const buttons = [...strip.querySelectorAll(".cart-tab")];
    const current = buttons.indexOf(tab);
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
      : (current + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
    activeId = buttons[next].dataset.cartSupplier;
    hideMenu();
    onChange();
    focusActive();
    strip.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  });
  modal.addEventListener("pointerdown", (event) => { if (!menu.contains(event.target)) hideMenu(); });
  modal.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !menu.hidden) { event.preventDefault(); event.stopPropagation(); hideMenu(true); }
  });
  modal.addEventListener("close", () => { hideMenu(); clearDrag(); });
  window.addEventListener("resize", () => hideMenu());
  modal.querySelector(".cart-content").addEventListener("scroll", () => hideMenu());
  strip.addEventListener("scroll", () => hideMenu());

  const clearPreview = () => {
    for (const node of strip.querySelectorAll(".is-drop-target, .is-drop-before, .is-drop-after")) {
      node.classList.remove("is-drop-target", "is-drop-before", "is-drop-after");
    }
  };
  const clearDrag = () => {
    drag = null;
    clearPreview();
    modal.querySelector(".is-cart-dragging")?.classList.remove("is-cart-dragging");
  };
  modal.addEventListener("dragstart", (event) => {
    const tab = event.target.closest(".cart-tab");
    const row = event.target.closest("#cart-items tr[data-cart-item-id]");
    if (isLocked() || !event.dataTransfer || !tab && !row) return event.preventDefault();
    if (row && event.target.closest("input, button, a")) return event.preventDefault();
    if (tab && !customTabs.some((item) => item.id === tab.dataset.cartSupplier)) return event.preventDefault();
    drag = tab ? { type: "tab", id: tab.dataset.cartSupplier } : { type: "item", id: row.dataset.cartItemId };
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(`application/x-autoservice-cart-${drag.type}`, drag.id);
    (tab ?? row).classList.add("is-cart-dragging");
    hideMenu();
  });
  const dropTarget = (event) => {
    const tab = event.target.closest(".cart-tab-entry")?.querySelector(".cart-tab");
    if (!drag || isLocked() || !tab) return null;
    const id = tab.dataset.cartSupplier;
    const custom = customTabs.some((item) => item.id === id);
    if (drag.type === "tab") return custom && id !== drag.id ? tab : null;
    const item = getCart()?.items.find((item) => item.id === drag.id);
    return item && (custom || id === "all" || id === item.result.supplier) ? tab : null;
  };
  strip.addEventListener("dragover", (event) => {
    clearPreview();
    const tab = dropTarget(event);
    if (!tab) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const bounds = tab.getBoundingClientRect();
    tab.classList.add(drag.type === "item" ? "is-drop-target" : event.clientX > bounds.left + bounds.width / 2 ? "is-drop-after" : "is-drop-before");
  });
  strip.addEventListener("dragleave", (event) => { if (!strip.contains(event.relatedTarget)) clearPreview(); });
  strip.addEventListener("drop", (event) => {
    const tab = dropTarget(event);
    if (!tab) return clearDrag();
    event.preventDefault();
    const id = tab.dataset.cartSupplier;
    if (drag.type === "item") customTabs = moveCartItem(customTabs, drag.id, id);
    else {
      const bounds = tab.getBoundingClientRect();
      customTabs = reorderCartTab(customTabs, drag.id, id, event.clientX > bounds.left + bounds.width / 2);
    }
    clearDrag();
    persist();
    onChange();
  });
  modal.addEventListener("dragend", clearDrag);

  const render = () => {
    const cart = getCart();
    if (!cart) return;
    const previousFocus = document.activeElement.closest?.(".cart-tab")?.dataset.cartSupplier;
    const currentIds = new Set(cart.items.map((item) => item.id));
    let pruned = false;
    customTabs = customTabs.map((tab) => {
      const itemIds = tab.itemIds.filter((id) => currentIds.has(id));
      pruned ||= itemIds.length !== tab.itemIds.length;
      return { ...tab, itemIds };
    });
    if (pruned) persist();
    const suppliers = Object.keys(supplierNames).filter((supplier) => cart.items.some((item) => item.result.supplier === supplier));
    if (activeId !== "all" && !suppliers.includes(activeId) && !customTabs.some((tab) => tab.id === activeId)) activeId = "all";
    const locked = isLocked();
    const html = [{ id: "all", name: "Все" }, ...suppliers.map((id) => ({ id, name: supplierNames[id] })), ...customTabs].map((tab) => {
      const custom = customTabs.includes(tab);
      const count = getItems(tab.id).reduce((sum, item) => sum + item.quantity, 0);
      return `<div class="cart-tab-entry${custom ? " cart-tab-entry--custom" : ""}" role="presentation">
        <button type="button" class="cart-tab" id="cart-tab-${tab.id}" role="tab" data-cart-supplier="${tab.id}" draggable="${custom && !locked}"
          aria-selected="false" aria-controls="cart-tab-panel" tabindex="-1"
          aria-label="${escapeHtml(tab.name)}${tab.id === "all" ? "" : `: ${count} шт.`}" ${locked ? "disabled" : ""}>
          <span class="cart-tab__name">${escapeHtml(tab.name)}</span>${tab.id === "all" ? "" : `<span class="cart-tab__count" aria-hidden="true">${count}</span>`}</button>
        ${custom ? `<button type="button" class="cart-tab-close" data-cart-close-tab="${tab.id}" aria-label="Закрыть вкладку «${escapeHtml(tab.name)}»" title="Закрыть вкладку" ${locked ? "disabled" : ""}>×</button>` : ""}</div>`;
    }).join("") + `<button type="button" class="new-tab-button btn btn-light" id="cart-new-tab" aria-label="Добавить вкладку корзины" title="Добавить вкладку" ${locked ? "disabled" : ""}>+</button>`;
    if (html !== stripHtml) { strip.innerHTML = html; stripHtml = html; }
    for (const tab of strip.querySelectorAll(".cart-tab")) {
      const selected = tab.dataset.cartSupplier === activeId;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    const custom = customTabs.find((tab) => tab.id === activeId);
    options.hidden = !custom;
    exclude.checked = custom?.excludeFromAll === true;
    exclude.disabled = locked;
    modal.querySelector("#cart-tab-panel").setAttribute("aria-labelledby", `cart-tab-${activeId}`);
    if (previousFocus && modal.open) (strip.querySelector(`[data-cart-supplier="${previousFocus}"]`) ?? strip.querySelector('[aria-selected="true"]'))?.focus();
  };
  return { render, getItems, getName, getSupplier, reset: () => { activeId = "all"; hideMenu(); } };
};
