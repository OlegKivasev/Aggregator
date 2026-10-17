import { minimumColumnWidth, maximumColumnWidth } from "./table-column-widths.js";

export const setupTableColumnSettings = ({ table, columnAttribute, widths, name, title, apply, save }) => {
  const menu = document.createElement("div");
  menu.className = "result-context-menu table-column-context-menu";
  menu.id = `table-column-menu-${name}`;
  menu.setAttribute("role", "menu");
  menu.hidden = true;
  const settingsButton = document.createElement("button");
  settingsButton.type = "button";
  settingsButton.setAttribute("role", "menuitem");
  settingsButton.textContent = "Настройки";
  menu.append(settingsButton);
  document.body.append(menu);
  const dialog = document.createElement("dialog");
  dialog.className = "table-column-settings-dialog";
  dialog.id = `table-column-settings-${name}`;
  dialog.setAttribute("aria-labelledby", `${dialog.id}-title`);
  dialog.innerHTML = `<form novalidate><header><h2></h2><button type="button" data-column-settings-cancel aria-label="Закрыть настройки столбцов">×</button></header>
    <p class="table-column-settings-dialog__hint">Задайте базовую ширину каждого столбца в пикселях. На широком экране свободное место распределяется между столбцами.</p>
    <div class="table-column-settings-dialog__fields"></div><p class="table-column-settings-dialog__error" role="alert" hidden></p>
    <footer><button type="button" class="btn btn-light" data-column-settings-cancel>Отмена</button><button type="submit" class="btn btn-primary">Применить</button></footer></form>`;
  const heading = dialog.querySelector("h2");
  heading.id = `${dialog.id}-title`;
  heading.textContent = title;
  document.body.append(dialog);
  const fields = dialog.querySelector(".table-column-settings-dialog__fields");
  const error = dialog.querySelector('[role="alert"]');
  let returnFocus = null;
  const hideMenu = (restoreFocus = false) => {
    menu.hidden = true;
    if (restoreFocus) returnFocus?.focus({ preventScroll: true });
  };
  const showMenu = (header, x, y) => {
    returnFocus = header.querySelector(".table-sort, .analogs-sort") ?? header;
    menu.hidden = false;
    const bounds = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(x, innerWidth - bounds.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, innerHeight - bounds.height - 8))}px`;
    settingsButton.focus({ preventScroll: true });
  };
  table.addEventListener("contextmenu", (event) => {
    const header = event.target.closest("thead th");
    if (!header || !table.contains(header)) return;
    event.preventDefault(); event.stopPropagation();
    const bounds = header.getBoundingClientRect();
    showMenu(header, event.clientX || bounds.left, event.clientY || bounds.bottom);
  });
  table.addEventListener("keydown", (event) => {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    const header = event.target.closest("thead th");
    if (!header) return;
    event.preventDefault(); event.stopPropagation();
    const bounds = header.getBoundingClientRect();
    showMenu(header, bounds.left, bounds.bottom);
  });
  settingsButton.addEventListener("click", () => {
    hideMenu(); fields.replaceChildren(); error.hidden = true;
    for (const [column, width] of Object.entries(widths)) {
      const header = table.querySelector(`th[${columnAttribute}="${column}"]`);
      const label = document.createElement("label");
      label.className = "table-column-settings-dialog__row";
      const text = document.createElement("span");
      text.textContent = header.querySelector(".table-sort, .analogs-sort").textContent.trim();
      const input = document.createElement("input");
      input.type = "number"; input.step = "1"; input.min = String(minimumColumnWidth); input.max = String(maximumColumnWidth);
      input.inputMode = "numeric"; input.value = String(width); input.dataset.widthColumn = column;
      const unit = document.createElement("span"); unit.textContent = "px";
      label.append(text, input, unit); fields.append(label);
    }
    dialog.showModal();
    fields.querySelector("input")?.focus();
  });
  dialog.querySelector("form").addEventListener("submit", (event) => {
    event.preventDefault();
    const nextWidths = {};
    for (const input of fields.querySelectorAll("input")) {
      const width = Number(input.value);
      if (!input.value.trim() || !Number.isInteger(width) || width < minimumColumnWidth || width > maximumColumnWidth) {
        error.textContent = `Укажите целую ширину от ${minimumColumnWidth} до ${maximumColumnWidth} px для каждого столбца.`;
        error.hidden = false; input.focus(); return;
      }
      nextWidths[input.dataset.widthColumn] = width;
    }
    Object.assign(widths, nextWidths); apply(); save(); dialog.close();
  });
  fields.addEventListener("input", () => { error.hidden = true; });
  dialog.querySelectorAll("[data-column-settings-cancel]").forEach((button) => button.addEventListener("click", () => dialog.close()));
  dialog.addEventListener("close", () => returnFocus?.focus({ preventScroll: true }));
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape" || event.key === "Tab") event.stopPropagation();
  });
  menu.addEventListener("keydown", (event) => {
    if (event.key === "Escape" || event.key === "Tab") { event.preventDefault(); event.stopPropagation(); hideMenu(true); }
  });
  document.addEventListener("click", (event) => { if (!menu.contains(event.target)) hideMenu(); });
  document.addEventListener("contextmenu", () => hideMenu());
  document.addEventListener("scroll", () => hideMenu(), true);
  window.addEventListener("resize", () => hideMenu());
};
