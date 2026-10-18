import { minimumColumnWidth, maximumColumnWidth } from "./table-column-widths.js";

export const setupTableColumnSettings = ({ table, columnAttribute, widths, alignments, name, title, apply, save }) => {
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
    <p class="table-column-settings-dialog__hint">Изменения сразу видны в проценке и аналогах. «Применить» сохраняет их, «Отмена» возвращает прежний вид. Ширина — от 24 до 800 px. Свободное место занимает «Наименование», а если оно скрыто — самый широкий столбец: его ширина считается минимальной.</p>
    <div class="table-column-settings-dialog__fields"></div><p class="table-column-settings-dialog__error" role="alert" hidden></p>
    <footer><button type="button" class="btn btn-light" data-column-settings-cancel>Отмена</button><button type="submit" class="btn btn-primary">Применить</button></footer></form>`;
  const heading = dialog.querySelector("h2");
  heading.id = `${dialog.id}-title`;
  heading.textContent = title;
  document.body.append(dialog);
  const fields = dialog.querySelector(".table-column-settings-dialog__fields");
  const error = dialog.querySelector('[role="alert"]');
  let returnFocus = null;
  let original = null;
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
    original = { widths: { ...widths }, alignments: { ...alignments } };
    for (const [column, width] of Object.entries(widths)) {
      const header = table.querySelector(`th[${columnAttribute}="${column}"]`);
      const label = document.createElement("label");
      label.className = "table-column-settings-dialog__row";
      const text = document.createElement("span");
      text.textContent = header.querySelector(".table-sort, .analogs-sort").textContent.trim();
      const input = document.createElement("input");
      input.type = "number"; input.step = "1"; input.min = String(minimumColumnWidth); input.max = String(maximumColumnWidth);
      input.inputMode = "numeric"; input.value = String(width); input.dataset.widthColumn = column;
      input.setAttribute("aria-label", `Ширина: ${text.textContent}`);
      const alignment = document.createElement("select");
      alignment.dataset.alignmentColumn = column;
      alignment.setAttribute("aria-label", `Выравнивание: ${text.textContent}`);
      for (const [value, caption] of [["left", "Слева"], ["center", "По центру"], ["right", "Справа"]]) {
        const option = document.createElement("option"); option.value = value; option.textContent = caption; alignment.append(option);
      }
      alignment.value = alignments[column];
      label.append(text, input, alignment); fields.append(label);
    }
    dialog.showModal();
    fields.querySelector("input")?.focus();
  });
  dialog.querySelector("form").addEventListener("submit", (event) => {
    event.preventDefault();
    const nextWidths = {};
    const nextAlignments = {};
    for (const input of fields.querySelectorAll("input")) {
      const width = Number(input.value);
      if (!input.value.trim() || !Number.isInteger(width) || width < minimumColumnWidth || width > maximumColumnWidth) {
        error.textContent = `Укажите целую ширину от ${minimumColumnWidth} до ${maximumColumnWidth} px для каждого столбца.`;
        error.hidden = false; input.focus(); return;
      }
      nextWidths[input.dataset.widthColumn] = width;
    }
    for (const select of fields.querySelectorAll("select")) {
      if (!["left", "center", "right"].includes(select.value)) { error.textContent = "Выберите выравнивание каждого столбца."; error.hidden = false; return; }
      nextAlignments[select.dataset.alignmentColumn] = select.value;
    }
    Object.assign(widths, nextWidths); Object.assign(alignments, nextAlignments); apply(); save(); original = null; dialog.close();
  });
  const preview = () => {
    if (!dialog.open || !original) return;
    error.hidden = true;
    for (const input of fields.querySelectorAll("input")) {
      const value = Number(input.value);
      if (input.value.trim() && Number.isInteger(value) && value >= minimumColumnWidth && value <= maximumColumnWidth) widths[input.dataset.widthColumn] = value;
    }
    for (const select of fields.querySelectorAll("select")) if (["left", "center", "right"].includes(select.value)) alignments[select.dataset.alignmentColumn] = select.value;
    apply();
  };
  fields.addEventListener("input", preview);
  fields.addEventListener("change", preview);
  const discardPreview = () => {
    if (original) { Object.assign(widths, original.widths); Object.assign(alignments, original.alignments); original = null; apply(); }
  };
  const cancel = () => { discardPreview(); dialog.close(); };
  dialog.querySelectorAll("[data-column-settings-cancel]").forEach((button) => button.addEventListener("click", cancel));
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); cancel(); });
  dialog.addEventListener("close", () => {
    discardPreview();
    returnFocus?.focus({ preventScroll: true });
  });
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
