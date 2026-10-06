const markupFunction = document.querySelector("#markup-function");
const applicabilityFunction = document.querySelector("#applicability-function");
const markupTab = document.querySelector("#markup-function-tab");
const applicabilityTab = document.querySelector("#applicability-function-tab");
const applicabilityTabsList = document.querySelector("#applicability-tabs-list");
const newApplicabilityTabButton = document.querySelector("#applicability-new-tab");
const form = document.querySelector("#applicability-search-form");
const skuInput = document.querySelector("#applicability-sku");
const makeInput = document.querySelector("#applicability-make");
const makesMenu = document.querySelector("#applicability-makes");
const apiKeyInput = document.querySelector("#applicability-api-key");
const settingsDrawer = document.querySelector("#applicability-settings-drawer");
const settingsToggle = document.querySelector("#applicability-settings-toggle");
const settingsClose = document.querySelector("#applicability-settings-close");
const settingsBackdrop = document.querySelector("#applicability-settings-backdrop");
const apiKeyStatus = document.querySelector("#applicability-api-key-status");
const deleteApiKeyButton = document.querySelector("#applicability-api-key-delete");
const tabContextMenu = document.querySelector("#applicability-tab-context-menu");
const renameTabButton = document.querySelector("#applicability-rename-tab-button");
const resultContextMenu = document.querySelector("#applicability-result-context-menu");
const deleteResultButton = document.querySelector("#applicability-result-delete-button");
const submitButton = document.querySelector("#applicability-submit");
const feedback = document.querySelector("#applicability-feedback");
const resultsBody = document.querySelector("#applicability-results-body");
const listButton = document.querySelector("#applicability-list-button");
const documentModal = document.querySelector("#applicability-document-modal");
const documentText = document.querySelector("#applicability-document-text");
const closeDocumentButtons = [...document.querySelectorAll("[data-close-applicability-document]")];
const documentFormatButtons = [...document.querySelectorAll("[data-applicability-document-format]")];

let makesByName = new Map();
let tabs = [];
let activeTabId = null;
let tabSequence = 1;
let activeRequest = null;
let hasStoredApiKey = false;
let activeMakeIndex = -1;
let contextMenuTabId = null;
let contextMenuTabAnchor = null;
let contextMenuEntryId = null;
let contextMenuEntryAnchor = null;
let documentModalReturnFocus = null;
let documentFormat = "raw";
let documentEntries = [];

const applicabilityStateStorageKey = "autoservice.applicabilityState";
const activeFunctionStorageKey = "autoservice.activeFunction";

const createSearchEntry = (data = {}) => ({
  id: data.id ?? `applicability-search-${Date.now()}-${tabSequence++}`,
  sku: typeof data.sku === "string" ? data.sku : "",
  makeName: typeof data.makeName === "string" ? data.makeName : "",
  results: Array.isArray(data.results) ? data.results : [],
  status: typeof data.status === "string" ? data.status : "",
  hasSearched: Boolean(data.hasSearched),
  expanded: Boolean(data.expanded),
});

const createTab = (data = {}) => ({
  id: data.id ?? `applicability-tab-${Date.now()}-${tabSequence++}`,
  name: typeof data.name === "string" ? data.name.replace(/\s+/g, " ").trim().slice(0, 100) : "",
  sku: typeof data.sku === "string" ? data.sku : "",
  makeName: typeof data.makeName === "string" ? data.makeName : "",
  makeId: Number.isSafeInteger(data.makeId) ? data.makeId : null,
  searches: Array.isArray(data.searches) ? data.searches.map(createSearchEntry) : [],
});

const getActiveTab = () => tabs.find((tab) => tab.id === activeTabId);

const setActiveFunction = (name) => {
  const isApplicability = name === "applicability";
  markupFunction.hidden = isApplicability;
  applicabilityFunction.hidden = !isApplicability;
  markupTab.classList.toggle("active", !isApplicability);
  applicabilityTab.classList.toggle("active", isApplicability);
  markupTab.setAttribute("aria-selected", String(!isApplicability));
  applicabilityTab.setAttribute("aria-selected", String(isApplicability));
  try {
    localStorage.setItem(activeFunctionStorageKey, name);
  } catch {
    // The selected function is a convenience preference.
  }
  if (isApplicability) {
    renderActiveTab();
    skuInput.focus();
  }
};

const setFeedback = (message, tone = "error") => {
  feedback.textContent = message;
  feedback.dataset.tone = tone;
  feedback.hidden = !message;
};

const normalizeTabName = (value) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 100) : "");

const saveApplicabilityState = () => {
  try {
    syncActiveTab();
    localStorage.setItem(applicabilityStateStorageKey, JSON.stringify({
      activeTabId,
      tabs: tabs.map((tab) => ({
        id: tab.id,
        name: tab.name,
        sku: tab.sku,
        makeName: tab.makeName,
        makeId: tab.makeId,
        searches: tab.searches.map((entry) => ({
          id: entry.id,
          sku: entry.sku,
          makeName: entry.makeName,
          results: entry.results,
          status: entry.status,
          hasSearched: entry.hasSearched,
          expanded: entry.expanded,
        })),
      })),
    }));
  } catch {
    // Search state is a convenience cache; the app should keep working if storage is unavailable.
  }
};

const restoreApplicabilityState = () => {
  try {
    const rawState = localStorage.getItem(applicabilityStateStorageKey);
    if (!rawState) return;
    const state = JSON.parse(rawState);
    if (!Array.isArray(state?.tabs) || !state.tabs.length) return;
    tabs = state.tabs.map((tab) => createTab(tab));
    activeTabId = tabs.some((tab) => tab.id === state.activeTabId) ? state.activeTabId : tabs[0].id;
  } catch {
    localStorage.removeItem(applicabilityStateStorageKey);
  }
};

const setApiKeyStatus = (message, configured) => {
  apiKeyStatus.textContent = message;
  apiKeyStatus.hidden = !message;
  deleteApiKeyButton.hidden = !configured;
  hasStoredApiKey = configured;
};

const readApiKeyState = async (response) => {
  const payload = await response.json();
  if (!response.ok || typeof payload?.configured !== "boolean") {
    throw new Error(typeof payload?.message === "string" ? payload.message : "Не удалось сохранить API-ключ.");
  }
  return payload;
};

const saveApiKey = async () => {
  const apiKey = apiKeyInput.value.trim();
  if (!apiKey) {
    throw new Error("Укажите API-ключ PartsAPI.");
  }
  const state = await readApiKeyState(await fetch("/api/applicability/api-key", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ apiKey }),
  }));
  setApiKeyStatus("Ключ сохранён", state.configured);
  return state;
};

const loadApiKeyState = async () => {
  try {
    const state = await readApiKeyState(await fetch("/api/applicability/api-key", { headers: { Accept: "application/json" } }));
    setApiKeyStatus(state.configured ? "Ключ сохранён" : "", state.configured);
  } catch {
    setFeedback("Не удалось проверить настройки API-ключа.");
  }
};

const selectedMake = () => makesByName.get(makeInput.value.trim().toLocaleUpperCase()) ?? null;

const matchingMakes = () => {
  const query = makeInput.value.trim().toLocaleUpperCase();
  return [...makesByName.values()]
    .filter((make) => !query || make.name.toLocaleUpperCase().includes(query))
    .slice(0, 80);
};

const closeMakeMenu = () => {
  makesMenu.hidden = true;
  makeInput.setAttribute("aria-expanded", "false");
  makeInput.removeAttribute("aria-activedescendant");
  activeMakeIndex = -1;
};

const selectMake = (make) => {
  makeInput.value = make.name;
  makeInput.dataset.makeId = String(make.id);
  closeMakeMenu();
  syncActiveTab();
  saveApplicabilityState();
};

const renderMakeMenu = () => {
  const matches = matchingMakes();
  makesMenu.replaceChildren();
  if (!matches.length) {
    const empty = document.createElement("span");
    empty.className = "applicability-make-empty";
    empty.textContent = "Бренд не найден";
    makesMenu.append(empty);
  } else {
    matches.forEach((make, index) => {
      const option = document.createElement("button");
      option.type = "button";
      option.id = `applicability-make-${index}`;
      option.className = `applicability-make-option${index === activeMakeIndex ? " is-active" : ""}`;
      option.dataset.makeName = make.name;
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", String(index === activeMakeIndex));
      option.textContent = make.name;
      makesMenu.append(option);
    });
  }
  makesMenu.hidden = false;
  makeInput.setAttribute("aria-expanded", "true");
  if (activeMakeIndex >= 0 && matches[activeMakeIndex]) {
    makeInput.setAttribute("aria-activedescendant", `applicability-make-${activeMakeIndex}`);
  } else {
    makeInput.removeAttribute("aria-activedescendant");
  }
};

const appendCell = (row, text) => {
  const cell = document.createElement("td");
  cell.textContent = text;
  row.append(cell);
};

const successfulSearches = (tab) => tab.searches.filter((entry) => entry.hasSearched && entry.results.length);

const textValue = (value) => typeof value === "string" && value.trim() ? value.trim() : "—";

const formatVehicleSummary = (vehicle) => {
  const record = vehicle && typeof vehicle === "object" && !Array.isArray(vehicle) ? vehicle : {};
  return [
    textValue(record.makeName),
    textValue(record.modelName),
    `${textValue(record.yearStart)} — ${textValue(record.yearEnd)}`,
    textValue(record.carName),
  ].join(", ");
};

const buildApplicabilityDocument = (entries, format = documentFormat) => entries
  .map((entry) => {
    const contents = format === "summary"
      ? entry.results.map(formatVehicleSummary).join("\n")
      : JSON.stringify(entry.results, null, 2);
    return `Артикул: ${entry.sku}\n${contents}`;
  })
  .join("\n\n");

const renderApplicabilityDocument = () => {
  documentText.value = buildApplicabilityDocument(documentEntries);
  documentFormatButtons.forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.applicabilityDocumentFormat === documentFormat));
  });
};

const updateListButton = (tab) => {
  const hasResults = successfulSearches(tab).length > 0;
  listButton.disabled = !hasResults;
  listButton.title = hasResults ? "Сформировать список найденной применимости" : "Нет найденной применимости для списка";
};

const renderResults = (tab) => {
  resultsBody.replaceChildren();
  updateListButton(tab);
  if (!tab.searches.length) return;
  tab.searches.forEach((entry) => {
    const row = document.createElement("tr");
    if (!entry.hasSearched) {
      row.className = "applicability-searching-row";
      row.dataset.applicabilityEntryId = entry.id;
      appendCell(row, entry.sku);
      appendCell(row, entry.makeName);
      appendCell(row, entry.status || "Ищем…");
      resultsBody.append(row);
      return;
    }
    if (!entry.results.length) {
      row.className = "applicability-no-results";
      row.dataset.applicabilityEntryId = entry.id;
      appendCell(row, entry.sku);
      appendCell(row, entry.makeName);
      appendCell(row, "Не найдено");
      resultsBody.append(row);
      return;
    }
    row.className = "applicability-summary-row";
    row.dataset.applicabilityEntryId = entry.id;
    const articleCell = document.createElement("td");
    const expandButton = document.createElement("button");
    expandButton.type = "button";
    expandButton.className = "applicability-expand";
    expandButton.dataset.expandEntryId = entry.id;
    expandButton.setAttribute("aria-expanded", String(entry.expanded));
    expandButton.setAttribute("aria-label", entry.expanded ? "Скрыть исходный ответ" : "Показать исходный ответ");
    const arrow = document.createElement("span");
    arrow.className = "applicability-expand__arrow";
    arrow.setAttribute("aria-hidden", "true");
    arrow.textContent = "▸";
    const article = document.createElement("span");
    article.textContent = entry.sku;
    expandButton.append(arrow, article);
    articleCell.append(expandButton);
    row.append(articleCell);
    appendCell(row, entry.makeName);
    appendCell(row, String(entry.results.length));
    resultsBody.append(row);

    if (entry.expanded) {
      const rawRow = document.createElement("tr");
      rawRow.className = "applicability-raw-row";
      rawRow.dataset.applicabilityEntryId = entry.id;
      const rawCell = document.createElement("td");
      rawCell.colSpan = 3;
      const raw = document.createElement("pre");
      raw.className = "applicability-raw";
      raw.textContent = JSON.stringify(entry.results, null, 2);
      rawCell.append(raw);
      rawRow.append(rawCell);
      resultsBody.append(rawRow);
    }
  });
};

const closeDocumentModal = (restoreFocus = true) => {
  documentModal.hidden = true;
  if (restoreFocus && documentModalReturnFocus?.isConnected) documentModalReturnFocus.focus();
  documentModalReturnFocus = null;
};

const openDocumentModal = () => {
  const tab = getActiveTab();
  if (!tab) return;
  documentEntries = successfulSearches(tab);
  if (!documentEntries.length) return;
  documentModalReturnFocus = document.activeElement;
  renderApplicabilityDocument();
  documentModal.hidden = false;
  documentText.focus();
  documentText.select();
};

const renderTabs = () => {
  applicabilityTabsList.replaceChildren();
  tabs.forEach((tab, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `search-tab${tab.id === activeTabId ? " active" : ""}`;
    button.dataset.tabId = tab.id;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(tab.id === activeTabId));
    const status = document.createElement("span");
    const isCompleted = tab.searches.some((entry) => entry.hasSearched && entry.results.length);
    status.className = `search-tab__status${isCompleted ? " is-completed" : ""}`;
    status.setAttribute("aria-hidden", "true");
    const title = document.createElement("span");
    title.className = "search-tab__title";
    const tabTitle = tab.name || tab.sku || `Новая применимость ${index + 1}`;
    title.textContent = tabTitle;
    button.title = tabTitle;
    button.setAttribute("aria-label", tabTitle);
    const close = document.createElement("span");
    close.className = "search-tab__close";
    close.dataset.closeTabId = tab.id;
    close.setAttribute("aria-label", "Закрыть вкладку");
    close.textContent = "×";
    button.append(status, title, close);
    applicabilityTabsList.append(button);
  });
};

const syncActiveTab = () => {
  const tab = getActiveTab();
  if (!tab) return;
  tab.sku = skuInput.value.trim();
  tab.makeName = makeInput.value.trim();
  tab.makeId = selectedMake()?.id ?? null;
};

const renderActiveTab = () => {
  const tab = getActiveTab();
  if (!tab) return;
  skuInput.value = tab.sku;
  makeInput.value = tab.makeName;
  makeInput.dataset.makeId = tab.makeId ? String(tab.makeId) : "";
  setFeedback("");
  renderResults(tab);
  renderTabs();
};

const activateTab = (tabId) => {
  if (!tabs.some((tab) => tab.id === tabId) || tabId === activeTabId) return;
  syncActiveTab();
  activeTabId = tabId;
  renderActiveTab();
  saveApplicabilityState();
};

const addTab = () => {
  syncActiveTab();
  const tab = createTab();
  tabs.push(tab);
  activeTabId = tab.id;
  renderActiveTab();
  saveApplicabilityState();
  skuInput.focus();
};

const closeTab = (tabId) => {
  const index = tabs.findIndex((tab) => tab.id === tabId);
  if (index < 0) return;
  if (activeTabId === tabId) activeRequest?.abort();
  tabs.splice(index, 1);
  if (!tabs.length) tabs.push(createTab());
  if (!tabs.some((tab) => tab.id === activeTabId)) activeTabId = tabs[Math.min(index, tabs.length - 1)].id;
  renderActiveTab();
  saveApplicabilityState();
};

const loadMakes = async () => {
  try {
    const response = await fetch("/applicability-makes.json", { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error("Make list could not be loaded");
    const payload = await response.json();
    if (!Array.isArray(payload)) throw new Error("Make list is invalid");
    const makes = new Map();
    payload.forEach((make) => {
      if (!make || typeof make.makeId !== "number" || !Number.isSafeInteger(make.makeId) || typeof make.makeName !== "string" || !make.makeName.trim()) return;
      const name = make.makeName.trim();
      makes.set(name.toLocaleUpperCase(), { id: make.makeId, name });
    });
    if (!makes.size) throw new Error("Make list is empty");
    makesByName = makes;
  } catch {
    setFeedback("Не удалось загрузить список брендов. Обновите страницу и повторите попытку.");
  }
};

markupTab.addEventListener("click", () => setActiveFunction("markup"));
applicabilityTab.addEventListener("click", () => setActiveFunction("applicability"));
newApplicabilityTabButton.addEventListener("click", addTab);
listButton.addEventListener("click", openDocumentModal);
closeDocumentButtons.forEach((button) => button.addEventListener("click", () => closeDocumentModal()));
documentFormatButtons.forEach((button) => button.addEventListener("click", () => {
  const format = button.dataset.applicabilityDocumentFormat;
  if (format !== "raw" && format !== "summary") return;
  documentFormat = format;
  renderApplicabilityDocument();
  documentText.focus();
  documentText.select();
}));
settingsToggle.addEventListener("click", () => {
  settingsDrawer.hidden = false;
  apiKeyInput.focus();
});
settingsClose.addEventListener("click", () => { settingsDrawer.hidden = true; });
settingsBackdrop.addEventListener("click", () => { settingsDrawer.hidden = true; });
apiKeyInput.addEventListener("input", () => {
  apiKeyStatus.hidden = true;
});
apiKeyInput.addEventListener("keydown", async (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  try {
    await saveApiKey();
  } catch (error) {
    setApiKeyStatus(error instanceof Error ? error.message : "Не удалось сохранить API-ключ.", hasStoredApiKey);
  }
});
deleteApiKeyButton.addEventListener("click", async () => {
  try {
    const state = await readApiKeyState(await fetch("/api/applicability/api-key", {
      method: "DELETE",
      headers: { Accept: "application/json" },
    }));
    apiKeyInput.value = "";
    setApiKeyStatus(state.configured ? "Ключ сохранён" : "Ключ удалён", state.configured);
  } catch (error) {
    setApiKeyStatus(error instanceof Error ? error.message : "Не удалось удалить API-ключ.", hasStoredApiKey);
  }
});

applicabilityTabsList.addEventListener("click", (event) => {
  const close = event.target.closest("[data-close-tab-id]");
  if (close) {
    event.stopPropagation();
    closeTab(close.dataset.closeTabId);
    return;
  }
  const tab = event.target.closest("[data-tab-id]");
  if (tab) activateTab(tab.dataset.tabId);
});

const hideTabContextMenu = (restoreFocus = false) => {
  tabContextMenu.hidden = true;
  contextMenuTabId = null;
  if (restoreFocus && contextMenuTabAnchor?.isConnected) contextMenuTabAnchor.focus();
  contextMenuTabAnchor = null;
};

const showTabContextMenu = (tabId, clientX, clientY, anchor) => {
  contextMenuTabId = tabId;
  contextMenuTabAnchor = anchor;
  tabContextMenu.hidden = false;
  const bounds = tabContextMenu.getBoundingClientRect();
  tabContextMenu.style.left = `${Math.max(8, Math.min(clientX, window.innerWidth - bounds.width - 8))}px`;
  tabContextMenu.style.top = `${Math.max(8, Math.min(clientY, window.innerHeight - bounds.height - 8))}px`;
  renameTabButton.focus();
};

const renameTab = (tabId) => {
  const tab = tabs.find((item) => item.id === tabId);
  if (!tab) return;
  const index = tabs.indexOf(tab);
  const defaultName = tab.sku || `Новая применимость ${index + 1}`;
  const name = window.prompt("Введите название вкладки", tab.name || defaultName);
  if (name === null) return;
  tab.name = normalizeTabName(name);
  renderTabs();
  saveApplicabilityState();
};

applicabilityTabsList.addEventListener("contextmenu", (event) => {
  const tab = event.target.closest("[data-tab-id]");
  if (!tab) return;
  event.preventDefault();
  showTabContextMenu(tab.dataset.tabId, event.clientX, event.clientY, tab);
});

applicabilityTabsList.addEventListener("keydown", (event) => {
  if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
  const tab = event.target.closest("[data-tab-id]");
  if (!tab) return;
  event.preventDefault();
  const bounds = tab.getBoundingClientRect();
  showTabContextMenu(tab.dataset.tabId, bounds.left + 16, bounds.top + 16, tab);
});

renameTabButton.addEventListener("click", () => {
  const tabId = contextMenuTabId;
  hideTabContextMenu();
  if (tabId) renameTab(tabId);
});

const hideResultContextMenu = (restoreFocus = false) => {
  resultContextMenu.hidden = true;
  contextMenuEntryId = null;
  if (restoreFocus && contextMenuEntryAnchor?.isConnected) contextMenuEntryAnchor.focus();
  contextMenuEntryAnchor = null;
};

const showResultContextMenu = (entryId, clientX, clientY, anchor) => {
  contextMenuEntryId = entryId;
  contextMenuEntryAnchor = anchor;
  resultContextMenu.hidden = false;
  const bounds = resultContextMenu.getBoundingClientRect();
  resultContextMenu.style.left = `${Math.max(8, Math.min(clientX, window.innerWidth - bounds.width - 8))}px`;
  resultContextMenu.style.top = `${Math.max(8, Math.min(clientY, window.innerHeight - bounds.height - 8))}px`;
  deleteResultButton.focus();
};

resultsBody.addEventListener("contextmenu", (event) => {
  const row = event.target.closest("[data-applicability-entry-id]");
  if (!row) return;
  event.preventDefault();
  showResultContextMenu(row.dataset.applicabilityEntryId, event.clientX, event.clientY, row);
});

deleteResultButton.addEventListener("click", () => {
  const tab = getActiveTab();
  const entryId = contextMenuEntryId;
  hideResultContextMenu();
  if (!tab || !entryId) return;
  tab.searches = tab.searches.filter((entry) => entry.id !== entryId);
  renderResults(tab);
  saveApplicabilityState();
});

resultsBody.addEventListener("click", (event) => {
  const expandButton = event.target.closest("[data-expand-entry-id]");
  if (!expandButton) return;
  const tab = getActiveTab();
  const entry = tab?.searches.find((item) => item.id === expandButton.dataset.expandEntryId);
  if (!tab || !entry || !entry.results.length) return;
  entry.expanded = !entry.expanded;
  renderResults(tab);
  saveApplicabilityState();
});

skuInput.addEventListener("input", () => {
  syncActiveTab();
  saveApplicabilityState();
});
makeInput.addEventListener("input", () => {
  const make = selectedMake();
  makeInput.dataset.makeId = make?.id ? String(make.id) : "";
  activeMakeIndex = -1;
  renderMakeMenu();
  syncActiveTab();
  saveApplicabilityState();
});
makeInput.addEventListener("focus", () => {
  activeMakeIndex = -1;
  renderMakeMenu();
});
makeInput.addEventListener("keydown", (event) => {
  const matches = matchingMakes();
  if (event.key === "Escape") {
    closeMakeMenu();
    return;
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    activeMakeIndex = matches.length ? (activeMakeIndex + 1) % matches.length : -1;
    renderMakeMenu();
    return;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    activeMakeIndex = matches.length ? (activeMakeIndex - 1 + matches.length) % matches.length : -1;
    renderMakeMenu();
    return;
  }
  if (event.key === "Enter" && !makesMenu.hidden && matches[activeMakeIndex]) {
    event.preventDefault();
    selectMake(matches[activeMakeIndex]);
  }
});
makesMenu.addEventListener("click", (event) => {
  const option = event.target.closest("[data-make-name]");
  if (!option) return;
  const make = makesByName.get(option.dataset.makeName.toLocaleUpperCase());
  if (make) selectMake(make);
});
document.addEventListener("click", (event) => {
  if (!event.target.closest(".applicability-make-picker")) closeMakeMenu();
  if (!tabContextMenu.hidden && !tabContextMenu.contains(event.target)) hideTabContextMenu();
  if (!resultContextMenu.hidden && !resultContextMenu.contains(event.target)) hideResultContextMenu();
});
document.addEventListener("keydown", (event) => {
  if (!documentModal.hidden && event.key === "Tab") {
    const focusable = [...documentModal.querySelectorAll("button:not([disabled]), textarea:not([disabled]), [tabindex='0']")]
      .filter((element) => element.offsetParent !== null);
    if (!focusable.length) {
      event.preventDefault();
      documentModal.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement === documentModal)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
    return;
  }
  if (event.key !== "Escape") return;
  if (!documentModal.hidden) {
    closeDocumentModal();
    return;
  }
  if (!tabContextMenu.hidden) hideTabContextMenu(true);
  if (!resultContextMenu.hidden) hideResultContextMenu(true);
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const tab = getActiveTab();
  if (!tab) return;
  syncActiveTab();
  const sku = tab.sku;
  const make = selectedMake();
  if (!sku) return;
  if (!make) {
    setFeedback("Выберите марку из списка.");
    makeInput.focus();
    return;
  }
  if (apiKeyInput.value.trim()) {
    try {
      await saveApiKey();
    } catch (error) {
      settingsDrawer.hidden = false;
      setFeedback(error instanceof Error ? error.message : "Не удалось сохранить API-ключ.");
      return;
    }
  }
  if (!hasStoredApiKey) {
    settingsDrawer.hidden = false;
    setFeedback("Укажите API-ключ PartsAPI в настройках.");
    apiKeyInput.focus();
    return;
  }

  const entry = createSearchEntry({ sku, makeName: make.name, status: "Ищем применимость…" });
  tab.searches.push(entry);
  activeRequest?.abort();
  const controller = new AbortController();
  activeRequest = controller;
  submitButton.disabled = true;
  submitButton.querySelector("span").textContent = "Ищем…";
  setFeedback("", "notice");
  renderResults(tab);
  renderTabs();
  saveApplicabilityState();
  try {
    const response = await fetch("/api/applicability/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ sku, brand: make.name }),
      signal: controller.signal,
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(typeof payload?.message === "string" ? payload.message : "Не удалось выполнить поиск применимости.");
    if (!Array.isArray(payload?.results)) throw new Error("Сервис вернул некорректный ответ.");
    entry.results = payload.results;
    entry.hasSearched = true;
    entry.status = payload.results.length ? `Найдено автомобилей: ${payload.results.length}` : "Не найдено";
    if (activeTabId === tab.id) renderResults(tab);
    renderTabs();
    saveApplicabilityState();
  } catch (error) {
    if (error.name !== "AbortError") {
      tab.searches = tab.searches.filter((item) => item !== entry);
      if (activeTabId === tab.id) renderResults(tab);
      renderTabs();
      saveApplicabilityState();
      setFeedback(error instanceof Error ? error.message : "Не удалось выполнить поиск применимости.");
    } else {
      tab.searches = tab.searches.filter((item) => item !== entry);
      if (activeTabId === tab.id) renderResults(tab);
      renderTabs();
      saveApplicabilityState();
    }
  } finally {
    if (activeRequest === controller) {
      activeRequest = null;
      submitButton.disabled = false;
      submitButton.querySelector("span").textContent = "Поиск";
    }
  }
});

restoreApplicabilityState();
if (!tabs.length) tabs.push(createTab());
if (!tabs.some((tab) => tab.id === activeTabId)) activeTabId = tabs[0].id;
renderActiveTab();
loadMakes();
loadApiKeyState();
try {
  if (localStorage.getItem(activeFunctionStorageKey) === "applicability") setActiveFunction("applicability");
} catch {
  // The selected function is a convenience preference.
}
