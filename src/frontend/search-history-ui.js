import { addSearchHistoryEntry, normalizeSearchHistory, searchHistoryStorageKeys } from "./search-history.js";

export function setupSearchHistory({ input, form, kind, onSelect }) {
  const storageKey = searchHistoryStorageKeys[kind];
  let entries = [];
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored && stored.length <= 2_000_000) entries = normalizeSearchHistory(JSON.parse(stored), kind);
  } catch {
    // History is optional when browser storage is unavailable or corrupt.
  }
  const wrapper = document.createElement("div");
  wrapper.className = "search-history";
  input.before(wrapper);
  wrapper.append(input);
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "search-history__toggle";
  toggle.title = "История поиска";
  toggle.setAttribute("aria-label", "История поиска");
  toggle.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3 10a9 9 0 1 1 2 8M3 4v6h6M12 7v5l3 2"/></svg>';
  const panel = document.createElement("div");
  panel.className = "search-history__panel";
  panel.id = `${input.id}-history`;
  panel.hidden = true;
  const header = document.createElement("div");
  header.className = "search-history__header";
  const title = document.createElement("span");
  title.textContent = "История поиска";
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "search-history__clear";
  clear.textContent = "Очистить";
  clear.setAttribute("aria-label", "Очистить историю поиска");
  header.append(title, clear);
  const list = document.createElement("div");
  list.className = "search-history__list";
  list.id = `${input.id}-history-list`;
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "История поиска");
  panel.append(header, list);
  wrapper.append(toggle, panel);
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", list.id);
  toggle.setAttribute("aria-controls", panel.id);
  toggle.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-expanded", "false");
  let activeIndex = -1;
  let shown = [];

  const close = () => {
    panel.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    toggle.setAttribute("aria-expanded", "false");
    activeIndex = -1;
  };
  const save = () => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(entries));
    } catch {
      // Searching remains available if storage is full or disabled.
    }
  };
  const select = (entry) => {
    close();
    input.value = entry.query;
    onSelect?.(entry);
    input.focus();
    close();
  };
  const open = (filter = "") => {
    if (input.disabled) return;
    const query = filter.trim().toLocaleUpperCase();
    shown = entries.filter((entry) => `${entry.query} ${entry.brands.join(" ")}`.toLocaleUpperCase().includes(query));
    list.replaceChildren();
    activeIndex = -1;
    input.removeAttribute("aria-activedescendant");
    shown.forEach((entry, index) => {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "search-history__option";
      option.id = `${list.id}-${index}`;
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", "false");
      option.tabIndex = -1;
      const label = document.createElement("span");
      label.textContent = entry.query;
      option.append(label);
      if (entry.brands.length) {
        const brands = document.createElement("small");
        brands.textContent = entry.brands.join(", ");
        option.append(brands);
      }
      option.addEventListener("click", () => select(entry));
      list.append(option);
    });
    if (!shown.length) {
      const empty = document.createElement("p");
      empty.className = "search-history__empty";
      empty.textContent = entries.length ? "Совпадений нет" : "История пока пуста";
      list.append(empty);
    }
    clear.disabled = !entries.length;
    panel.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
    input.setAttribute("aria-expanded", "true");
  };
  toggle.addEventListener("click", () => {
    if (!panel.hidden) return close();
    input.focus();
    open();
  });
  clear.addEventListener("click", () => {
    entries = [];
    save();
    input.focus();
    open();
  });
  input.addEventListener("focus", () => { if (entries.length) open(); });
  input.addEventListener("input", () => { if (entries.length || !panel.hidden) open(input.value); });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !panel.hidden) {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (["ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      if (panel.hidden) open();
      if (!shown.length) return;
      activeIndex = (activeIndex + (event.key === "ArrowDown" ? 1 : activeIndex < 0 ? 0 : -1) + shown.length) % shown.length;
      [...list.children].forEach((option, index) => option.setAttribute("aria-selected", String(index === activeIndex)));
      const active = list.children[activeIndex];
      input.setAttribute("aria-activedescendant", active.id);
      active.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter" && !panel.hidden && activeIndex >= 0) {
      event.preventDefault();
      select(shown[activeIndex]);
    }
  });
  wrapper.addEventListener("focusout", (event) => { if (!wrapper.contains(event.relatedTarget)) close(); });
  document.addEventListener("pointerdown", (event) => { if (!wrapper.contains(event.target)) close(); });
  form.addEventListener("submit", close);
  return {
    record(entry) {
      entries = addSearchHistoryEntry(entries, entry, kind);
      save();
      close();
    },
  };
}
