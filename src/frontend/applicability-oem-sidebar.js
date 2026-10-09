const element = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};

export function bootstrapApplicabilityOemSidebar({ addArticle, notify }) {
  const sidebar = document.querySelector("#applicability-oem-sidebar");
  const workspace = document.querySelector("#applicability-workspace");
  const toggle = document.querySelector("#applicability-oem-toggle");
  const close = document.querySelector("#applicability-oem-close");
  const search = document.querySelector("#applicability-oem-search");
  const includeNotFound = document.querySelector("#applicability-oem-include-not-found");
  const searchForm = document.querySelector("#applicability-oem-search-form");
  const list = document.querySelector("#applicability-oem-articles");
  const more = document.querySelector("#applicability-oem-more");
  const status = document.querySelector("#applicability-oem-status");
  const resize = document.querySelector("#applicability-oem-resize");
  const menu = document.querySelector("#applicability-oem-context-menu");
  const add = document.querySelector("#applicability-oem-add");
  const remove = document.querySelector("#applicability-oem-delete");
  const viewButtons = [...document.querySelectorAll("[data-oem-view]")];
  const widthStorageKey = "autoservice-applicability-oem-width-v1";
  let articles = [];
  let brandCounts = new Map();
  let view = "brand";
  let offset = 0;
  let hasMore = false;
  let loadController = null;
  let searchTimer = null;
  let resizeStart = null;
  let menuArticle = null;
  let menuAnchor = null;
  let deletingArticle = null;
  let deleting = false;
  let addingController = null;

  const identity = ({ sku, brand }) => JSON.stringify([sku, brand]);
  const setStatus = (message) => {
    status.textContent = message;
    status.hidden = !message;
  };
  const hideMenu = (restoreFocus = false) => {
    menu.hidden = true;
    if (restoreFocus && menuAnchor?.isConnected) menuAnchor.focus();
    menuArticle = null;
    menuAnchor = null;
  };
  const setWidth = (value) => {
    const width = Number(value);
    if (!Number.isFinite(width)) return;
    const normalized = Math.min(420, Math.max(180, Math.round(width / 10) * 10));
    sidebar.style.setProperty("--garage-sidebar-width", `${normalized}px`);
    try {
      localStorage.setItem(widthStorageKey, String(normalized));
    } catch {
      // Width is optional; resizing remains available without storage.
    }
  };
  const api = async (path, options = {}) => {
    const response = await fetch(path, { headers: { Accept: "application/json", "Content-Type": "application/json" }, ...options });
    const payload = await response.json();
    if (!response.ok) throw new Error(typeof payload?.message === "string" ? payload.message : "Не удалось прочитать базу OEM-артикулов.");
    return payload;
  };
  const addSavedArticle = async (article) => {
    addingController?.abort();
    const controller = new AbortController();
    addingController = controller;
    try {
      await addArticle(article, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) notify(error instanceof Error ? error.message : "Не удалось добавить OEM-артикул.", "error");
    } finally {
      if (addingController === controller) addingController = null;
    }
  };
  const deleteSavedArticle = async (article) => {
    if (deleting) return;
    deleting = true;
    addingController?.abort();
    loadController?.abort();
    render();
    try {
      const payload = await api("/api/applicability/saved-articles", { method: "DELETE", body: JSON.stringify({ sku: article.sku, brand: article.brand }) });
      if (typeof payload?.deleted !== "boolean") throw new Error("Сервис вернул некорректный ответ.");
      deletingArticle = null;
      notify(payload.deleted ? "OEM-артикул удалён из базы." : "OEM-артикул уже удалён из базы.", "success");
      await load();
    } catch (error) {
      notify(error instanceof Error ? error.message : "Не удалось удалить OEM-артикул.", "error");
    } finally {
      deleting = false;
      render();
    }
  };
  const appendArticle = (parent, article, showBrand = true) => {
    const row = element("li", undefined, "garage-vehicles__item");
    const button = element("button", undefined, "garage-vehicles__button applicability-oem-article");
    button.type = "button";
    button.dataset.oemIdentity = identity(article);
    button.title = `Добавить ${article.sku}, ${article.brand} в активную вкладку`;
    button.classList.toggle("is-not-found", !article.hasResults);
    button.append(element("span", article.sku));
    const meta = element("span", undefined, "applicability-oem-article-meta");
    if (showBrand) meta.append(element("small", article.brand));
    if (!article.hasResults) meta.append(element("small", "не найдено"));
    if (meta.childElementCount) button.append(meta);
    row.append(button);
    if (deletingArticle && identity(deletingArticle) === identity(article)) {
      const confirmation = element("div", undefined, "garage-vehicle-delete");
      confirmation.append(element("span", `Удалить ${article.sku} (${article.brand}) из базы?`));
      const actions = element("div", undefined, "garage-vehicle-delete__actions");
      const confirm = element("button", "Удалить", "btn garage-inline-action garage-vehicle-delete__confirm");
      const cancel = element("button", "Отмена", "btn btn-light garage-inline-action");
      confirm.type = cancel.type = "button";
      confirm.disabled = cancel.disabled = deleting;
      confirm.addEventListener("click", () => { void deleteSavedArticle(article); });
      cancel.addEventListener("click", () => { deletingArticle = null; render(); });
      actions.append(confirm, cancel);
      confirmation.append(actions);
      row.append(confirmation);
    }
    parent.append(row);
  };
  const render = () => {
    const openBrands = new Set([...list.querySelectorAll("details[open]")].map((group) => group.dataset.brand));
    list.replaceChildren();
    if (view === "sku") articles.forEach((article) => appendArticle(list, article));
    else {
      const groups = new Map();
      articles.forEach((article) => {
        if (!groups.has(article.brand)) groups.set(article.brand, []);
        groups.get(article.brand).push(article);
      });
      groups.forEach((entries, brand) => {
        const row = element("li", undefined, "garage-vehicles__item");
        const group = element("details", undefined, "applicability-oem-brand");
        group.dataset.brand = brand;
        group.open = openBrands.has(brand) || Boolean(search.value.trim());
        const summary = element("summary", undefined, "garage-vehicles__button");
        const heading = element("span", undefined, "applicability-oem-brand-heading");
        const counts = brandCounts.get(brand);
        const countText = `${counts.found} найдено${includeNotFound.checked ? ` · ${counts.notFound} не найдено` : ""}`;
        heading.append(element("span", brand), element("small", countText, "applicability-oem-brand-counts"));
        summary.append(heading);
        group.append(summary);
        const children = element("ul", undefined, "garage-vehicles");
        entries.forEach((article) => appendArticle(children, article, false));
        group.append(children);
        row.append(group);
        list.append(row);
      });
    }
    more.hidden = !hasMore;
    more.disabled = Boolean(loadController || deleting);
    search.disabled = deleting;
    includeNotFound.disabled = deleting;
    viewButtons.forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.oemView === view));
      button.disabled = deleting;
    });
  };
  const load = async (append = false) => {
    loadController?.abort();
    const controller = new AbortController();
    loadController = controller;
    if (!append) { articles = []; brandCounts = new Map(); offset = 0; hasMore = false; }
    const query = new URLSearchParams({ search: search.value.trim(), offset: String(offset), order: view, includeNotFound: String(includeNotFound.checked) });
    setStatus("Загружаем OEM-артикулы…");
    render();
    try {
      const payload = await api(`/api/applicability/saved-articles?${query}`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (!Array.isArray(payload?.articles) || payload.articles.length > 100 || typeof payload.hasMore !== "boolean"
        || payload.articles.some((article) => !article || typeof article.sku !== "string" || !article.sku.trim()
          || article.sku.length > 128 || typeof article.brand !== "string" || !article.brand.trim()
          || article.brand.length > 150 || typeof article.hasResults !== "boolean")
        || !Array.isArray(payload.brandCounts) || payload.brandCounts.some((counts) => !counts || typeof counts.brand !== "string"
          || !counts.brand.trim() || counts.brand.length > 150 || !Number.isSafeInteger(counts.found) || counts.found < 0
          || !Number.isSafeInteger(counts.notFound) || counts.notFound < 0)) throw new Error("Сервис вернул некорректный список OEM-артикулов.");
      const nextCounts = new Map(payload.brandCounts.map((counts) => [counts.brand, counts]));
      if (payload.articles.some((article) => !nextCounts.has(article.brand))) throw new Error("Сервис вернул некорректные счётчики OEM-артикулов.");
      brandCounts = append ? new Map([...brandCounts, ...nextCounts]) : nextCounts;
      const existing = new Set(articles.map(identity));
      articles.push(...payload.articles.filter((article) => !existing.has(identity(article))));
      offset += payload.articles.length;
      hasMore = payload.hasMore;
      setStatus(articles.length ? "" : search.value.trim() ? "Ничего не найдено." : includeNotFound.checked
        ? "В базе пока нет сохранённых OEM-артикулов." : "Нет OEM-артикулов с найденной применимостью.");
    } catch (error) {
      if (!controller.signal.aborted) setStatus(error instanceof Error ? error.message : "Не удалось загрузить OEM-артикулы.");
    } finally {
      if (loadController === controller) { loadController = null; render(); }
    }
  };
  const setOpen = (open, restoreFocus = true) => {
    sidebar.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    hideMenu();
    if (open) { if (!deleting) void load(); search.focus(); }
    else {
      loadController?.abort();
      addingController?.abort();
      if (searchTimer !== null) window.clearTimeout(searchTimer);
      searchTimer = null;
      if (restoreFocus) toggle.focus();
    }
  };
  const showMenu = (article, anchor, x, y) => {
    menuArticle = article;
    menuAnchor = anchor;
    menu.hidden = false;
    const bounds = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - bounds.height - 8))}px`;
    add.focus();
  };
  const selectedArticle = (event) => {
    const button = event.target.closest("[data-oem-identity]");
    return { button, article: button && articles.find((article) => identity(article) === button.dataset.oemIdentity) };
  };
  toggle.addEventListener("click", () => setOpen(sidebar.hidden));
  close.addEventListener("click", () => setOpen(false));
  searchForm.addEventListener("submit", (event) => { event.preventDefault(); void load(); });
  includeNotFound.addEventListener("change", () => {
    hideMenu();
    deletingArticle = null;
    void load();
  });
  search.addEventListener("input", () => {
    loadController?.abort();
    if (searchTimer !== null) window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => { searchTimer = null; void load(); }, 250);
  });
  viewButtons.forEach((button) => button.addEventListener("click", () => {
    if (view === button.dataset.oemView) return;
    view = button.dataset.oemView;
    hideMenu();
    deletingArticle = null;
    void load();
  }));
  more.addEventListener("click", () => { void load(true); });
  list.addEventListener("click", (event) => {
    const { article } = selectedArticle(event);
    if (article && !deleting) void addSavedArticle(article);
  });
  list.addEventListener("contextmenu", (event) => {
    const { button, article } = selectedArticle(event);
    if (!article || deleting) return;
    event.preventDefault();
    showMenu(article, button, event.clientX, event.clientY);
  });
  list.addEventListener("keydown", (event) => {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    const { button, article } = selectedArticle(event);
    if (!article || deleting) return;
    event.preventDefault();
    const bounds = button.getBoundingClientRect();
    showMenu(article, button, bounds.left + 16, bounds.top + 16);
  });
  add.addEventListener("click", () => {
    const article = menuArticle;
    hideMenu();
    if (article) void addSavedArticle(article);
  });
  remove.addEventListener("click", () => {
    deletingArticle = menuArticle;
    hideMenu();
    render();
    list.querySelector(".garage-vehicle-delete__confirm")?.focus();
  });
  document.addEventListener("click", (event) => { if (!menu.contains(event.target)) hideMenu(); });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!menu.hidden) { hideMenu(true); event.stopImmediatePropagation(); }
    else if (!sidebar.hidden && sidebar.contains(document.activeElement)) setOpen(false);
  });
  list.addEventListener("scroll", () => hideMenu());
  sidebar.addEventListener("scroll", () => hideMenu());
  window.addEventListener("resize", () => hideMenu(true));
  resize.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    resizeStart = { pointerId: event.pointerId, startX: event.clientX, startWidth: sidebar.getBoundingClientRect().width };
    resize.setPointerCapture(event.pointerId);
  });
  resize.addEventListener("pointermove", (event) => {
    if (!resizeStart || event.pointerId !== resizeStart.pointerId) return;
    const width = resizeStart.startWidth + resizeStart.startX - event.clientX;
    if (width <= workspace.getBoundingClientRect().width * 0.02) {
      resizeStart = null;
      resize.releasePointerCapture(event.pointerId);
      setOpen(false);
    } else setWidth(width);
  });
  const stopResize = () => { resizeStart = null; };
  resize.addEventListener("pointerup", stopResize);
  resize.addEventListener("pointercancel", stopResize);
  resize.addEventListener("lostpointercapture", stopResize);
  resize.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const width = sidebar.getBoundingClientRect().width;
    if (event.key === "ArrowRight" && width <= 180) setOpen(false);
    else setWidth(width + (event.key === "ArrowLeft" ? 10 : -10));
  });
  try {
    setWidth(localStorage.getItem(widthStorageKey) ?? 260);
  } catch {
    setWidth(260);
  }
  return {
    refresh: () => { if (!sidebar.hidden) void load(); },
    hide: () => { if (!sidebar.hidden) setOpen(false, false); },
  };
}
