import { buildApplicabilityVariantCodeContext, formatApplicabilityVehicleGroups } from "./applicability-formatting.js";
import { normalizeApplicabilitySku, parseApplicabilitySkus, runApplicabilityBatch } from "./applicability-search-input.js";
import { bootstrapApplicabilityOemSidebar } from "./applicability-oem-sidebar.js";
import { applicabilityFileMaxBytes, decodeApplicabilityFile, parseApplicabilityFile } from "./applicability-file-import.js";
import { createApplicabilityMakeMatcher } from "./applicability-make-aliases.js";
import { moveApplicabilityGroupRelative, moveApplicabilityTabIntoGroup, moveApplicabilityTabOutOfGroup, moveApplicabilityTabRelative, nextApplicabilityGroupNumber, normalizeApplicabilityGroupName, restoreApplicabilityGroups } from "./applicability-tab-groups.js";

const markupFunction = document.querySelector("#markup-function");
const applicabilityFunction = document.querySelector("#applicability-function");
const markupTab = document.querySelector("#markup-function-tab");
const applicabilityTab = document.querySelector("#applicability-function-tab");
const applicabilityTabsList = document.querySelector("#applicability-tabs-list");
const applicabilityTabs = applicabilityTabsList.closest(".applicability-tabs");
const tabUngroupDrop = document.querySelector("#applicability-tab-ungroup-drop");
const newApplicabilityTabButton = document.querySelector("#applicability-new-tab");
const form = document.querySelector("#applicability-search-form");
const skuInput = document.querySelector("#applicability-sku");
const makeInput = document.querySelector("#applicability-make");
const selectedMakesContainer = document.querySelector("#applicability-selected-makes");
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
const removeFromGroupButton = document.querySelector("#applicability-remove-from-group");
const dissolveGroupButton = document.querySelector("#applicability-dissolve-group");
const tabDropFeedback = document.querySelector("#applicability-tab-drop-feedback");
const resultContextMenu = document.querySelector("#applicability-result-context-menu");
const deleteResultButton = document.querySelector("#applicability-result-delete-button");
const submitButton = document.querySelector("#applicability-submit");
const feedback = document.querySelector("#applicability-feedback");
const resultsBody = document.querySelector("#applicability-results-body");
const resultsTotal = document.querySelector("#applicability-results-total");
const resultsFound = document.querySelector("#applicability-results-found");
const resultsNotFound = document.querySelector("#applicability-results-not-found");
const listButton = document.querySelector("#applicability-list-button");
const multiListButton = document.querySelector("#applicability-multi-list-button");
const applicabilityToast = document.querySelector("#applicability-toast");
const articleNameModal = document.querySelector("#applicability-article-name-modal");
const articleNameForm = document.querySelector("#applicability-article-name-form");
const articleNameInput = document.querySelector("#applicability-article-name-input");
const articleNameTitle = document.querySelector("#applicability-article-name-title");
const articleNameLabel = document.querySelector('label[for="applicability-article-name-input"] > span');
const closeArticleNameButtons = [...document.querySelectorAll("[data-close-applicability-article-name]")];
const documentModal = document.querySelector("#applicability-document-modal");
const documentText = document.querySelector("#applicability-document-text");
const documentCount = document.querySelector("#applicability-document-count");
const documentSaveButton = document.querySelector("#applicability-document-save");
const closeDocumentButtons = [...document.querySelectorAll("[data-close-applicability-document]")];
const documentFormatControl = document.querySelector("#applicability-document-format");
const documentFormatValue = document.querySelector("#applicability-document-format-value");
const documentFormatButtons = [...document.querySelectorAll("[data-applicability-document-format]")];
const documentColumnsControl = document.querySelector("#applicability-document-columns");
const documentColumnInputs = [...document.querySelectorAll("[data-applicability-document-column]")];
const fileImportButton = document.querySelector("#applicability-file-toggle");
const fileImportModal = document.querySelector("#applicability-file-modal");
const fileImportForm = document.querySelector("#applicability-file-form");
const fileImportInput = document.querySelector("#applicability-file-input");
const fileImportTarget = document.querySelector("#applicability-file-target");
const fileImportFeedback = document.querySelector("#applicability-file-feedback");
const fileImportPreview = document.querySelector("#applicability-file-preview");
const fileImportRowsBody = document.querySelector("#applicability-file-rows");
const fileImportProgress = document.querySelector("#applicability-file-progress");
const fileImportSummary = document.querySelector("#applicability-file-summary");
const fileImportStart = document.querySelector("#applicability-file-start");
const fileImportStop = document.querySelector("#applicability-file-stop");
const closeFileImportButtons = [...document.querySelectorAll("[data-close-applicability-file]")];

let makesByName = new Map();
let makeMatcher = createApplicabilityMakeMatcher([]);
let tabs = [];
let tabGroups = [];
let groupSequence = 1;
let draggedTabId = null;
let draggedGroupId = null;
let tabDropTarget = null;
let expandedGroupId = null;
let activeTabId = null;
let tabSequence = 1;
let activeRequest = null;
let hasStoredApiKey = false;
let activeMakeIndex = -1;
let contextMenuTabId = null;
let contextMenuGroupId = null;
let contextMenuTabAnchor = null;
let contextMenuEntryAnchor = null;
let articleNameModalReturnFocus = null;
let articleNameModalTabId = null;
let articleNameModalGroupId = null;
let openDocumentAfterArticleNaming = false;
let documentModalReturnFocus = null;
let documentFormat = "structured";
let documentSections = [];
let applicabilityToastTimer = null;
let cachedBrandLookupTimer = null;
let cachedBrandLookupController = null;
let selectedEntryIds = new Set();
let selectionAnchorEntryId = null;
let oemSidebar = null;
let fileImportRows = [];
let fileImportRequest = null;
let fileImportTabId = null;
let fileImportArticles = [];
let fileImportTargets = new Map();
let fileImportGroupId = null;
let fileImportReturnFocus = null;
let fileReadSequence = 0;
let fileReading = false;

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

const searchIdentity = (sku, brand) => `${normalizeApplicabilitySku(sku).toLocaleUpperCase()}\u0000${brand.trim().toLocaleUpperCase()}`;

const normalizeMakeNames = (value) => {
  const names = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const uniqueNames = new Map();
  names.forEach((name) => {
    if (typeof name !== "string") return;
    const normalizedName = name.replace(/\s+/g, " ").trim();
    if (normalizedName) uniqueNames.set(normalizedName.toLocaleUpperCase(), normalizedName);
  });
  return [...uniqueNames.values()];
};

const createTab = (data = {}) => {
  const makeNames = normalizeMakeNames([...(Array.isArray(data.makeNames) ? data.makeNames : []), data.makeName]);
  return {
    id: data.id ?? `applicability-tab-${Date.now()}-${tabSequence++}`,
    name: typeof data.name === "string" ? data.name.replace(/\s+/g, " ").trim().slice(0, 100) : "",
    groupId: typeof data.groupId === "string" ? data.groupId : null,
    sku: typeof data.sku === "string" ? data.sku : "",
    makeNames,
    makeName: makeNames[0] ?? "",
    makeId: Number.isSafeInteger(data.makeId) ? data.makeId : null,
    searches: (() => {
      const seen = new Set();
      return Array.isArray(data.searches)
        ? data.searches.map(createSearchEntry).filter((entry) => {
          const identity = searchIdentity(entry.sku, entry.makeName);
          if (!identity || seen.has(identity)) return false;
          seen.add(identity);
          return true;
        })
        : [];
    })(),
  };
};

const getActiveTab = () => tabs.find((tab) => tab.id === activeTabId);

const setActiveFunction = (name) => {
  const isApplicability = name === "applicability";
  if (!isApplicability) oemSidebar?.hide();
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

const showApplicabilityToast = (message, tone = "notice") => {
  if (applicabilityToastTimer !== null) window.clearTimeout(applicabilityToastTimer);
  applicabilityToast.textContent = message;
  applicabilityToast.dataset.tone = tone;
  applicabilityToast.hidden = false;
  applicabilityToastTimer = window.setTimeout(() => {
    applicabilityToast.hidden = true;
    applicabilityToastTimer = null;
  }, 4_000);
};

const normalizeTabName = (value) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 100) : "");

const saveApplicabilityState = () => {
  try {
    syncActiveTab();
    localStorage.setItem(applicabilityStateStorageKey, JSON.stringify({
      activeTabId,
      groups: tabGroups.map(({ id, name }) => ({ id, name })),
      nextGroupNumber: groupSequence,
      tabs: tabs.map((tab) => ({
        id: tab.id,
        name: tab.name,
        groupId: tab.groupId,
        sku: tab.sku,
        makeNames: tab.makeNames,
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
    tabGroups = restoreApplicabilityGroups(state.groups, tabs);
    groupSequence = tabGroups.length ? nextApplicabilityGroupNumber(state.nextGroupNumber, tabGroups) : 1;
    activeTabId = tabs.some((tab) => tab.id === state.activeTabId) ? state.activeTabId : tabs[0].id;
  } catch {
    localStorage.removeItem(applicabilityStateStorageKey);
  }
};

const pruneApplicabilityGroups = () => {
  tabGroups = restoreApplicabilityGroups(tabGroups, tabs);
  if (!tabGroups.length) groupSequence = 1;
};

const setApiKeyStatus = (message, configured) => {
  apiKeyStatus.textContent = message;
  apiKeyStatus.hidden = !message;
  hasStoredApiKey = configured;
};

const readApiKeyState = async (response) => {
  const payload = await response.json();
  if (
    !response.ok
    || typeof payload?.configured !== "boolean"
    || typeof payload.persistent !== "boolean"
    || (payload.configured
      ? typeof payload.maskedKey !== "string" || !/^….{0,5}$/u.test(payload.maskedKey)
      : payload.maskedKey !== null)
  ) {
    throw new Error(typeof payload?.message === "string" ? payload.message : "Не удалось сохранить API-ключ.");
  }
  return payload;
};

const applyApiKeyState = (state) => {
  setApiKeyStatus(state.configured ? "Ключ сохранён" : "", state.configured);
  apiKeyInput.placeholder = state.maskedKey ?? "Введите API-ключ PartsAPI";
};

const saveApiKey = async (signal) => {
  const apiKey = apiKeyInput.value.trim();
  if (!apiKey) {
    throw new Error("Укажите API-ключ PartsAPI.");
  }
  const state = await readApiKeyState(await fetch("/api/applicability/api-key", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ apiKey }),
    signal,
  }));
  apiKeyInput.value = "";
  applyApiKeyState(state);
  return state;
};

const loadApiKeyState = async () => {
  try {
    const state = await readApiKeyState(await fetch("/api/applicability/api-key", {
      headers: { Accept: "application/json" }, signal: AbortSignal.timeout(5_000),
    }));
    applyApiKeyState(state);
  } catch {
    setApiKeyStatus("Не удалось проверить настройки API-ключа.", hasStoredApiKey);
  }
};

const selectedMakeNames = (tab = getActiveTab()) => normalizeMakeNames(tab?.makeNames);

const selectedMakes = (tab = getActiveTab()) => selectedMakeNames(tab)
  .map((name) => makesByName.get(name.toLocaleUpperCase()))
  .filter(Boolean);

const isMakeSelected = (make, tab = getActiveTab()) => selectedMakeNames(tab)
  .some((name) => name.toLocaleUpperCase() === make.name.toLocaleUpperCase());

const matchingMakes = () => {
  const query = makeInput.value.trim();
  return [...makesByName.values()]
    .filter((make) => makeMatcher.matches(make.name, query))
    .slice(0, 80);
};

const closeMakeMenu = () => {
  makesMenu.hidden = true;
  makeInput.setAttribute("aria-expanded", "false");
  makeInput.removeAttribute("aria-activedescendant");
  activeMakeIndex = -1;
};

const renderSelectedMakes = () => {
  const tab = getActiveTab();
  selectedMakesContainer.replaceChildren();
  selectedMakeNames(tab).forEach((name) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "applicability-make-chip";
    chip.dataset.removeMakeName = name;
    chip.setAttribute("aria-label", `Убрать бренд ${name}`);
    const label = document.createElement("span");
    label.className = "applicability-make-chip__label";
    label.textContent = name;
    const remove = document.createElement("span");
    remove.className = "applicability-make-chip__remove";
    remove.setAttribute("aria-hidden", "true");
    remove.textContent = "×";
    chip.append(label, remove);
    selectedMakesContainer.append(chip);
  });
};

const setSelectedMakeNames = (names, { focus = false } = {}) => {
  const tab = getActiveTab();
  if (!tab) return;
  tab.makeNames = normalizeMakeNames(names);
  tab.makeName = tab.makeNames[0] ?? "";
  tab.makeId = selectedMakes(tab)[0]?.id ?? null;
  renderSelectedMakes();
  syncActiveTab();
  saveApplicabilityState();
  if (focus) makeInput.focus();
};

const toggleMake = (make) => {
  const names = selectedMakeNames();
  const selected = isMakeSelected(make);
  setSelectedMakeNames(selected
    ? names.filter((name) => name.toLocaleUpperCase() !== make.name.toLocaleUpperCase())
    : [...names, make.name], { focus: true });
  makeInput.value = "";
  renderMakeMenu();
};

const selectMake = (make) => {
  if (!isMakeSelected(make)) setSelectedMakeNames([...selectedMakeNames(), make.name]);
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
      const selected = isMakeSelected(make);
      option.className = `applicability-make-option${index === activeMakeIndex ? " is-active" : ""}${selected ? " is-selected" : ""}`;
      option.dataset.makeName = make.name;
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", String(selected));
      const check = document.createElement("span");
      check.className = "applicability-make-option__check";
      check.setAttribute("aria-hidden", "true");
      check.textContent = selected ? "✓" : "";
      const label = document.createElement("span");
      label.textContent = make.name;
      option.append(check, label);
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
  return cell;
};

const completedSearches = (tab) => tab.searches.filter((entry) => entry.hasSearched);

const visibleDocumentColumns = () => new Set(
  documentColumnInputs
    .filter((input) => input.checked)
    .map((input) => input.dataset.applicabilityDocumentColumn),
);

const lookupCachedBrands = async (sku, signal) => {
  const response = await fetch(`/api/applicability/cached-brands?sku=${encodeURIComponent(sku)}`, {
    headers: { Accept: "application/json" },
    signal,
  });
  const payload = await response.json();
  if (!response.ok || !Array.isArray(payload?.brands)) throw new Error("Не удалось проверить сохранённые артикулы.");
  return payload.brands.filter((brand) => typeof brand === "string" && brand.trim());
};

const cancelCachedLookup = () => {
  if (cachedBrandLookupTimer !== null) window.clearTimeout(cachedBrandLookupTimer);
  cachedBrandLookupTimer = null;
  cachedBrandLookupController?.abort();
  cachedBrandLookupController = null;
};

const applyCachedBrand = async (sku, { force = false } = {}) => {
  cancelCachedLookup();
  const tab = getActiveTab();
  const inputValue = skuInput.value;
  let skus;
  try {
    skus = parseApplicabilitySkus(sku);
  } catch {
    // Invalid input is reported when the user submits the search.
    return null;
  }
  if (skus.length !== 1) return null;
  const controller = new AbortController();
  cachedBrandLookupController = controller;
  try {
    const brands = await lookupCachedBrands(skus[0], controller.signal);
    if (controller.signal.aborted || tab !== getActiveTab() || inputValue !== skuInput.value) return null;
    if (!force && selectedMakeNames().length) return null;
    const cachedMakes = normalizeMakeNames(brands)
      .map((brand) => makesByName.get(brand.toLocaleUpperCase()))
      .filter(Boolean);
    if (!cachedMakes.length) return null;
    setSelectedMakeNames([...selectedMakeNames(), ...cachedMakes.map((make) => make.name)]);
    return cachedMakes;
  } catch {
    // Brand suggestion is optional; explicit search still reports service errors.
    return null;
  } finally {
    if (cachedBrandLookupController === controller) cachedBrandLookupController = null;
  }
};

const searchApplicability = async (sku, brand, signal) => {
  const response = await fetch("/api/applicability/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ sku, brand }),
    signal,
  });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(typeof payload?.message === "string" ? payload.message : "Не удалось выполнить поиск применимости.");
    error.status = response.status;
    throw error;
  }
  if (!Array.isArray(payload?.results) || typeof payload.cacheHit !== "boolean") throw new Error("Сервис вернул некорректный ответ.");
  return { results: payload.results, cacheHit: payload.cacheHit };
};

const executeApplicabilitySearch = async (sku, brand, signal) => {
  let { results, cacheHit } = await searchApplicability(sku, brand, signal);
  const normalizedSku = normalizeApplicabilitySku(sku);
  let usedNormalizedSku = false;
  if (!results.length && normalizedSku && normalizedSku !== sku) {
    ({ results, cacheHit } = await searchApplicability(normalizedSku, brand, signal));
    usedNormalizedSku = results.length > 0;
  }
  return { results, cacheHit, usedNormalizedSku, normalizedSku };
};

const duplicateSearch = (tab, sku, brand) => tab.searches.find((entry) => searchIdentity(entry.sku, entry.makeName) === searchIdentity(sku, brand));

const applySearchResult = (entry, result) => {
  if (result.usedNormalizedSku) entry.sku = result.normalizedSku;
  entry.results = result.results;
  entry.hasSearched = true;
  entry.status = result.results.length ? `Найдено автомобилей: ${result.results.length}` : "Не найдено";
};

const setFileImportFeedback = (message) => {
  fileImportFeedback.textContent = message;
  fileImportFeedback.hidden = !message;
};

const updateFileImportTarget = () => {
  if (fileImportArticles.length > 1) {
    const group = tabGroups.find((item) => item.id === fileImportGroupId);
    fileImportTarget.textContent = group
      ? `Результаты добавляются в группу «${group.name}». Вкладок: ${fileImportArticles.length}; у каждого исходного артикула свои OEM-номера.`
      : fileImportTargets.size
        ? `Результаты добавляются в исходные вкладки (${fileImportArticles.length}). У каждого артикула свои OEM-номера.`
        : `Будет создана группа с вкладками по исходным артикулам (${fileImportArticles.length}). У каждого артикула свои OEM-номера.`;
    return;
  }
  const tabId = fileImportTargets.values().next().value ?? fileImportTabId;
  const tab = tabs.find((item) => item.id === tabId) ?? getActiveTab();
  const name = tab?.name || `Новая применимость ${tabs.indexOf(tab) + 1}`;
  fileImportTarget.textContent = fileImportArticles.length
    ? `Один исходный артикул: «${fileImportArticles[0]}». Его OEM-номера будут добавлены в текущую вкладку «${name}»; вкладка получит название артикула.`
    : `Результаты добавляются во вкладку «${name}».`;
};

const prepareFileImportTargets = (tab) => {
  if (fileImportTargets.size) {
    if ([...fileImportTargets.values()].some((id) => !tabs.some((item) => item.id === id))) {
      throw new Error("Вкладка импорта закрыта. Выберите файл заново для продолжения.");
    }
    return;
  }
  if (fileImportArticles.length > 1) {
    const group = { id: `applicability-group-${Date.now()}-${tabSequence++}`, name: `Группа ${groupSequence++}` };
    tabGroups.push(group);
    fileImportGroupId = group.id;
    for (const article of fileImportArticles) {
      const target = createTab({ name: article, groupId: group.id });
      tabs.push(target);
      fileImportTargets.set(article, target.id);
    }
    if (getActiveTab() === tab) activeTabId = fileImportTargets.values().next().value;
  } else {
    if (fileImportArticles.length) tab.name = normalizeTabName(fileImportArticles[0]);
    fileImportTargets.set(fileImportArticles[0] ?? "", tab.id);
  }
  renderActiveTab();
  saveApplicabilityState();
  updateFileImportTarget();
};

const updateFileImportControls = () => {
  fileImportInput.disabled = Boolean(fileImportRequest);
  fileImportStart.disabled = Boolean(activeRequest) || fileReading || !fileImportRows.some((row) => row.state === "pending" || row.state === "error");
  fileImportStop.hidden = !fileImportRequest;
  fileImportStop.disabled = Boolean(fileImportRequest?.signal.aborted);
};

const setFileImportRowStatus = (row, state, message) => {
  row.state = state;
  row.statusCell.textContent = message;
  row.element.dataset.state = state;
};

const renderFileImportRows = () => {
  fileImportRowsBody.replaceChildren();
  fileImportRows.forEach((row) => {
    row.element = document.createElement("tr");
    appendCell(row.element, String(row.lineNumber));
    const articleCell = appendCell(row.element, row.article ?? "");
    articleCell.hidden = !fileImportArticles.length;
    appendCell(row.element, row.sku);
    appendCell(row.element, row.brand);
    row.statusCell = document.createElement("td");
    row.element.append(row.statusCell);
    setFileImportRowStatus(row, row.error ? "skipped" : "pending", row.error || "Ожидает поиска");
    fileImportRowsBody.append(row.element);
  });
  fileImportPreview.hidden = !fileImportRows.length;
  document.querySelector("#applicability-file-article-heading").hidden = !fileImportArticles.length;
  const ready = fileImportRows.filter((row) => row.state === "pending").length;
  fileImportSummary.textContent = `Готово к поиску: ${ready}. Пропущено: ${fileImportRows.length - ready}.`;
  updateFileImportControls();
};

const closeFileImportModal = () => {
  fileImportModal.hidden = true;
  if (fileImportReturnFocus?.isConnected) fileImportReturnFocus.focus();
  fileImportReturnFocus = null;
};

fileImportButton.addEventListener("click", () => {
  closeMakeMenu();
  fileImportReturnFocus = document.activeElement;
  updateFileImportTarget();
  fileImportModal.hidden = false;
  updateFileImportControls();
  (fileImportRequest ? fileImportStop : fileImportInput).focus();
});
closeFileImportButtons.forEach((button) => button.addEventListener("click", closeFileImportModal));
fileImportStop.addEventListener("click", () => {
  fileImportRequest?.abort();
  updateFileImportControls();
});

fileImportInput.addEventListener("change", async () => {
  const sequence = ++fileReadSequence;
  const file = fileImportInput.files[0];
  fileImportRows = [];
  fileImportArticles = [];
  fileImportTargets = new Map();
  fileImportGroupId = null;
  fileImportRowsBody.replaceChildren();
  fileImportPreview.hidden = true;
  fileImportProgress.hidden = true;
  fileImportSummary.textContent = "";
  setFileImportFeedback("");
  updateFileImportTarget();
  fileReading = Boolean(file);
  updateFileImportControls();
  if (!file) return;
  try {
    if (!/\.txt$/iu.test(file.name)) throw new Error("Выберите текстовый файл с расширением .txt.");
    if (file.size > applicabilityFileMaxBytes) throw new Error("Размер файла не должен превышать 1 МБ.");
    const text = decodeApplicabilityFile(await file.arrayBuffer());
    await makesReady;
    if (sequence !== fileReadSequence) return;
    if (!makesByName.size) throw new Error("Не удалось загрузить список брендов. Обновите страницу.");
    const parsed = parseApplicabilityFile(text, [...makesByName.values()].map((make) => make.name));
    fileImportRows = parsed.rows;
    fileImportArticles = parsed.articles;
    updateFileImportTarget();
    renderFileImportRows();
  } catch (error) {
    if (sequence === fileReadSequence) setFileImportFeedback(error instanceof Error ? error.message : "Не удалось прочитать файл.");
  } finally {
    if (sequence === fileReadSequence) {
      fileReading = false;
      updateFileImportControls();
    }
  }
});

fileImportForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (activeRequest || fileReading) return;
  const tab = getActiveTab();
  const queue = fileImportRows.filter((row) => row.state === "pending" || row.state === "error");
  if (!tab || !queue.length) return;
  cancelCachedLookup();
  syncActiveTab();
  const controller = new AbortController();
  activeRequest = controller;
  fileImportRequest = controller;
  fileImportTabId = tab.id;
  submitButton.disabled = true;
  setFeedback("");
  setFileImportFeedback("");
  updateFileImportControls();
  fileImportStop.focus();
  let completed = 0;
  let added = fileImportRows.filter((row) => row.state === "done").length;
  let failed = 0;
  let skipped = fileImportRows.filter((row) => row.state === "skipped").length;
  const updateProgress = () => {
    fileImportProgress.value = completed;
    fileImportSummary.textContent = `Обработано: ${completed} из ${queue.length}. Добавлено: ${added}. Ошибок: ${failed}. Пропущено: ${skipped}.`;
  };
  try {
    await apiKeyReady;
    controller.signal.throwIfAborted();
    if (apiKeyInput.value.trim()) await saveApiKey(AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]));
    if (!hasStoredApiKey) throw new Error("Укажите API-ключ PartsAPI в настройках рядом с кнопкой импорта.");
    controller.signal.throwIfAborted();
    if (!tabs.includes(tab)) return;
    prepareFileImportTargets(tab);
    fileImportProgress.max = queue.length;
    fileImportProgress.hidden = false;
    updateProgress();
    for (const row of queue) {
      const target = tabs.find((item) => item.id === fileImportTargets.get(row.article ?? ""));
      if (controller.signal.aborted || !target) break;
      if (duplicateSearch(target, row.sku, row.brand)) {
        setFileImportRowStatus(row, "skipped", "Уже есть во вкладке");
        skipped += 1;
        completed += 1;
        updateProgress();
        continue;
      }
      const entry = createSearchEntry({ sku: row.sku, makeName: row.brand, status: "Ищем применимость…" });
      target.searches.push(entry);
      setFileImportRowStatus(row, "searching", "Ищем применимость…");
      if (getActiveTab() === target) renderResults(target);
      try {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(35_000)]);
        const result = await executeApplicabilitySearch(entry.sku, entry.makeName, signal);
        signal.throwIfAborted();
        if (!tabs.includes(target)) break;
        applySearchResult(entry, result);
        setFileImportRowStatus(row, "done", `${entry.status}${result.cacheHit ? " · Из базы" : ""}`);
        added += 1;
      } catch (error) {
        target.searches = target.searches.filter((item) => item !== entry);
        if (controller.signal.aborted) {
          setFileImportRowStatus(row, "pending", "Остановлено");
          break;
        }
        const message = error?.name === "TimeoutError" ? "Время ожидания поиска истекло." : error instanceof Error ? error.message : "Не удалось выполнить поиск применимости.";
        setFileImportRowStatus(row, "error", message);
        failed += 1;
        if (error?.status === 401) {
          setFileImportFeedback(message);
          showApplicabilityToast(message, "error");
          controller.abort();
        }
      } finally {
        if (getActiveTab() === target) renderResults(target);
        renderTabs();
        saveApplicabilityState();
      }
      completed += 1;
      updateProgress();
    }
    if (controller.signal.aborted) fileImportSummary.textContent += " Очередь остановлена; готовые результаты сохранены.";
  } catch (error) {
    if (!controller.signal.aborted) setFileImportFeedback(error instanceof Error ? error.message : "Не удалось начать поиск из файла.");
  } finally {
    fileImportRequest = null;
    fileImportTabId = null;
    if (activeRequest === controller) {
      activeRequest = null;
      submitButton.disabled = false;
      oemSidebar?.refresh();
    }
    updateFileImportControls();
    if (!fileImportModal.hidden) (fileImportStart.disabled ? fileImportInput : fileImportStart).focus();
  }
});

const addSavedOemArticle = async (article, signal) => {
  const tab = getActiveTab();
  if (!tab) return;
  if (duplicateSearch(tab, article.sku, article.brand)) {
    showApplicabilityToast("Артикул и бренд уже добавлены в активную вкладку.", "notice");
    return;
  }
  const query = new URLSearchParams({ sku: article.sku, brand: article.brand });
  const response = await fetch(`/api/applicability/saved-articles/result?${query}`, { headers: { Accept: "application/json" }, signal });
  const payload = await response.json();
  signal.throwIfAborted();
  if (!response.ok) throw new Error(typeof payload?.message === "string" ? payload.message : "Не удалось открыть сохранённую применимость.");
  if (!Array.isArray(payload?.results) || payload.results.some((vehicle) => !vehicle || !Number.isSafeInteger(vehicle.carId)
    || vehicle.carId <= 0 || ["carName", "carType", "makeName", "modelName", "yearStart", "yearEnd"]
      .some((field) => vehicle[field] !== null && typeof vehicle[field] !== "string"))) {
    throw new Error("Сервис вернул некорректную применимость.");
  }
  if (!tabs.includes(tab) || duplicateSearch(tab, article.sku, article.brand)) return;
  tab.searches.push(createSearchEntry({
    sku: article.sku, makeName: article.brand, results: payload.results, hasSearched: true,
    status: payload.results.length ? `Найдено автомобилей: ${payload.results.length}` : "Не найдено",
  }));
  if (getActiveTab() === tab) renderResults(tab);
  renderTabs();
  saveApplicabilityState();
  showApplicabilityToast(`OEM-артикул ${article.sku} (${article.brand}) добавлен во вкладку.`, "success");
};

const groupSearchesBySku = (entries) => [...entries.reduce((groups, entry) => {
  const entriesForSku = groups.get(entry.sku) ?? [];
  entriesForSku.push(entry);
  groups.set(entry.sku, entriesForSku);
  return groups;
}, new Map()).entries()];

const buildApplicabilityDocument = (sections, format = documentFormat) => {
  const visibleColumns = visibleDocumentColumns();
  let vehicleRowCount = 0;
  const variantCodeContext = format === "structured"
    ? buildApplicabilityVariantCodeContext(sections.flatMap(({ entries }) => entries.flatMap((entry) => entry.results)))
    : null;
  const text = sections.map(({ articleName, entries }) => {
    if (format !== "structured") {
      vehicleRowCount += entries.reduce((count, entry) => count + entry.results.length, 0);
      return `Артикул: ${articleName}\n\n${entries
        .map((entry) => `OEM-артикул: ${entry.sku}${entry.makeName ? ` | ${entry.makeName}` : ""}\n${JSON.stringify(entry.results, null, 2)}`)
        .join("\n\n")}`;
    }
    const oemGroups = groupSearchesBySku(entries);
    const vehiclesTexts = formatApplicabilityVehicleGroups(
      oemGroups.map(([, entriesForSku]) => entriesForSku.flatMap((entry) => entry.results)),
      visibleColumns,
      variantCodeContext,
    );
    const oemSections = oemGroups
      .map(([sku, entriesForSku], index) => {
        const brands = normalizeMakeNames(entriesForSku.map((entry) => entry.makeName));
        const vehiclesText = vehiclesTexts[index];
        vehicleRowCount += vehiclesText.split("\n").filter((line) => line.trim()).length;
        return {
          text: `OEM-артикул: ${sku}${brands.length ? ` | ${brands.join(", ")}` : ""}\n${vehiclesText}`,
          hasVehicles: Boolean(vehiclesText.trim()),
        };
      })
      .sort((first, second) => Number(second.hasVehicles) - Number(first.hasVehicles))
      .map(({ text }) => text)
      .join("\n\n");
    return `Артикул: ${articleName}\n\n${oemSections}`;
  }).join("\n\n");
  return { text, vehicleRowCount };
};

const renderApplicabilityDocument = ({ preserveTextState = false } = {}) => {
  const textState = preserveTextState ? {
    selectionDirection: documentText.selectionDirection,
    selectionEnd: documentText.selectionEnd,
    selectionStart: documentText.selectionStart,
    scrollLeft: documentText.scrollLeft,
    scrollTop: documentText.scrollTop,
  } : null;
  const { text, vehicleRowCount } = buildApplicabilityDocument(documentSections);
  documentText.value = text;
  documentCount.textContent = `Строк с автомобилями: ${vehicleRowCount}`;
  if (textState) {
    const length = documentText.value.length;
    documentText.setSelectionRange(
      Math.min(textState.selectionStart, length),
      Math.min(textState.selectionEnd, length),
      textState.selectionDirection,
    );
    documentText.scrollLeft = textState.scrollLeft;
    documentText.scrollTop = textState.scrollTop;
  }
  documentFormatValue.textContent = documentFormat === "structured" ? "Структурированный список" : "Сырые данные";
  documentFormatButtons.forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.applicabilityDocumentFormat === documentFormat));
  });
  documentColumnsControl.hidden = documentFormat !== "structured";
  if (documentFormat !== "structured") documentColumnsControl.open = false;
};

const applicabilityDocumentFileName = () => {
  let name = documentSections.map(({ articleName }) => articleName).join("_")
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "_")
    .trim().slice(0, 180).replace(/[. ]+$/g, "") || "Список применимости";
  if (/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name)) name = `_${name}`;
  return `${name}${documentFormat === "raw" ? "_сырые" : ""}.txt`;
};

const saveApplicabilityDocument = async () => {
  const suggestedName = applicabilityDocumentFileName();
  const contents = new Blob([documentText.value], { type: "text/plain;charset=utf-8" });

  if (typeof window.showSaveFilePicker === "function") {
    const fileHandle = await window.showSaveFilePicker({
      suggestedName,
      types: [{ description: "Текстовый файл", accept: { "text/plain": [".txt"] } }],
    });
    const writable = await fileHandle.createWritable();
    try {
      await writable.write(contents);
      await writable.close();
    } catch (error) {
      await writable.abort();
      throw error;
    }
    showApplicabilityToast("Список сохранён.", "success");
    return;
  }

  const url = URL.createObjectURL(contents);
  const link = document.createElement("a");
  link.href = url;
  link.download = suggestedName;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  showApplicabilityToast("Список скачан.", "success");
};

const updateListButton = (tab) => {
  const hasResults = completedSearches(tab).length > 0;
  listButton.disabled = !hasResults;
  listButton.title = hasResults ? "Сформировать список применимости" : "Нет результатов поиска для списка";
  const group = tabGroups.find((item) => item.id === tab.groupId);
  const hasGroupResults = Boolean(group && tabs.some((item) => item.groupId === group.id && completedSearches(item).length));
  multiListButton.hidden = !group;
  multiListButton.disabled = !hasGroupResults;
  multiListButton.title = hasGroupResults ? `Сформировать мультисписок группы «${group.name}»` : "В группе нет завершённых поисков";
};

const clearSelectedEntries = () => {
  selectedEntryIds = new Set();
  selectionAnchorEntryId = null;
};

const pruneSelectedEntries = (tab) => {
  const availableEntryIds = new Set(tab.searches.map((entry) => entry.id));
  selectedEntryIds = new Set([...selectedEntryIds].filter((entryId) => availableEntryIds.has(entryId)));
  if (!selectedEntryIds.has(selectionAnchorEntryId)) selectionAnchorEntryId = null;
};

const selectResultEntry = (entryId, { additive = false, range = false } = {}) => {
  const tab = getActiveTab();
  if (!tab || !tab.searches.some((entry) => entry.id === entryId)) return;

  if (range && selectionAnchorEntryId) {
    const entryIds = tab.searches.map((entry) => entry.id);
    const anchorIndex = entryIds.indexOf(selectionAnchorEntryId);
    const targetIndex = entryIds.indexOf(entryId);
    if (anchorIndex >= 0 && targetIndex >= 0) {
      selectedEntryIds = new Set(entryIds.slice(Math.min(anchorIndex, targetIndex), Math.max(anchorIndex, targetIndex) + 1));
    }
  } else if (additive) {
    if (selectedEntryIds.has(entryId)) selectedEntryIds.delete(entryId);
    else selectedEntryIds.add(entryId);
    selectionAnchorEntryId = entryId;
  } else {
    selectedEntryIds = new Set([entryId]);
    selectionAnchorEntryId = entryId;
  }
  renderResults(tab);
};

const deleteSelectedResults = () => {
  const tab = getActiveTab();
  if (!tab || !selectedEntryIds.size) return;
  tab.searches = tab.searches.filter((entry) => !selectedEntryIds.has(entry.id));
  clearSelectedEntries();
  renderResults(tab);
  saveApplicabilityState();
};

const renderResults = (tab) => {
  pruneSelectedEntries(tab);
  resultsBody.replaceChildren();
  updateListButton(tab);
  const searches = completedSearches(tab);
  const found = searches.filter((entry) => entry.results.length > 0).length;
  resultsTotal.textContent = String(tab.searches.length);
  resultsFound.textContent = String(found);
  resultsNotFound.textContent = String(searches.length - found);
  if (!tab.searches.length) return;
  tab.searches.forEach((entry) => {
    const row = document.createElement("tr");
    row.dataset.applicabilityEntryId = entry.id;
    row.tabIndex = 0;
    row.setAttribute("aria-selected", String(selectedEntryIds.has(entry.id)));
    row.classList.toggle("is-selected", selectedEntryIds.has(entry.id));
    if (!entry.hasSearched) {
      row.className = "applicability-searching-row";
      row.classList.toggle("is-selected", selectedEntryIds.has(entry.id));
      appendCell(row, entry.sku);
      appendCell(row, entry.makeName);
      appendCell(row, entry.status || "Ищем…");
      resultsBody.append(row);
      return;
    }
    if (!entry.results.length) {
      row.className = "applicability-no-results";
      row.classList.toggle("is-selected", selectedEntryIds.has(entry.id));
      appendCell(row, entry.sku);
      appendCell(row, entry.makeName);
      appendCell(row, "Не найдено");
      resultsBody.append(row);
      return;
    }
    row.className = "applicability-summary-row";
    row.classList.toggle("is-selected", selectedEntryIds.has(entry.id));
    const articleCell = document.createElement("td");
    articleCell.className = "applicability-article-cell";
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
    article.className = "applicability-article";
    article.textContent = entry.sku;
    expandButton.append(arrow);
    articleCell.append(expandButton, article);
    row.append(articleCell);
    appendCell(row, entry.makeName);
    appendCell(row, String(entry.results.length));
    resultsBody.append(row);

    if (entry.expanded) {
      const rawRow = document.createElement("tr");
      rawRow.className = "applicability-raw-row";
      rawRow.dataset.applicabilityEntryId = entry.id;
      rawRow.classList.toggle("is-selected", selectedEntryIds.has(entry.id));
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

const closeArticleNameModal = (restoreFocus = true) => {
  articleNameModal.hidden = true;
  if (restoreFocus && articleNameModalReturnFocus?.isConnected) articleNameModalReturnFocus.focus();
  articleNameModalReturnFocus = null;
  articleNameModalTabId = null;
  articleNameModalGroupId = null;
  openDocumentAfterArticleNaming = false;
};

const openArticleNameModal = (tabId, { openDocument = false, returnFocus = document.activeElement } = {}) => {
  const tab = tabs.find((item) => item.id === tabId);
  if (!tab) return;
  articleNameModalReturnFocus = returnFocus;
  articleNameModalTabId = tabId;
  articleNameModalGroupId = null;
  openDocumentAfterArticleNaming = openDocument;
  articleNameTitle.textContent = "Наименование исходного артикула";
  articleNameLabel.textContent = "Наименование";
  articleNameInput.setCustomValidity("");
  articleNameInput.value = tab.name || tab.sku || `Новая применимость ${tabs.indexOf(tab) + 1}`;
  articleNameModal.hidden = false;
  articleNameInput.focus();
  articleNameInput.select();
};

const openDocumentModalForTabs = (selectedTabs, returnFocus = document.activeElement) => {
  const sections = selectedTabs
    .map((tab) => ({ articleName: tab.name || tab.sku || `Новая применимость ${tabs.indexOf(tab) + 1}`, entries: completedSearches(tab) }))
    .filter((section) => section.entries.length);
  if (!sections.length) return;
  documentSections = sections;
  documentModalReturnFocus = returnFocus;
  renderApplicabilityDocument();
  documentModal.hidden = false;
  documentText.setSelectionRange(0, 0);
  documentText.scrollLeft = 0;
  documentText.scrollTop = 0;
  documentModal.focus();
};

const openDocumentModal = (tab = getActiveTab(), returnFocus = document.activeElement) => {
  if (!tab) return;
  if (!tab.name) {
    openArticleNameModal(tab.id, { openDocument: true, returnFocus });
    return;
  }
  openDocumentModalForTabs([tab], returnFocus);
};

const openGroupNameModal = (groupId, returnFocus = document.activeElement) => {
  const group = tabGroups.find((item) => item.id === groupId);
  if (!group) return;
  articleNameModalReturnFocus = returnFocus;
  articleNameModalTabId = null;
  articleNameModalGroupId = group.id;
  openDocumentAfterArticleNaming = false;
  articleNameTitle.textContent = "Название группы";
  articleNameLabel.textContent = "Название";
  articleNameInput.value = group.name;
  articleNameInput.setCustomValidity("");
  articleNameModal.hidden = false;
  articleNameInput.focus();
  articleNameInput.select();
};

const openGroupDocument = () => {
  syncActiveTab();
  const group = tabGroups.find((item) => item.id === getActiveTab()?.groupId);
  if (!group) return;
  openDocumentModalForTabs(tabs.filter((tab) => tab.groupId === group.id));
};

const closeGroupTabs = (keepGroupId = null) => {
  // Keep the source tab visible until the native drag finishes.
  const sourceGroupId = tabs.find((tab) => tab.id === draggedTabId)?.groupId;
  applicabilityTabsList.querySelectorAll(".applicability-tab-group").forEach((wrapper) => {
    const expanded = wrapper.dataset.groupId === keepGroupId || wrapper.dataset.groupId === sourceGroupId;
    wrapper.classList.toggle("is-expanded", wrapper.dataset.groupId === keepGroupId);
    wrapper.querySelector(".applicability-tab-group__tabs").hidden = !expanded;
    wrapper.querySelector(".applicability-tab-group__header").setAttribute("aria-expanded", String(expanded));
  });
  expandedGroupId = keepGroupId;
};

const openGroupTabs = (groupId) => {
  if (draggedGroupId) return;
  const wrapper = [...applicabilityTabsList.querySelectorAll(".applicability-tab-group")].find((item) => item.dataset.groupId === groupId);
  if (!wrapper) {
    closeGroupTabs();
    return;
  }
  closeGroupTabs(groupId);
  const panel = wrapper.querySelector(".applicability-tab-group__tabs");
  const bounds = wrapper.getBoundingClientRect();
  const panelBounds = panel.getBoundingClientRect();
  panel.style.left = `${Math.max(8, Math.min(bounds.left, window.innerWidth - panelBounds.width - 8))}px`;
  panel.style.top = `${Math.max(8, Math.min(bounds.bottom, window.innerHeight - panelBounds.height - 8))}px`;
};

const renderTabs = () => {
  applicabilityTabsList.replaceChildren();
  const groupContainers = new Map();
  tabs.forEach((tab, index) => {
    let container = applicabilityTabsList;
    const group = tabGroups.find((item) => item.id === tab.groupId);
    if (group) {
      if (!groupContainers.has(group.id)) {
        const wrapper = document.createElement("div");
        wrapper.className = "applicability-tab-group";
        wrapper.classList.toggle("is-active", getActiveTab()?.groupId === group.id);
        wrapper.dataset.groupId = group.id;
        wrapper.setAttribute("role", "group");
        wrapper.setAttribute("aria-label", group.name);
        const header = document.createElement("button");
        header.type = "button";
        header.className = "applicability-tab-group__header";
        header.dataset.groupHeaderId = group.id;
        header.draggable = true;
        header.classList.toggle("is-dragging", draggedGroupId === group.id);
        header.title = `${group.name}. Двойной щелчок — переименовать группу.`;
        header.setAttribute("aria-label", group.name);
        header.setAttribute("aria-expanded", "false");
        const panel = document.createElement("div");
        panel.className = "applicability-tab-group__tabs";
        panel.id = `applicability-group-tabs-${groupContainers.size}`;
        panel.hidden = true;
        header.setAttribute("aria-controls", panel.id);
        const icon = document.createElement("img");
        icon.src = "/applicability-group.png";
        icon.alt = "";
        icon.draggable = false;
        const name = document.createElement("span");
        name.textContent = group.name;
        header.append(icon, name);
        wrapper.append(header, panel);
        applicabilityTabsList.append(wrapper);
        groupContainers.set(group.id, panel);
      }
      container = groupContainers.get(group.id);
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = `search-tab${tab.id === activeTabId ? " active" : ""}`;
    button.dataset.tabId = tab.id;
    button.draggable = true;
    button.classList.toggle("is-dragging", draggedTabId === tab.id);
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(tab.id === activeTabId));
    const status = document.createElement("span");
    const isCompleted = tab.searches.some((entry) => entry.hasSearched && entry.results.length);
    status.className = `search-tab__status${isCompleted ? " is-completed" : ""}`;
    status.setAttribute("aria-hidden", "true");
    const title = document.createElement("span");
    title.className = "search-tab__title";
    const tabTitle = tab.name || `Новая применимость ${index + 1}`;
    title.textContent = tabTitle;
    button.title = tabTitle;
    button.setAttribute("aria-label", tabTitle);
    const close = document.createElement("span");
    close.className = "search-tab__close";
    close.dataset.closeTabId = tab.id;
    close.setAttribute("aria-label", "Закрыть вкладку");
    close.textContent = "×";
    button.append(status, title, close);
    container.append(button);
  });
  if (expandedGroupId) openGroupTabs(expandedGroupId);
};

applicabilityTabsList.addEventListener("pointerover", (event) => {
  const wrapper = event.target.closest(".applicability-tab-group");
  if (wrapper) openGroupTabs(wrapper.dataset.groupId);
  else if (!draggedTabId && !draggedGroupId) closeGroupTabs();
});
applicabilityTabsList.addEventListener("pointerout", (event) => {
  const wrapper = event.target.closest(".applicability-tab-group");
  const keyboardFocus = wrapper?.contains(document.activeElement) && document.activeElement.matches(":focus-visible");
  if (!draggedTabId && !draggedGroupId && wrapper && !wrapper.contains(event.relatedTarget) && !keyboardFocus) closeGroupTabs();
});
applicabilityTabsList.addEventListener("focusin", (event) => {
  const wrapper = event.target.closest(".applicability-tab-group");
  if (wrapper) openGroupTabs(wrapper.dataset.groupId);
  else closeGroupTabs();
});
applicabilityTabsList.addEventListener("focusout", (event) => {
  const wrapper = event.target.closest(".applicability-tab-group");
  if (wrapper && !wrapper.contains(event.relatedTarget) && !wrapper.matches(":hover")) closeGroupTabs();
});
applicabilityTabsList.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && expandedGroupId) {
    event.preventDefault();
    event.target.closest(".applicability-tab-group")?.querySelector(".applicability-tab-group__header").focus();
    closeGroupTabs();
  }
});
applicabilityTabsList.addEventListener("scroll", () => { if (expandedGroupId) openGroupTabs(expandedGroupId); });
window.addEventListener("resize", () => { if (expandedGroupId) openGroupTabs(expandedGroupId); });

const clearTabDropTarget = () => {
  tabDropTarget?.classList.remove("is-group-drop-target", "is-reorder-target", "is-reorder-before", "is-reorder-after");
  tabDropTarget = null;
  tabDropFeedback.hidden = true;
  tabDropFeedback.textContent = "";
};

const tabAtDropTarget = (element) => {
  const tabButton = element.closest("[data-tab-id]");
  if (tabButton && applicabilityTabsList.contains(tabButton)) return tabs.find((tab) => tab.id === tabButton.dataset.tabId);
  const wrapper = element.closest(".applicability-tab-group");
  if (wrapper && applicabilityTabsList.contains(wrapper)) return tabs.find((tab) => tab.groupId === wrapper.dataset.groupId);
  return null;
};

const tabDropAction = (element, event) => {
  const source = tabs.find((tab) => tab.id === draggedTabId);
  if (!source || !applicabilityTabs.contains(element)) return null;
  const target = tabAtDropTarget(element);
  if (target) {
    if (source === target) return null;
    const anchor = element.closest("[data-tab-id], [data-group-header-id]") ?? element.closest(".applicability-tab-group").querySelector("[data-group-header-id]");
    const targetBounds = anchor.getBoundingClientRect();
    const isTab = anchor.matches("[data-tab-id]");
    const before = isTab && (target.groupId
      ? event.clientY < targetBounds.top + targetBounds.height / 2
      : event.clientX < targetBounds.left + targetBounds.width / 2);
    const position = before ? "before" : "after";
    const sameGroup = source.groupId === (target.groupId ?? null);
    if (isTab && sameGroup && (source.groupId || event.clientX < targetBounds.left + targetBounds.width * 0.3 || event.clientX > targetBounds.right - targetBounds.width * 0.3)) {
      return { type: "reorder-tab", target, position, anchor };
    }
    return { type: "group", target, anchor };
  }
  if (source.groupId && !element.closest(".applicability-tab-group, #applicability-new-tab")) {
    return { type: "ungroup", anchor: tabUngroupDrop };
  }
  return null;
};

const groupDropAction = (element, event) => {
  const source = tabGroups.find((group) => group.id === draggedGroupId);
  if (!source || !applicabilityTabs.contains(element)) return null;
  let anchor = element.closest(".applicability-tab-group, [data-tab-id]");
  if (anchor?.closest(".applicability-tab-group")) anchor = anchor.closest(".applicability-tab-group");
  if (!anchor) {
    const items = [...applicabilityTabsList.children].filter((item) => item.dataset.groupId !== source.id);
    anchor = items.find((item) => {
      const bounds = item.getBoundingClientRect();
      return event.clientX < bounds.left + bounds.width / 2;
    }) ?? items.at(-1);
  }
  const target = anchor && tabAtDropTarget(anchor);
  if (!target || target.groupId === source.id) return null;
  const bounds = anchor.getBoundingClientRect();
  return {
    type: "reorder-group",
    targetTabId: target.id,
    position: event.clientX < bounds.left + bounds.width / 2 ? "before" : "after",
    anchor,
  };
};

applicabilityTabsList.addEventListener("dragstart", (event) => {
  const header = event.target.closest("[data-group-header-id]");
  if (header) {
    if (!event.dataTransfer) {
      event.preventDefault();
      return;
    }
    draggedGroupId = header.dataset.groupHeaderId;
    closeGroupTabs();
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", draggedGroupId);
    header.classList.add("is-dragging");
    hideTabContextMenu();
    return;
  }
  const button = event.target.closest("[data-tab-id]");
  if (!button || !event.dataTransfer || event.target.closest("[data-close-tab-id]")) {
    event.preventDefault();
    return;
  }
  draggedTabId = button.dataset.tabId;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", draggedTabId);
  button.classList.add("is-dragging");
  tabUngroupDrop.hidden = !tabs.find((tab) => tab.id === draggedTabId)?.groupId;
  hideTabContextMenu();
});
applicabilityTabs.addEventListener("dragover", (event) => {
  if (!draggedTabId && !draggedGroupId) return;
  const hoveredGroup = event.target.closest(".applicability-tab-group");
  if (draggedTabId && hoveredGroup) openGroupTabs(hoveredGroup.dataset.groupId);
  const action = draggedGroupId ? groupDropAction(event.target, event) : tabDropAction(event.target, event);
  if (!action) {
    clearTabDropTarget();
    return;
  }
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  const { anchor } = action;
  if (tabDropTarget !== anchor) {
    clearTabDropTarget();
    tabDropTarget = anchor;
  }
  const isReorder = action.type === "reorder-tab" || action.type === "reorder-group";
  anchor.classList.toggle("is-group-drop-target", !isReorder);
  anchor.classList.toggle("is-reorder-target", isReorder);
  anchor.classList.toggle("is-reorder-before", isReorder && action.position === "before");
  anchor.classList.toggle("is-reorder-after", isReorder && action.position === "after");
  const group = action.type === "group" ? tabGroups.find((item) => item.id === action.target.groupId) : null;
  tabDropFeedback.textContent = action.type === "ungroup"
    ? "Отпустите, чтобы вынести вкладку из группы"
    : action.type === "reorder-tab" ? `Переместить вкладку ${action.position === "before" ? "перед" : "после"} выбранной`
      : action.type === "reorder-group" ? `Переместить группу ${action.position === "before" ? "перед" : "после"} выбранной`
        : group ? `Добавить вкладку в группу «${group.name}»` : "Отпустите вкладку, чтобы создать группу";
  tabDropFeedback.hidden = false;
  const bounds = applicabilityTabsList.getBoundingClientRect();
  if (event.clientX > bounds.right - 28) applicabilityTabsList.scrollLeft += 12;
  else if (event.clientX < bounds.left + 28) applicabilityTabsList.scrollLeft -= 12;
});
applicabilityTabs.addEventListener("dragleave", (event) => {
  if (!event.relatedTarget || !applicabilityTabs.contains(event.relatedTarget)) clearTabDropTarget();
});
applicabilityTabs.addEventListener("drop", (event) => {
  const action = draggedGroupId ? groupDropAction(event.target, event) : tabDropAction(event.target, event);
  if (!action) return;
  event.preventDefault();
  syncActiveTab();
  const group = action.type === "group" ? moveApplicabilityTabIntoGroup(tabs, tabGroups, draggedTabId, action.target.id, () => ({
    id: `applicability-group-${Date.now()}-${tabSequence++}`,
    name: `Группа ${groupSequence++}`,
  })) : null;
  const reorderedTab = action.type === "reorder-tab" && moveApplicabilityTabRelative(tabs, tabGroups, draggedTabId, action.target.id, action.position);
  const reorderedGroup = action.type === "reorder-group" && moveApplicabilityGroupRelative(tabs, tabGroups, draggedGroupId, action.targetTabId, action.position);
  const removedFromGroup = action.type === "ungroup" && moveApplicabilityTabOutOfGroup(tabs, tabGroups, draggedTabId);
  clearTabDropTarget();
  draggedTabId = null;
  draggedGroupId = null;
  tabUngroupDrop.hidden = true;
  if (!group && !reorderedTab && !reorderedGroup && !removedFromGroup) return;
  pruneApplicabilityGroups();
  renderTabs();
  updateListButton(getActiveTab());
  saveApplicabilityState();
  showApplicabilityToast(
    group ? `Вкладка добавлена в группу «${group.name}».` : reorderedTab ? "Вкладка перемещена." : reorderedGroup ? "Группа перемещена." : "Вкладка вынесена из группы.",
    "success",
  );
});
applicabilityTabs.addEventListener("dragend", () => {
  clearTabDropTarget();
  draggedTabId = null;
  draggedGroupId = null;
  tabUngroupDrop.hidden = true;
  applicabilityTabsList.querySelectorAll(".is-dragging").forEach((button) => button.classList.remove("is-dragging"));
  closeGroupTabs();
});
applicabilityTabsList.addEventListener("dblclick", (event) => {
  const header = event.target.closest("[data-group-header-id]");
  if (header) openGroupNameModal(header.dataset.groupHeaderId, header);
});

const syncActiveTab = () => {
  const tab = getActiveTab();
  if (!tab) return;
  tab.sku = skuInput.value.trim();
  tab.makeNames = selectedMakeNames(tab);
  tab.makeName = tab.makeNames[0] ?? "";
  tab.makeId = selectedMakes(tab)[0]?.id ?? null;
};

const renderActiveTab = () => {
  const tab = getActiveTab();
  if (!tab) return;
  cancelCachedLookup();
  skuInput.value = tab.sku;
  makeInput.value = "";
  renderSelectedMakes();
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
  if ((fileImportRequest && (fileImportTargets.size ? [...fileImportTargets.values()].includes(tabId) : fileImportTabId === tabId))
    || (!fileImportRequest && activeTabId === tabId)) activeRequest?.abort();
  tabs.splice(index, 1);
  pruneApplicabilityGroups();
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
    makeMatcher = createApplicabilityMakeMatcher([...makes.values()].map((make) => make.name));
  } catch {
    setFeedback("Не удалось загрузить список брендов. Обновите страницу и повторите попытку.");
  }
};

markupTab.addEventListener("click", () => setActiveFunction("markup"));
applicabilityTab.addEventListener("click", () => setActiveFunction("applicability"));
newApplicabilityTabButton.addEventListener("click", addTab);
listButton.addEventListener("click", () => openDocumentModal());
multiListButton.addEventListener("click", openGroupDocument);
closeArticleNameButtons.forEach((button) => button.addEventListener("click", () => closeArticleNameModal()));
articleNameForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const tab = tabs.find((item) => item.id === articleNameModalTabId);
  const group = tabGroups.find((item) => item.id === articleNameModalGroupId);
  const articleName = group ? normalizeApplicabilityGroupName(articleNameInput.value) : normalizeTabName(articleNameInput.value);
  if ((!tab && !group) || !articleName) {
    articleNameInput.setCustomValidity(group ? "Введите название группы." : "Введите наименование исходного артикула.");
    articleNameInput.reportValidity();
    return;
  }
  articleNameInput.setCustomValidity("");
  const returnFocus = articleNameModalReturnFocus;
  const shouldOpenDocument = openDocumentAfterArticleNaming;
  if (group) group.name = articleName;
  else tab.name = articleName;
  renderTabs();
  updateListButton(getActiveTab());
  saveApplicabilityState();
  closeArticleNameModal(false);
  if (shouldOpenDocument) openDocumentModal(tab, returnFocus);
  else if (returnFocus?.isConnected) returnFocus.focus();
  else {
    const anchor = [...applicabilityTabsList.querySelectorAll("[data-group-header-id], [data-tab-id]")]
      .find((element) => group ? element.dataset.groupHeaderId === group.id : element.dataset.tabId === tab.id);
    anchor?.focus();
  }
});
articleNameInput.addEventListener("input", () => articleNameInput.setCustomValidity(""));
closeDocumentButtons.forEach((button) => button.addEventListener("click", () => closeDocumentModal()));
documentSaveButton.addEventListener("click", async () => {
  try {
    await saveApplicabilityDocument();
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    showApplicabilityToast("Не удалось сохранить список.", "error");
  }
});
documentFormatButtons.forEach((button) => button.addEventListener("click", () => {
  const format = button.dataset.applicabilityDocumentFormat;
  if (format !== "raw" && format !== "structured") return;
  documentFormat = format;
  documentFormatControl.open = false;
  renderApplicabilityDocument({ preserveTextState: true });
}));
documentColumnInputs.forEach((input) => input.addEventListener("change", () => {
  if (!documentColumnInputs.some((column) => column.checked)) input.checked = true;
  renderApplicabilityDocument({ preserveTextState: true });
}));
settingsToggle.addEventListener("click", () => {
  settingsDrawer.hidden = false;
  loadApiKeyState();
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
    applyApiKeyState(state);
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
  const header = event.target.closest("[data-group-header-id]");
  if (header && getActiveTab()?.groupId !== header.dataset.groupHeaderId) {
    const firstTab = tabs.find((item) => item.groupId === header.dataset.groupHeaderId);
    if (firstTab) activateTab(firstTab.id);
  }
});

const hideTabContextMenu = (restoreFocus = false) => {
  tabContextMenu.hidden = true;
  contextMenuTabId = null;
  contextMenuGroupId = null;
  if (restoreFocus && contextMenuTabAnchor?.isConnected) contextMenuTabAnchor.focus();
  contextMenuTabAnchor = null;
};

const showTabContextMenu = (anchor, clientX, clientY) => {
  contextMenuTabId = anchor.dataset.tabId ?? null;
  contextMenuGroupId = anchor.dataset.groupHeaderId ?? null;
  renameTabButton.textContent = contextMenuGroupId ? "Переименовать группу" : "Переименовать вкладку";
  removeFromGroupButton.hidden = !tabs.find((tab) => tab.id === contextMenuTabId)?.groupId;
  dissolveGroupButton.hidden = !contextMenuGroupId;
  contextMenuTabAnchor = anchor;
  tabContextMenu.hidden = false;
  const bounds = tabContextMenu.getBoundingClientRect();
  tabContextMenu.style.left = `${Math.max(8, Math.min(clientX, window.innerWidth - bounds.width - 8))}px`;
  tabContextMenu.style.top = `${Math.max(8, Math.min(clientY, window.innerHeight - bounds.height - 8))}px`;
  renameTabButton.focus();
};

const renameTab = (tabId, returnFocus) => {
  const tab = tabs.find((item) => item.id === tabId);
  if (!tab) return;
  openArticleNameModal(tab.id, { returnFocus });
};

applicabilityTabsList.addEventListener("contextmenu", (event) => {
  const anchor = event.target.closest("[data-tab-id], [data-group-header-id]");
  if (!anchor) return;
  event.preventDefault();
  showTabContextMenu(anchor, event.clientX, event.clientY);
});

applicabilityTabsList.addEventListener("keydown", (event) => {
  if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
  const anchor = event.target.closest("[data-tab-id], [data-group-header-id]");
  if (!anchor) return;
  event.preventDefault();
  const bounds = anchor.getBoundingClientRect();
  showTabContextMenu(anchor, bounds.left + 16, bounds.top + 16);
});

renameTabButton.addEventListener("click", () => {
  const tabId = contextMenuTabId;
  const groupId = contextMenuGroupId;
  const returnFocus = contextMenuTabAnchor;
  hideTabContextMenu();
  if (groupId) openGroupNameModal(groupId, returnFocus);
  else if (tabId) renameTab(tabId, returnFocus);
});

removeFromGroupButton.addEventListener("click", () => {
  const tab = tabs.find((item) => item.id === contextMenuTabId);
  hideTabContextMenu();
  if (!tab?.groupId) return;
  tab.groupId = null;
  pruneApplicabilityGroups();
  renderTabs();
  updateListButton(getActiveTab());
  saveApplicabilityState();
});
dissolveGroupButton.addEventListener("click", () => {
  const groupId = contextMenuGroupId;
  hideTabContextMenu();
  if (!groupId) return;
  tabs.forEach((tab) => { if (tab.groupId === groupId) tab.groupId = null; });
  pruneApplicabilityGroups();
  renderTabs();
  updateListButton(getActiveTab());
  saveApplicabilityState();
});

const hideResultContextMenu = (restoreFocus = false) => {
  resultContextMenu.hidden = true;
  if (restoreFocus && contextMenuEntryAnchor?.isConnected) contextMenuEntryAnchor.focus();
  contextMenuEntryAnchor = null;
};

const showResultContextMenu = (entryId, clientX, clientY, anchor) => {
  contextMenuEntryAnchor = anchor;
  deleteResultButton.textContent = selectedEntryIds.size > 1
    ? `Удалить строки (${selectedEntryIds.size})`
    : "Удалить строку";
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
  const entryId = row.dataset.applicabilityEntryId;
  if (!selectedEntryIds.has(entryId)) selectResultEntry(entryId);
  showResultContextMenu(entryId, event.clientX, event.clientY, row);
});

deleteResultButton.addEventListener("click", () => {
  hideResultContextMenu();
  deleteSelectedResults();
});

resultsBody.addEventListener("click", (event) => {
  const expandButton = event.target.closest("[data-expand-entry-id]");
  if (expandButton) {
    const tab = getActiveTab();
    const entry = tab?.searches.find((item) => item.id === expandButton.dataset.expandEntryId);
    if (!tab || !entry || !entry.results.length) return;
    entry.expanded = !entry.expanded;
    renderResults(tab);
    saveApplicabilityState();
    return;
  }
  const row = event.target.closest("tr[data-applicability-entry-id]");
  if (!row || row.classList.contains("applicability-raw-row")) return;
  selectResultEntry(row.dataset.applicabilityEntryId, {
    additive: event.ctrlKey || event.metaKey,
    range: event.shiftKey,
  });
});

resultsBody.addEventListener("keydown", (event) => {
  if (event.key !== "Delete" || !selectedEntryIds.size) return;
  event.preventDefault();
  deleteSelectedResults();
});

skuInput.addEventListener("input", () => {
  syncActiveTab();
  saveApplicabilityState();
  cancelCachedLookup();
  cachedBrandLookupTimer = window.setTimeout(() => {
    cachedBrandLookupTimer = null;
    void applyCachedBrand(skuInput.value.trim());
  }, 250);
});
makeInput.addEventListener("input", () => {
  activeMakeIndex = -1;
  renderMakeMenu();
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
    toggleMake(matches[activeMakeIndex]);
  }
});
makesMenu.addEventListener("click", (event) => {
  const option = event.target.closest("[data-make-name]");
  if (!option) return;
  const make = makesByName.get(option.dataset.makeName.toLocaleUpperCase());
  if (make) toggleMake(make);
});
selectedMakesContainer.addEventListener("click", (event) => {
  const chip = event.target.closest("[data-remove-make-name]");
  if (!chip) return;
  const removeName = chip.dataset.removeMakeName.toLocaleUpperCase();
  setSelectedMakeNames(selectedMakeNames().filter((name) => name.toLocaleUpperCase() !== removeName), { focus: true });
  renderMakeMenu();
});
document.addEventListener("click", (event) => {
  if (!event.target.closest(".applicability-make-picker")) closeMakeMenu();
  if (!documentFormatControl.contains(event.target)) documentFormatControl.open = false;
  if (!documentColumnsControl.contains(event.target)) documentColumnsControl.open = false;
  if (!tabContextMenu.hidden && !tabContextMenu.contains(event.target)) hideTabContextMenu();
  if (!resultContextMenu.hidden && !resultContextMenu.contains(event.target)) hideResultContextMenu();
});
document.addEventListener("keydown", (event) => {
  if (!fileImportModal.hidden) {
    if (event.key === "Escape") {
      closeFileImportModal();
      return;
    }
    if (event.key === "Tab") {
      const focusable = [...fileImportModal.querySelectorAll("button:not([disabled]), input:not([disabled])")]
        .filter((element) => element.offsetParent !== null);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && (document.activeElement === first || document.activeElement === fileImportModal)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
      return;
    }
  }
  if (!articleNameModal.hidden && event.key === "Tab") {
    const focusable = [...articleNameModal.querySelectorAll("button:not([disabled]), input:not([disabled]), [tabindex='0']")]
      .filter((element) => element.offsetParent !== null);
    if (!focusable.length) {
      event.preventDefault();
      articleNameModal.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement === articleNameModal)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
    return;
  }
  if (!documentModal.hidden && event.key === "Tab") {
    const focusable = [...documentModal.querySelectorAll("button:not([disabled]), input:not([disabled]), summary, textarea:not([disabled]), [tabindex='0']")]
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
  if (!articleNameModal.hidden) {
    closeArticleNameModal();
    return;
  }
  if (!documentModal.hidden) {
    closeDocumentModal();
    return;
  }
  if (!tabContextMenu.hidden) hideTabContextMenu(true);
  if (!resultContextMenu.hidden) hideResultContextMenu(true);
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (activeRequest) return;
  const tab = getActiveTab();
  if (!tab) return;
  syncActiveTab();
  const inputSku = tab.sku;
  let skus;
  try {
    skus = parseApplicabilitySkus(inputSku);
  } catch (error) {
    setFeedback(error.message);
    skuInput.focus();
    return;
  }
  if (!skus.length) return;
  if (skus.length === 1 && !selectedMakes().length) await applyCachedBrand(skus[0], { force: true });
  if (activeRequest || tab !== getActiveTab() || inputSku !== skuInput.value.trim()) return;
  const makes = selectedMakes();
  if (!makes.length) {
    setFeedback("Выберите хотя бы один бренд из списка.");
    makeInput.focus();
    return;
  }
  const pairs = skus.flatMap((sku) => makes.map((make) => ({ sku, brand: make.name })));
  const duplicatePairs = pairs.filter((pair) => duplicateSearch(tab, pair.sku, pair.brand));
  const requestedPairs = pairs.filter((pair) => !duplicateSearch(tab, pair.sku, pair.brand));
  if (duplicatePairs.length) {
    setFeedback("");
    showApplicabilityToast(
      duplicatePairs.length === 1
        ? `Артикул и бренд «${duplicatePairs[0].brand}» уже добавлены.`
        : "Некоторые пары «артикул + бренд» уже добавлены.",
      "error",
    );
  }
  if (!requestedPairs.length) return;
  const entries = requestedPairs.map((pair) => createSearchEntry({ sku: pair.sku, makeName: pair.brand, status: "Ищем применимость…" }));
  const controller = new AbortController();
  activeRequest = controller;
  fileImportButton.disabled = true;
  submitButton.disabled = true;
  submitButton.querySelector("span").textContent = "Ищем…";
  try {
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
    if (controller.signal.aborted) return;
    tab.searches.push(...entries);
    setFeedback("", "notice");
    renderResults(tab);
    renderTabs();
    saveApplicabilityState();
    const outcomes = await runApplicabilityBatch(entries,
      (entry, signal) => executeApplicabilitySearch(entry.sku, entry.makeName, signal), controller.signal);
    if (controller.signal.aborted) {
      tab.searches = tab.searches.filter((item) => !entries.includes(item));
      if (activeTabId === tab.id) renderResults(tab);
      renderTabs();
      saveApplicabilityState();
      return;
    }
    const failed = outcomes.filter((outcome) => outcome.error);
    const completed = outcomes.filter((outcome) => outcome.result);
    const normalizedOutcome = completed.find(({ result }) => result.usedNormalizedSku);
    const sku = normalizedOutcome?.entry.sku;
    completed.forEach(({ entry, result }) => applySearchResult(entry, result));
    if (failed.length) {
      tab.searches = tab.searches.filter((item) => !failed.some((outcome) => outcome.entry === item));
      const failure = (failed.find(({ error }) => error?.status === 401) ?? failed[0]).error;
      if (activeTabId === tab.id) {
        const message = failure instanceof Error ? failure.message : "Не удалось выполнить поиск применимости.";
        if (failure?.status === 401) {
          setFeedback("");
          showApplicabilityToast(message, "error");
        } else {
          setFeedback(message);
        }
      }
    }
    const cachedOutcome = completed.find(({ result }) => result.cacheHit);
    const keyAccessFailed = failed.some(({ error }) => error?.status === 401);
    if (!keyAccessFailed && normalizedOutcome) {
      showApplicabilityToast(
        normalizedOutcome.result.cacheHit
          ? `Артикул «${sku}» изменён на «${normalizedOutcome.result.normalizedSku}». Использован сохранённый результат из базы.`
          : `Артикул «${sku}» изменён на «${normalizedOutcome.result.normalizedSku}» и успешно найден.`,
        normalizedOutcome.result.cacheHit ? "success" : "notice",
      );
    } else if (!keyAccessFailed && cachedOutcome) {
      showApplicabilityToast("Использован сохранённый результат из базы.", "success");
    }
    if (activeTabId === tab.id) renderResults(tab);
    renderTabs();
    saveApplicabilityState();
  } catch (error) {
    tab.searches = tab.searches.filter((item) => !entries.includes(item));
    if (activeTabId === tab.id) renderResults(tab);
    renderTabs();
    saveApplicabilityState();
    if (error?.name !== "AbortError" && activeTabId === tab.id) setFeedback(error instanceof Error ? error.message : "Не удалось выполнить поиск применимости.");
  } finally {
    if (activeRequest === controller) {
      activeRequest = null;
      fileImportButton.disabled = false;
      submitButton.disabled = false;
      submitButton.querySelector("span").textContent = "Поиск";
      oemSidebar?.refresh();
    }
  }
});

restoreApplicabilityState();
if (!tabs.length) tabs.push(createTab());
if (!tabs.some((tab) => tab.id === activeTabId)) activeTabId = tabs[0].id;
oemSidebar = bootstrapApplicabilityOemSidebar({ addArticle: addSavedOemArticle, notify: showApplicabilityToast });
renderActiveTab();
const makesReady = loadMakes();
const apiKeyReady = loadApiKeyState();
try {
  if (localStorage.getItem(activeFunctionStorageKey) === "applicability") setActiveFunction("applicability");
} catch {
  // The selected function is a convenience preference.
}
