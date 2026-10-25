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
  wrapper.append(panel);
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", list.id);
  input.setAttribute("aria-expanded", "false");
  let activeIndex = -1;
  let shown = [];

  const close = () => {
    panel.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    activeIndex = -1;
  };
  const save = () => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(entries));
    } catch {
      // Searching remains available if storage is full or disabled.
    }
  };
  save();
  const resizeList = () => {
    if (panel.hidden || !shown.length) return;
    const first = list.firstElementChild;
    const last = list.children[Math.min(10, shown.length) - 1];
    const height = last.getBoundingClientRect().bottom - first.getBoundingClientRect().top;
    const available = Math.max(0, window.innerHeight - list.getBoundingClientRect().top - 16);
    list.style.maxHeight = `${Math.min(height, available)}px`;
  };
  new ResizeObserver(resizeList).observe(list);
  window.addEventListener("resize", resizeList);
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
    list.style.maxHeight = "";
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
    input.setAttribute("aria-expanded", "true");
    list.scrollTop = 0;
    resizeList();
  };
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
