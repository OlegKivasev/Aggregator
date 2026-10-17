import { escapeHtml } from "./result-formatting.js";
import { maximumMarkupTiers, validateMarkupSettings } from "./markup-settings.js";

export const bootstrapMarkupSettings = ({ getSettings, applySettings }) => {
  const dialog = document.createElement("dialog");
  dialog.id = "markup-settings-dialog";
  dialog.className = "markup-settings";
  dialog.setAttribute("aria-labelledby", "markup-settings-title");
  dialog.innerHTML = `<form novalidate>
    <header><h2 id="markup-settings-title">Клиентская наценка</h2><button type="button" data-markup-close aria-label="Закрыть настройки наценки">×</button></header>
    <div class="markup-settings__tabs" role="tablist" aria-label="Режим наценки">
      <button type="button" role="tab" data-markup-mode="none" aria-controls="markup-mode-panel">Без наценки</button>
      <button type="button" role="tab" data-markup-mode="fixed" aria-controls="markup-mode-panel">Фиксированная</button>
      <button type="button" role="tab" data-markup-mode="tiered" aria-controls="markup-mode-panel">Ступенчатая</button>
    </div>
    <div id="markup-mode-panel" role="tabpanel">
      <p data-markup-panel="none">Цены на товары будут отображаться закупочные. Установите наценку на товары, чтобы не работать в убыток.</p>
      <div data-markup-panel="fixed"><label for="markup-fixed-percent">Наценка, %</label><div class="markup-number"><input id="markup-fixed-percent" inputmode="decimal" autocomplete="off"><button type="button" data-markup-clear aria-label="Очистить наценку">×</button></div></div>
      <div data-markup-panel="tiered" hidden><div class="markup-tier-head"><span>Цена до, ₽</span><span>Наценка, %</span></div><div id="markup-tiers"></div>
        <button type="button" class="markup-add-tier" id="markup-add-tier">⊕ Добавить ступень</button>
        <div class="markup-fallback"><label for="markup-fallback-percent">В иных случаях<br>наценка, %</label><div class="markup-number"><input id="markup-fallback-percent" inputmode="decimal" autocomplete="off"><button type="button" data-markup-clear aria-label="Очистить наценку в иных случаях">×</button></div></div>
      </div>
    </div>
    <fieldset id="markup-display"><legend>Показывать на сайте:</legend>
      <label><input type="radio" name="markup-display" value="both">Нацененную и закупочную цены</label>
      <label class="markup-cart-choice"><input id="markup-show-in-cart" type="checkbox">Показывать в корзине</label>
      <label><input type="radio" name="markup-display" value="retail">Только нацененную цену</label>
    </fieldset>
    <p id="markup-settings-error" class="markup-settings__error" role="alert" hidden></p>
    <button type="submit" class="btn btn-primary" id="markup-apply">Применить</button>
  </form>`;
  document.body.append(dialog);
  const form = dialog.querySelector("form");
  const tabs = [...dialog.querySelectorAll("[data-markup-mode]")];
  const fixed = dialog.querySelector("#markup-fixed-percent");
  const fallback = dialog.querySelector("#markup-fallback-percent");
  const tierContainer = dialog.querySelector("#markup-tiers");
  const addTier = dialog.querySelector("#markup-add-tier");
  const display = dialog.querySelector("#markup-display");
  const cartChoice = dialog.querySelector("#markup-show-in-cart");
  const error = dialog.querySelector("#markup-settings-error");
  const triggers = [...document.querySelectorAll("[data-markup-settings]")];
  let mode = "fixed";
  let anchor = null;
  const position = () => {
    if (!dialog.open || !anchor) return;
    const rect = anchor.getBoundingClientRect();
    const width = dialog.getBoundingClientRect().width;
    dialog.style.left = `${Math.max(8, Math.min(innerWidth - width - 8, rect.right - width))}px`;
    dialog.style.top = `${Math.max(8, Math.min(rect.bottom + 10, innerHeight - dialog.getBoundingClientRect().height - 8))}px`;
  };
  const selectMode = (next) => {
    mode = next;
    tabs.forEach((tab) => { const selected = tab.dataset.markupMode === mode; tab.setAttribute("aria-selected", String(selected)); tab.tabIndex = selected ? 0 : -1; });
    dialog.querySelectorAll("[data-markup-panel]").forEach((panel) => { panel.hidden = panel.dataset.markupPanel !== mode; });
    dialog.querySelector("#markup-mode-panel").setAttribute("aria-labelledby", `markup-mode-${mode}`);
    display.hidden = mode === "none";
    error.hidden = true;
    position();
  };
  const updateCartChoice = () => { cartChoice.disabled = form.elements["markup-display"].value !== "both"; };
  const appendTier = (tier = {}) => {
    if (tierContainer.children.length >= maximumMarkupTiers) return;
    const row = document.createElement("div");
    row.className = "markup-tier";
    row.innerHTML = `<div class="markup-number"><input data-tier-price aria-label="Цена до, ₽" inputmode="decimal" autocomplete="off" value="${escapeHtml(tier.upTo ?? "")}"><button type="button" data-markup-clear aria-label="Очистить цену ступени">×</button></div>
      <div class="markup-number"><input data-tier-percent aria-label="Наценка ступени, %" inputmode="decimal" autocomplete="off" value="${escapeHtml(tier.percent ?? "")}"><button type="button" data-markup-clear aria-label="Очистить наценку ступени">×</button></div>
      <button type="button" data-tier-remove aria-label="Удалить ступень" title="Удалить ступень"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7m4-7v7"/></svg></button>`;
    tierContainer.append(row);
    addTier.disabled = tierContainer.children.length >= maximumMarkupTiers;
    position();
  };
  const number = (input) => {
    const text = input.value.trim().replace(",", ".");
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text) || !Number.isFinite(Number(text))) {
      input.focus(); throw new Error("Заполните числовые поля. Для нулевой наценки укажите 0.");
    }
    return Number(text);
  };
  tabs.forEach((tab, index) => {
    tab.id = `markup-mode-${tab.dataset.markupMode}`;
    tab.addEventListener("click", () => selectMode(tab.dataset.markupMode));
    tab.addEventListener("keydown", (event) => {
      const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length
        : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
      if (next === null) return;
      event.preventDefault(); tabs[next].click(); tabs[next].focus();
    });
  });
  triggers.forEach((trigger) => trigger.addEventListener("click", () => {
    if (dialog.open) { dialog.close(); return; }
    anchor = trigger;
    const settings = getSettings();
    fixed.value = String(settings.percent);
    fallback.value = String(settings.fallbackPercent);
    form.elements["markup-display"].value = settings.display;
    cartChoice.checked = settings.showPurchaseInCart;
    tierContainer.replaceChildren();
    addTier.disabled = false;
    settings.tiers.forEach(appendTier);
    updateCartChoice(); selectMode(settings.mode);
    trigger.setAttribute("aria-expanded", "true");
    dialog.showModal(); position();
    tabs.find((tab) => tab.dataset.markupMode === mode).focus();
  }));
  dialog.addEventListener("click", (event) => {
    const target = event.target.closest("button");
    if (target?.hasAttribute("data-markup-close")) dialog.close();
    if (target?.hasAttribute("data-markup-clear")) { const input = target.parentElement.querySelector("input"); input.value = ""; input.focus(); }
    if (target?.hasAttribute("data-tier-remove")) {
      const row = target.closest(".markup-tier");
      const next = row.nextElementSibling ?? row.previousElementSibling;
      row.remove(); addTier.disabled = false; (next?.querySelector("input") ?? addTier).focus(); position();
    }
    if (event.target === dialog) {
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
    }
  });
  dialog.addEventListener("close", () => { anchor?.setAttribute("aria-expanded", "false"); anchor?.focus({ preventScroll: true }); });
  dialog.addEventListener("keydown", (event) => {
    // The native dialog owns focus and Escape while the analog overlay stays open underneath.
    if (event.key === "Escape" || event.key === "Tab") event.stopPropagation();
  });
  addTier.addEventListener("click", () => { appendTier(); tierContainer.lastElementChild?.querySelector("input").focus(); });
  display.addEventListener("change", updateCartChoice);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      const previous = getSettings();
      const settings = validateMarkupSettings({ mode, percent: mode === "fixed" ? number(fixed) : previous.percent,
        fallbackPercent: mode === "tiered" ? number(fallback) : previous.fallbackPercent,
        tiers: mode === "tiered" ? [...tierContainer.children].map((row) => ({ upTo: number(row.querySelector("[data-tier-price]")), percent: number(row.querySelector("[data-tier-percent]")) })) : previous.tiers,
        display: form.elements["markup-display"].value, showPurchaseInCart: cartChoice.checked });
      applySettings(settings); dialog.close();
    } catch (cause) { error.textContent = cause.message; error.hidden = false; position(); }
  });
  window.addEventListener("resize", position);
};
