const markupFunction = document.querySelector("#markup-function");
const applicabilityFunction = document.querySelector("#applicability-function");
const markupTab = document.querySelector("#markup-function-tab");
const applicabilityTab = document.querySelector("#applicability-function-tab");
const applicabilityTabsList = document.querySelector("#applicability-tabs-list");
const newApplicabilityTabButton = document.querySelector("#applicability-new-tab");
const form = document.querySelector("#applicability-search-form");
const skuInput = document.querySelector("#applicability-sku");
const makeInput = document.querySelector("#applicability-make");
const makesList = document.querySelector("#applicability-makes");
const apiKeyInput = document.querySelector("#applicability-api-key");
const settingsDrawer = document.querySelector("#applicability-settings-drawer");
const settingsToggle = document.querySelector("#applicability-settings-toggle");
const settingsClose = document.querySelector("#applicability-settings-close");
const settingsBackdrop = document.querySelector("#applicability-settings-backdrop");
const submitButton = document.querySelector("#applicability-submit");
const feedback = document.querySelector("#applicability-feedback");
const resultSummary = document.querySelector("#applicability-result-summary");
const resultsBody = document.querySelector("#applicability-results-body");

let makesByName = new Map();
let tabs = [];
let activeTabId = null;
let tabSequence = 1;
let activeRequest = null;

const createTab = (data = {}) => ({
  id: data.id ?? `applicability-tab-${Date.now()}-${tabSequence++}`,
  sku: typeof data.sku === "string" ? data.sku : "",
  makeName: typeof data.makeName === "string" ? data.makeName : "",
  makeId: Number.isSafeInteger(data.makeId) ? data.makeId : null,
  results: Array.isArray(data.results) ? data.results : [],
  status: typeof data.status === "string" ? data.status : "",
  hasSearched: Boolean(data.hasSearched),
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

const selectedMake = () => makesByName.get(makeInput.value.trim().toLocaleUpperCase()) ?? null;

const appendCell = (row, text) => {
  const cell = document.createElement("td");
  cell.textContent = text;
  row.append(cell);
};

const renderResults = (tab) => {
  resultsBody.replaceChildren();
  const vehicles = tab.results;
  resultSummary.textContent = tab.status || (tab.hasSearched ? (vehicles.length ? `Найдено автомобилей: ${vehicles.length}` : "Не найдено") : "Введите артикул и бренд");
  resultSummary.dataset.tone = tab.hasSearched && !vehicles.length ? "empty" : "";
  if (!vehicles.length) {
    const row = document.createElement("tr");
    row.className = `results-table__empty${tab.hasSearched ? " applicability-no-results" : ""}`;
    const cell = document.createElement("td");
    cell.colSpan = 5;
    cell.textContent = tab.hasSearched ? "По вашему запросу ничего не найдено." : "Выполните поиск применимости.";
    row.append(cell);
    resultsBody.append(row);
    return;
  }
  vehicles.forEach((vehicle) => {
    const row = document.createElement("tr");
    appendCell(row, vehicle.makeName);
    appendCell(row, vehicle.modelName);
    appendCell(row, vehicle.carName);
    appendCell(row, `${vehicle.yearStart} — ${vehicle.yearEnd}`);
    appendCell(row, vehicle.carType);
    resultsBody.append(row);
  });
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
    status.className = `search-tab__status${tab.hasSearched && tab.results.length ? " is-completed" : ""}`;
    status.setAttribute("aria-hidden", "true");
    const title = document.createElement("span");
    title.className = "search-tab__title";
    title.textContent = tab.sku || `Новая применимость ${index + 1}`;
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
};

const addTab = () => {
  syncActiveTab();
  const tab = createTab();
  tabs.push(tab);
  activeTabId = tab.id;
  renderActiveTab();
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
};

const loadMakes = async () => {
  try {
    const response = await fetch("/applicability-makes.json", { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error("Make list could not be loaded");
    const payload = await response.json();
    if (!Array.isArray(payload)) throw new Error("Make list is invalid");
    const options = document.createDocumentFragment();
    const makes = new Map();
    payload.forEach((make) => {
      if (!make || typeof make.makeId !== "number" || !Number.isSafeInteger(make.makeId) || typeof make.makeName !== "string" || !make.makeName.trim()) return;
      const name = make.makeName.trim();
      const option = document.createElement("option");
      option.value = name;
      options.append(option);
      makes.set(name.toLocaleUpperCase(), { id: make.makeId, name });
    });
    if (!makes.size) throw new Error("Make list is empty");
    makesByName = makes;
    makesList.replaceChildren(options);
  } catch {
    setFeedback("Не удалось загрузить список брендов. Обновите страницу и повторите попытку.");
  }
};

markupTab.addEventListener("click", () => setActiveFunction("markup"));
applicabilityTab.addEventListener("click", () => setActiveFunction("applicability"));
newApplicabilityTabButton.addEventListener("click", addTab);
settingsToggle.addEventListener("click", () => {
  settingsDrawer.hidden = false;
  apiKeyInput.focus();
});
settingsClose.addEventListener("click", () => { settingsDrawer.hidden = true; });
settingsBackdrop.addEventListener("click", () => { settingsDrawer.hidden = true; });

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

skuInput.addEventListener("input", syncActiveTab);
makeInput.addEventListener("input", () => {
  makeInput.dataset.makeId = selectedMake()?.id ? String(selectedMake().id) : "";
  syncActiveTab();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const tab = getActiveTab();
  if (!tab) return;
  syncActiveTab();
  const sku = tab.sku;
  const make = selectedMake();
  const apiKey = apiKeyInput.value.trim();
  if (!sku) return;
  if (!make) {
    setFeedback("Выберите марку из списка.");
    makeInput.focus();
    return;
  }
  if (!apiKey) {
    settingsDrawer.hidden = false;
    setFeedback("Укажите API-ключ PartsAPI в настройках.");
    apiKeyInput.focus();
    return;
  }

  activeRequest?.abort();
  const controller = new AbortController();
  activeRequest = controller;
  submitButton.disabled = true;
  submitButton.querySelector("span").textContent = "Ищем…";
  setFeedback("", "notice");
  tab.status = "Ищем применимость…";
  renderTabs();
  try {
    const response = await fetch("/api/applicability/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ sku, apiKey }),
      signal: controller.signal,
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(typeof payload?.message === "string" ? payload.message : "Не удалось выполнить поиск применимости.");
    if (!Array.isArray(payload?.results)) throw new Error("Сервис вернул некорректный ответ.");
    tab.results = payload.results;
    tab.hasSearched = true;
    tab.status = payload.results.length ? `Найдено автомобилей: ${payload.results.length}` : "Не найдено";
    if (activeTabId === tab.id) renderResults(tab);
    renderTabs();
  } catch (error) {
    if (error.name !== "AbortError") {
      tab.status = "Ошибка поиска";
      renderTabs();
      setFeedback(error instanceof Error ? error.message : "Не удалось выполнить поиск применимости.");
    }
  } finally {
    if (activeRequest === controller) {
      activeRequest = null;
      submitButton.disabled = false;
      submitButton.querySelector("span").textContent = "Найти";
    }
  }
});

tabs.push(createTab());
activeTabId = tabs[0].id;
renderActiveTab();
loadMakes();
