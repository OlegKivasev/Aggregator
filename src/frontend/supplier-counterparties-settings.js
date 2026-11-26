const path = "/api/suppliers/onec-counterparties";
const searchDelay = 250;

async function request(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || "Не удалось получить данные из 1С.");
  return data;
}

const counterpartyLabel = ({ name, taxId }) => taxId ? `${name} · ИНН ${taxId}` : name;

export function bootstrapSupplierCounterpartiesSettings() {
  const panel = document.querySelector("#suppliers-settings");
  const template = panel.querySelector("#supplier-counterparty-template");
  const cards = new Map();
  let mappings = new Map();
  let load;
  let loaded = false;
  let revision = 0;

  const refresh = () => {
    if (loaded) return Promise.resolve();
    if (load) return load;
    const startedAt = revision;
    load = request(path).then((entries) => {
      if (revision === startedAt) {
        mappings = new Map(entries.map((entry) => [entry.supplier, entry]));
        for (const [supplier, card] of cards) card.paint(mappings.get(supplier));
        loaded = true;
      }
    }).finally(() => { load = undefined; });
    return load;
  };

  for (const card of panel.querySelectorAll(":scope > .auth-card[data-supplier]")) {
    const { supplier } = card.dataset;
    const section = template.content.firstElementChild.cloneNode(true);
    card.insertBefore(section, card.querySelector(":scope > details"));
    const input = section.querySelector("input");
    const list = section.querySelector("[role=listbox]");
    const status = section.querySelector("[role=status]");
    const current = section.querySelector(".supplier-counterparty-current");
    const remove = current.querySelector("button");
    list.id = `supplier-${supplier}-counterparties`;
    input.setAttribute("aria-controls", list.id);
    let entries = [];
    let selected = -1;
    let timer;
    let search;
    let saving = false;

    const paint = (mapping) => {
      current.hidden = !mapping;
      current.querySelector("[data-selected]").textContent = mapping ? counterpartyLabel(mapping) : "";
    };
    cards.set(supplier, { paint, close });

    const selectIndex = (index) => {
      if (selected >= 0) list.children[selected].setAttribute("aria-selected", "false");
      selected = index;
      if (index < 0) {
        input.removeAttribute("aria-activedescendant");
        return;
      }
      const option = list.children[index];
      option.setAttribute("aria-selected", "true");
      input.setAttribute("aria-activedescendant", option.id);
      option.scrollIntoView({ block: "nearest" });
    };

    const show = (found) => {
      selectIndex(-1);
      entries = found;
      list.replaceChildren(...found.map((entry, index) => {
        const item = document.createElement("li");
        item.id = `${list.id}-${index}`;
        item.dataset.index = String(index);
        item.setAttribute("role", "option");
        item.setAttribute("aria-selected", "false");
        item.textContent = counterpartyLabel(entry);
        return item;
      }));
      list.hidden = !found.length;
      input.setAttribute("aria-expanded", String(!list.hidden));
    };

    const cancelSearch = () => {
      clearTimeout(timer);
      timer = undefined;
      search?.abort();
      search = undefined;
      show([]);
    };

    function close() {
      cancelSearch();
      input.value = "";
      if (!saving) status.textContent = "";
    }

    async function save(id) {
      if (saving) return;
      cancelSearch();
      saving = true;
      input.readOnly = true;
      remove.disabled = true;
      status.textContent = "Сохраняем…";
      try {
        const saved = await request(path, {
          method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ supplier, id }),
        });
        const mapping = saved.find((entry) => entry.supplier === supplier);
        if (mapping) mappings.set(supplier, mapping);
        else mappings.delete(supplier);
        revision++;
        paint(mapping);
        input.value = "";
        status.textContent = id ? "Контрагент сохранён." : "Сопоставление удалено.";
      } catch (error) {
        status.textContent = error.message;
      } finally {
        saving = input.readOnly = remove.disabled = false;
      }
    }

    const scheduleSearch = () => {
      cancelSearch();
      const query = input.value.trim();
      status.textContent = "";
      if (!query || saving) return;
      timer = setTimeout(async () => {
        timer = undefined;
        const controller = new AbortController();
        search = controller;
        status.textContent = "Ищем в 1С…";
        try {
          const found = await request(`${path}/search?${new URLSearchParams({ q: query })}`, { signal: controller.signal });
          if (controller.signal.aborted) return;
          show(found);
          status.textContent = found.length === 0 ? "Поставщики не найдены." : found.length === 50 ? "Уточните название или ИНН." : "";
        } catch (error) {
          if (!controller.signal.aborted) status.textContent = error.message;
        } finally {
          if (search === controller) search = undefined;
        }
      }, searchDelay);
    };

    input.addEventListener("input", (event) => { if (!event.isComposing) scheduleSearch(); });
    input.addEventListener("compositionstart", cancelSearch);
    input.addEventListener("compositionend", scheduleSearch);
    input.addEventListener("keydown", (event) => {
      if (event.isComposing) return;
      if (event.key === "Escape" && (entries.length || search || timer)) {
        event.preventDefault();
        event.stopPropagation();
        cancelSearch();
        status.textContent = "";
        return;
      }
      if (!entries.length) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const next = event.key === "ArrowDown" ? selected + 1 : selected < 0 ? entries.length - 1 : selected - 1;
        selectIndex((next + entries.length) % entries.length);
      } else if (event.key === "Enter" && selected >= 0) {
        event.preventDefault();
        void save(entries[selected].id);
      }
    });
    list.addEventListener("click", (event) => {
      const option = event.target.closest("[role=option]");
      if (option) void save(entries[Number(option.dataset.index)].id);
    });
    remove.addEventListener("click", () => void save(null));
    section.addEventListener("toggle", () => {
      if (!section.open) { close(); return; }
      paint(mappings.get(supplier));
      void refresh().catch((error) => { if (section.open && !search && !saving) status.textContent = error.message; });
    });
  }

  const close = () => {
    loaded = false;
    for (const card of cards.values()) card.close();
  };
  panel.addEventListener("toggle", () => { if (!panel.open) close(); });
  return { close, refresh: () => { if (panel.open && panel.querySelector(".supplier-counterparty-settings[open]")) void refresh().catch(() => {}); } };
}
