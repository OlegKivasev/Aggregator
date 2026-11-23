const positionsUrl = "/api/users/positions";
const nameOrder = new Intl.Collator("ru-RU");

export function setupUserPositions(messageFor) {
  const dialog = document.querySelector("#user-positions-dialog");
  const open = document.querySelector("#user-positions-open");
  const close = dialog.querySelector("#user-positions-close");
  const heading = dialog.querySelector("h2");
  const directory = dialog.querySelector("#user-positions-directory");
  const list = dialog.querySelector("#user-positions-list");
  const empty = dialog.querySelector("#user-positions-empty");
  const add = dialog.querySelector("#user-positions-add");
  const form = dialog.querySelector("#user-positions-form");
  const back = form.querySelector("#user-positions-back");
  const remove = form.querySelector("#user-positions-delete");
  const feedback = dialog.querySelector("#user-positions-feedback");
  const name = form.elements.namedItem("name");
  const hideArticle = form.elements.namedItem("hideArticle");
  const hideBrand = form.elements.namedItem("hideBrand");
  const showAllOpenRepairs = form.elements.namedItem("showAllOpenRepairs");
  let positions = [];
  let editing;
  let saving = false;

  function fillSelect(select, selected = select.value) {
    select.replaceChildren(new Option("Без должности", ""), ...positions.map((item) => new Option(item.name, item.id)));
    select.value = positions.some((item) => item.id === selected) ? selected : "";
  }

  function updateSummary(summary, positionId) {
    const position = positions.find((item) => item.id === positionId);
    summary.dataset.userPositionSummary = positionId ?? "";
    summary.textContent = position?.name ?? "";
    summary.hidden = !position;
  }

  function setFeedback(message = "", success = false) {
    feedback.textContent = message;
    feedback.dataset.state = success ? "success" : "";
  }

  function showDirectory(focusId) {
    editing = undefined;
    heading.textContent = "Должности";
    directory.hidden = false;
    form.hidden = true;
    const previous = [...list.querySelectorAll("button")].find((button) => button.dataset.positionId === focusId);
    (previous ?? add).focus();
  }

  function showEditor(item) {
    editing = item;
    setFeedback();
    heading.textContent = item ? "Настройки должности" : "Новая должность";
    directory.hidden = true;
    form.hidden = false;
    name.value = item?.name ?? "";
    hideArticle.checked = item?.hideArticle ?? false;
    hideBrand.checked = item?.hideBrand ?? false;
    showAllOpenRepairs.checked = item?.showAllOpenRepairs ?? false;
    remove.hidden = !item;
    name.focus();
  }

  function setPositions(items) {
    positions = [...items].sort((a, b) => nameOrder.compare(a.name, b.name));
    for (const select of document.querySelectorAll("[data-user-position]")) fillSelect(select);
    for (const summary of document.querySelectorAll("[data-user-position-summary]")) {
      updateSummary(summary, summary.dataset.userPositionSummary);
    }
    empty.hidden = positions.length > 0;
    list.replaceChildren(...positions.map((item) => {
      const row = document.createElement("li");
      const info = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = item.name;
      const flags = document.createElement("span");
      flags.className = "panel__meta";
      flags.textContent = [item.showAllOpenRepairs && "Все незавершённые заказ-наряды", item.hideArticle && "Артикул скрыт",
        item.hideBrand && "Бренд скрыт"].filter(Boolean).join(" · ") || "Все поля видны";
      info.append(title, flags);
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "btn btn-light";
      edit.textContent = "Изменить";
      edit.dataset.positionId = item.id;
      edit.setAttribute("aria-label", `Изменить должность ${item.name}`);
      edit.addEventListener("click", () => showEditor(item));
      row.append(info, edit);
      return row;
    }));
  }

  async function savePosition(method, payload) {
    if (saving) return;
    saving = true;
    const buttons = [close, ...form.querySelectorAll("button")];
    buttons.forEach((button) => { button.disabled = true; });
    setFeedback();
    try {
      const response = await fetch(positionsUrl, {
        method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(await messageFor(response, "Не удалось сохранить должность."));
      if (method === "DELETE") {
        setPositions(positions.filter((item) => item.id !== payload.id));
        showDirectory();
        setFeedback("Должность удалена.", true);
      } else {
        const { position } = await response.json();
        if (typeof position?.id !== "string") throw new Error("Сервер не подтвердил сохранение должности.");
        setPositions([...positions.filter((item) => item.id !== position.id), position]);
        showDirectory(position.id);
        setFeedback("Должность сохранена.", true);
      }
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Не удалось сохранить должность.");
    } finally {
      saving = false;
      buttons.forEach((button) => { button.disabled = false; });
    }
  }

  open.addEventListener("click", () => {
    setFeedback();
    dialog.showModal();
    showDirectory();
  });
  close.addEventListener("click", () => { if (!saving) dialog.close(); });
  dialog.addEventListener("cancel", (event) => {
    if (saving) event.preventDefault();
  });
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape" || event.key === "Tab") event.stopPropagation();
  });
  dialog.addEventListener("close", () => { open.focus({ preventScroll: true }); });
  add.addEventListener("click", () => showEditor());
  back.addEventListener("click", () => { setFeedback(); showDirectory(editing?.id); });
  remove.addEventListener("click", () => {
    if (editing && window.confirm(`Удалить должность «${editing.name}»?`)) void savePosition("DELETE", { id: editing.id });
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void savePosition(editing ? "PATCH" : "POST", {
      id: editing?.id, name: name.value, hideArticle: hideArticle.checked, hideBrand: hideBrand.checked,
      showAllOpenRepairs: showAllOpenRepairs.checked,
    });
  });

  return { setPositions, fillSelect, updateSummary };
}
