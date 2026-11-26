const path = "/api/suppliers/onec-counterparties";
const suppliers = { armtek: "Armtek", "part-kom": "PartKOM", "forum-auto": "Forum Auto", rossko: "Rossko", autopiter: "Автопитер" };

async function request(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || "Не удалось получить данные из 1С.");
  return data;
}

export function bootstrapSupplierCounterpartiesSettings() {
  const panel = document.querySelector("#supplier-counterparties-settings");
  const rows = panel.querySelector("[data-mappings]");
  const form = panel.querySelector("[data-counterparty-search]");
  const results = panel.querySelector("[data-counterparty-results]");
  const status = panel.querySelector("[data-counterparty-status]");
  let supplier;
  let searching;
  let saving = false;

  const button = (label, onClick) => {
    const element = document.createElement("button");
    element.className = "btn btn-light";
    element.type = "button";
    element.textContent = label;
    element.addEventListener("click", onClick);
    return element;
  };
  const render = (mappings) => {
    const entries = new Map(mappings.map((mapping) => [mapping.supplier, mapping]));
    rows.replaceChildren(...Object.entries(suppliers).map(([id, name]) => {
      const row = document.createElement("div");
      row.className = "supplier-counterparty-row";
      const label = document.createElement("strong");
      label.textContent = name;
      const description = document.createElement("span");
      const entry = entries.get(id);
      description.textContent = entry ? `${entry.name}${entry.taxId ? ` · ${entry.taxId}` : ""}` : "Контрагент не выбран";
      const choose = button(entry ? "Изменить" : "Выбрать", () => {
        supplier = id;
        searching?.abort();
        results.replaceChildren();
        status.textContent = "";
        form.hidden = false;
        form.querySelector("[data-counterparty-search-label]").textContent = `Контрагент ${name}`;
        form.elements.query.value = "";
        form.elements.query.focus();
      });
      choose.setAttribute("aria-label", `${choose.textContent} контрагента ${name}`);
      row.append(label, description, choose);
      if (entry) {
        const remove = button("Убрать", () => void save(id, null));
        remove.setAttribute("aria-label", `Убрать контрагента ${name}`);
        row.append(remove);
      }
      return row;
    }));
  };

  async function save(supplierId, id) {
    if (saving) return;
    saving = true;
    status.textContent = "Сохраняем…";
    try {
      render(await request(path, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ supplier: supplierId, id }) }));
      if (supplier === supplierId) {
        searching?.abort();
        supplier = undefined;
        form.hidden = true;
        results.replaceChildren();
      }
      status.textContent = id ? "Контрагент сохранён для всех пользователей." : "Сопоставление удалено для всех пользователей.";
    } catch (error) { status.textContent = error.message; }
    finally { saving = false; }
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const target = supplier;
    if (!target || saving) return;
    searching?.abort();
    const controller = new AbortController();
    searching = controller;
    status.textContent = "Ищем в 1С…";
    results.replaceChildren();
    try {
      const query = new URLSearchParams({ q: form.elements.query.value.trim() });
      const found = await request(`${path}/search?${query}`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      results.replaceChildren(...found.map(({ id, name, taxId }) => {
        const row = document.createElement("div");
        row.className = "supplier-counterparty-row";
        const label = document.createElement("span");
        label.textContent = `${name}${taxId ? ` · ${taxId}` : ""}`;
        const choose = button("Сохранить", () => void save(target, id));
        choose.setAttribute("aria-label", `Сохранить ${name} для ${suppliers[target]}`);
        row.append(label, choose);
        return row;
      }));
      status.textContent = found.length === 0 ? "В 1С не найдено поставщиков. Уточните название или ИНН."
        : found.length === 50 ? "Показаны первые 50 поставщиков. Уточните название или ИНН." : "";
    } catch (error) { if (!controller.signal.aborted) status.textContent = error.message; }
  });

  panel.addEventListener("toggle", async () => {
    if (!panel.open) { searching?.abort(); return; }
    status.textContent = "Загружаем настройки…";
    try { render(await request(path)); status.textContent = ""; }
    catch (error) { status.textContent = error.message; }
  });
}
