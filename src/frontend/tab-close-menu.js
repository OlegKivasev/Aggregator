export function tabIdsToClose(tabs, selectedId, action) {
  const index = tabs.findIndex((tab) => tab.id === selectedId);
  if (index < 0) return [];
  if (action === "current") return [selectedId];
  if (action === "others") return tabs.filter((tab) => tab.id !== selectedId).map((tab) => tab.id);
  if (action === "right") return tabs.slice(index + 1).map((tab) => tab.id);
  if (action === "left") return tabs.slice(0, index).map((tab) => tab.id);
  return [];
}

export function setupTabCloseMenu(menu, { getTabs, getSelectedId, closeTabs }) {
  const control = menu.querySelector(".tab-close-control");
  const toggle = control.querySelector("[data-tab-close-toggle]");
  const submenu = control.querySelector("[role='menu']");
  const actions = [...submenu.querySelectorAll("[data-tab-close-action]")];
  const hide = () => {
    submenu.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
  };
  const refresh = () => {
    hide();
    control.hidden = !getSelectedId();
    for (const button of actions) button.disabled = !tabIdsToClose(getTabs(), getSelectedId(), button.dataset.tabCloseAction).length;
  };
  const show = () => {
    if (control.hidden) return;
    submenu.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
    const anchor = toggle.getBoundingClientRect();
    const parent = menu.getBoundingClientRect();
    const bounds = submenu.getBoundingClientRect();
    const right = parent.right - 4;
    const left = parent.left - bounds.width + 4;
    const beside = right + bounds.width <= window.innerWidth - 8 || left >= 8;
    submenu.style.left = `${Math.max(8, Math.min(right + bounds.width <= window.innerWidth - 8 ? right : left >= 8 ? left : parent.left, window.innerWidth - bounds.width - 8))}px`;
    submenu.style.top = `${Math.max(8, Math.min(beside ? anchor.top - 6 : parent.bottom - 4, window.innerHeight - bounds.height - 8))}px`;
  };
  control.addEventListener("pointerenter", show);
  control.addEventListener("pointerleave", () => {
    if (!submenu.contains(document.activeElement)) hide();
  });
  toggle.addEventListener("click", () => { show(); actions.find((button) => !button.disabled)?.focus(); });
  submenu.addEventListener("click", (event) => {
    const button = event.target.closest("[data-tab-close-action]");
    if (!button || button.disabled) return;
    const ids = tabIdsToClose(getTabs(), getSelectedId(), button.dataset.tabCloseAction);
    hide();
    closeTabs(ids);
  });
  menu.addEventListener("keydown", (event) => {
    if (event.key === "ArrowRight" && event.target === toggle) {
      event.preventDefault();
      show();
      actions.find((button) => !button.disabled)?.focus();
    } else if ((event.key === "ArrowLeft" || event.key === "Escape") && !submenu.hidden) {
      event.preventDefault();
      event.stopPropagation();
      hide();
      toggle.focus();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const buttons = [...(submenu.contains(event.target) ? submenu : menu).querySelectorAll("button")]
        .filter((button) => !button.disabled && button.offsetParent !== null && (submenu.contains(event.target) || !submenu.contains(button)));
      const index = buttons.indexOf(document.activeElement);
      buttons[(index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    }
  });
  return { hide, refresh };
}
