const form = document.querySelector("#search-form");
const articleInput = document.querySelector("#article-input");
const submitButton = document.querySelector("#submit-button");
const globalStatus = document.querySelector("#global-status");
const resultsBody = document.querySelector("#results-body");
const resultCount = document.querySelector("#result-count");
const resultsPanel = document.querySelector("#results-panel");
const resultsTable = document.querySelector("#results-table");
const resultsEmpty = document.querySelector("#results-empty");
const searchLoading = document.querySelector("#search-loading");
const sortButtons = [...document.querySelectorAll(".table-sort")];
const searchTabsList = document.querySelector("#search-tabs-list");
const newTabButton = document.querySelector("#new-tab-button");
const authStatus = document.querySelector("#auth-status");
const settingsToggle = document.querySelector("#settings-toggle");
const supplierEnabledInputs = [...document.querySelectorAll(".supplier-enabled-input")];
const suppliersDropdown = document.querySelector(".suppliers-dropdown");
const settingsDrawer = document.querySelector("#settings-drawer");
const settingsClose = document.querySelector("#settings-close");
const settingsBackdrop = document.querySelector("#settings-backdrop");
const rosskoAuthForm = document.querySelector("#rossko-auth-form");
const rosskoLoginInput = document.querySelector("#rossko-login");
const rosskoPasswordInput = document.querySelector("#rossko-password");
const rosskoConnectButton = document.querySelector("#rossko-connect-button");
const rosskoLogoutButton = document.querySelector("#rossko-logout-button");
const rosskoSessionPill = document.querySelector("#rossko-session-pill");
const rosskoAuthFeedback = document.querySelector("#rossko-auth-feedback");
const armtekAuthForm = document.querySelector("#armtek-auth-form");
const armtekLoginInput = document.querySelector("#armtek-login");
const armtekPasswordInput = document.querySelector("#armtek-password");
const armtekConnectButton = document.querySelector("#armtek-connect-button");
const armtekLogoutButton = document.querySelector("#armtek-logout-button");
const armtekSessionPill = document.querySelector("#armtek-session-pill");
const armtekAuthFeedback = document.querySelector("#armtek-auth-feedback");
const partKomAuthForm = document.querySelector("#part-kom-auth-form");
const partKomLoginInput = document.querySelector("#part-kom-login");
const partKomPasswordInput = document.querySelector("#part-kom-password");
const partKomConnectButton = document.querySelector("#part-kom-connect-button");
const partKomLogoutButton = document.querySelector("#part-kom-logout-button");
const partKomSessionPill = document.querySelector("#part-kom-session-pill");
const partKomAuthFeedback = document.querySelector("#part-kom-auth-feedback");
const stpartsAuthForm = document.querySelector("#stparts-auth-form");
const stpartsLoginInput = document.querySelector("#stparts-login");
const stpartsPasswordInput = document.querySelector("#stparts-password");
const stpartsConnectButton = document.querySelector("#stparts-connect-button");
const stpartsLogoutButton = document.querySelector("#stparts-logout-button");
const stpartsSessionPill = document.querySelector("#stparts-session-pill");
const stpartsAuthFeedback = document.querySelector("#stparts-auth-feedback");
const motorDetalAuthForm = document.querySelector("#motordetal-auth-form");
const motorDetalLoginInput = document.querySelector("#motordetal-login");
const motorDetalPasswordInput = document.querySelector("#motordetal-password");
const motorDetalConnectButton = document.querySelector("#motordetal-connect-button");
const motorDetalLogoutButton = document.querySelector("#motordetal-logout-button");
const motorDetalSessionPill = document.querySelector("#motordetal-session-pill");
const motorDetalAuthFeedback = document.querySelector("#motordetal-auth-feedback");
const mladovAuthForm = document.querySelector("#mladov-auth-form");
const mladovLoginInput = document.querySelector("#mladov-login");
const mladovPasswordInput = document.querySelector("#mladov-password");
const mladovConnectButton = document.querySelector("#mladov-connect-button");
const mladovLogoutButton = document.querySelector("#mladov-logout-button");
const mladovSessionPill = document.querySelector("#mladov-session-pill");
const mladovAuthFeedback = document.querySelector("#mladov-auth-feedback");

let searchTabs = [];
let activeTabId = null;
let tabSequence = 1;
let results = [];
let sortState = { key: "price", direction: "ascending" };

const searchStateStorageKey = "autoservice.searchState";

const supplierNames = {
  rossko: "Rossko",
  armtek: "Armtek",
  "part-kom": "Part-Kom",
  stparts: "STParts",
  motordetal: "MotorDetal",
  mladov: "Механик Ладов",
};

const supplierSearchToggles = Object.fromEntries(
  supplierEnabledInputs.map((input) => [input.value, input.closest(".supplier-search-toggle")]),
);

const getEnabledSuppliers = () => supplierEnabledInputs.filter((input) => input.checked).map((input) => input.value);

const updateSupplierSearchToggle = (supplier, authorized) => {
  const input = supplierEnabledInputs.find((candidate) => candidate.value === supplier);
  const toggle = supplierSearchToggles[supplier];

  if (!input || !toggle) {
    return;
  }

  toggle.hidden = !authorized;

  if (!authorized) {
    input.checked = false;
  }
};

const createSearchTab = (data = {}) => ({
  id: data.id ?? `tab-${Date.now()}-${tabSequence++}`,
  article: typeof data.article === "string" ? data.article : "",
  enabledSuppliers: Array.isArray(data.enabledSuppliers) ? data.enabledSuppliers : getEnabledSuppliers(),
  status: typeof data.status === "string" && data.status !== "Ожидание поиска" ? data.status : "",
  results: Array.isArray(data.results) ? data.results : [],
  hasSearched:
    typeof data.hasSearched === "boolean"
      ? data.hasSearched
      : Boolean(data.results?.length) || Boolean(data.status && data.status !== "Ожидание поиска"),
  source: null,
});

const getActiveTab = () => searchTabs.find((tab) => tab.id === activeTabId);
const getNewSearchTab = () => searchTabs.find((tab) => !tab.hasSearched && !tab.source);

const setSearchUiState = (isSearching) => {
  const hasSearched = Boolean(getActiveTab()?.hasSearched);
  submitButton.disabled = isSearching;
  articleInput.disabled = isSearching;
  supplierEnabledInputs.forEach((input) => {
    input.disabled = isSearching;
  });
  resultsPanel.classList.toggle("is-searching", isSearching);
  resultsPanel.setAttribute("aria-busy", String(isSearching));
  searchLoading.hidden = !isSearching;
  resultsEmpty.hidden = isSearching || hasSearched;
  resultsTable.hidden = isSearching || !hasSearched;
  resultCount.hidden = isSearching || !hasSearched;
};

const syncActiveTab = () => {
  const tab = getActiveTab();

  if (!tab) {
    return;
  }

  tab.article = articleInput.value;
  tab.enabledSuppliers = getEnabledSuppliers();
  tab.status = globalStatus.textContent;
  tab.results = results;
};

const sessionPillStatus = (authorized) => (authorized ? "completed" : "idle");
const sessionPillText = (authorized) => (authorized ? "Подключен" : "Не подключен");

const formatDeliveryDate = (value, approximate = false, valueTo = null) => {
  if (!value) {
    return "Не указана";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return `${approximate ? "~" : ""}${value}`;
  }

  const formattedFrom = parsed.toLocaleDateString("ru-RU");
  const parsedTo = valueTo ? new Date(valueTo) : null;
  const formattedTo = parsedTo && !Number.isNaN(parsedTo.getTime()) ? ` - ${parsedTo.toLocaleDateString("ru-RU")}` : "";

  return `${approximate ? "~" : ""}${formattedFrom}${formattedTo}`;
};

const formatWarehouse = (value) => {
  const normalized = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";

  if (!normalized || normalized.length > 80 || /возврат|требован|упаков|установ|поставщик|не подлежат/i.test(normalized)) {
    return "-";
  }

  return normalized;
};

const formatWarehouseFull = (value) => {
  const normalized = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return normalized && normalized.length <= 300 ? normalized : "-";
};

const escapeHtml = (value) => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");

const getSafeResultLink = (value) => {
  try {
    const url = new URL(String(value));
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : "";
  } catch {
    return "";
  }
};

const renderWarehouse = (result) => {
  const warehouse = formatWarehouse(result.warehouse);
  const warehouseFull = formatWarehouseFull(result.warehouseFull);
  const tooltip = warehouseFull !== "-" && warehouseFull !== warehouse
    ? ` data-tooltip="${escapeHtml(warehouseFull)}" tabindex="0"`
    : "";

  if (warehouse === "-") {
    return warehouse;
  }

  if (result.supplier !== "stparts") {
    return `<span class="warehouse-code"${tooltip}>${escapeHtml(warehouse)}</span>`;
  }

  const color = ["green", "blue", "red"].includes(result.warehouseColor) ? result.warehouseColor : "";
  const rating = typeof result.warehouseRating === "string" && /^<?\d(?:\.\d)?$/.test(result.warehouseRating)
    ? result.warehouseRating.replace("<", "&lt;")
    : "";
  const ratingMarkup = rating ? `<span class="warehouse-rating">${rating}<span class="warehouse-rating__star" aria-hidden="true">★</span></span>` : "";

  return `<span class="warehouse-code${color ? ` warehouse-code--${color}` : ""}"${tooltip}>${escapeHtml(warehouse)}</span>${ratingMarkup}`;
};

const resultCollator = new Intl.Collator("ru", { numeric: true, sensitivity: "base" });

const getSortValue = (result, key) => {
  if (key === "supplier") {
    return supplierNames[result.supplier] ?? result.supplier;
  }

  if (key === "deliveryDate") {
    const timestamp = result.deliveryDate ? new Date(result.deliveryDate).getTime() : Number.NaN;
    return Number.isNaN(timestamp) ? null : timestamp;
  }

  return result[key];
};

const compareSortValues = (leftValue, rightValue) => {
  const leftMissing = leftValue === null || leftValue === undefined || leftValue === "";
  const rightMissing = rightValue === null || rightValue === undefined || rightValue === "";

  if (leftMissing || rightMissing) {
    return leftMissing === rightMissing ? 0 : leftMissing ? 1 : -1;
  }

  return typeof leftValue === "number" && typeof rightValue === "number"
    ? leftValue - rightValue
    : resultCollator.compare(String(leftValue), String(rightValue));
};

const compareResults = (left, right) => {
  const leftValue = getSortValue(left, sortState.key);
  const rightValue = getSortValue(right, sortState.key);
  let comparison = compareSortValues(leftValue, rightValue);

  if (comparison === 0 && sortState.key === "deliveryDate") {
    comparison = compareSortValues(
      getSortValue({ deliveryDate: left.deliveryDateTo ?? left.deliveryDate }, "deliveryDate"),
      getSortValue({ deliveryDate: right.deliveryDateTo ?? right.deliveryDate }, "deliveryDate"),
    );
  }

  return sortState.direction === "ascending" ? comparison : -comparison;
};

const updateSortHeaders = () => {
  sortButtons.forEach((button) => {
    const isActive = button.dataset.sortKey === sortState.key;
    const direction = isActive ? sortState.direction : "none";
    button.classList.toggle("is-active", isActive);
    button.closest("th").setAttribute("aria-sort", direction);
    button.title = isActive
      ? `Сортировка ${direction === "ascending" ? "по возрастанию" : "по убыванию"}. Нажмите, чтобы изменить`
      : "Сортировать по столбцу";
  });
};

const updateResultCount = (items) => {
  const supplierCounts = items.reduce((counts, result) => {
    counts[result.supplier] = (counts[result.supplier] ?? 0) + 1;
    return counts;
  }, {});
  const breakdown = Object.entries(supplierCounts)
    .map(([supplier, count]) => `${supplierNames[supplier] ?? supplier}: ${count} позиций`)
    .join("\n");

  resultCount.textContent = `${items.length} позиций`;
  resultCount.dataset.tooltip = breakdown;
  resultCount.setAttribute("aria-label", breakdown ? `По поставщикам:\n${breakdown}` : "Нет результатов");
};

const saveSearchState = () => {
  try {
    syncActiveTab();
    localStorage.setItem(
      searchStateStorageKey,
      JSON.stringify({
        activeTabId,
        tabs: searchTabs.map((tab) => ({
          id: tab.id,
          article: tab.article,
          enabledSuppliers: tab.enabledSuppliers,
          status: tab.status,
          results: tab.results,
          hasSearched: tab.hasSearched,
        })),
      }),
    );
  } catch {
    // Search state is a convenience cache; the app should keep working if storage is unavailable.
  }
};

const restoreSearchState = () => {
  try {
    const rawState = localStorage.getItem(searchStateStorageKey);

    if (!rawState) {
      return;
    }

    const state = JSON.parse(rawState);

    if (Array.isArray(state.tabs) && state.tabs.length) {
      searchTabs = state.tabs.map((tab) => createSearchTab(tab));
      activeTabId = searchTabs.some((tab) => tab.id === state.activeTabId) ? state.activeTabId : searchTabs[0].id;
    } else {
      searchTabs = [
        createSearchTab({
          article: state.article,
          enabledSuppliers: state.enabledSuppliers,
          status: state.status,
          results: state.results,
          hasSearched: state.hasSearched,
        }),
      ];
      activeTabId = searchTabs[0].id;
    }
  } catch {
    localStorage.removeItem(searchStateStorageKey);
  }
};

const renderTabs = () => {
  newTabButton.hidden = Boolean(getNewSearchTab());
  searchTabsList.innerHTML = searchTabs
    .map((tab, index) => {
      const statusClass = tab.source ? "is-searching" : tab.results.length ? "is-completed" : "";
      const title = tab.article || `Новый поиск ${index + 1}`;

      return `
       <button type="button" class="search-tab ${tab.id === activeTabId ? "active" : ""}" data-tab-id="${escapeHtml(tab.id)}" role="tab" aria-selected="${tab.id === activeTabId}">
          <span class="search-tab__status ${statusClass}"></span>${escapeHtml(title)}
           <span class="search-tab__close" data-close-tab-id="${escapeHtml(tab.id)}" aria-label="Закрыть вкладку">×</span>
        </button>
      `;
    })
    .join("");
};

const activateTab = (tabId) => {
  const tab = searchTabs.find((item) => item.id === tabId);

  if (!tab || tab.id === activeTabId) {
    return;
  }

  syncActiveTab();
  activeTabId = tab.id;
  results = tab.results;
  articleInput.value = tab.article;
  globalStatus.textContent = tab.status;
  supplierEnabledInputs.forEach((input) => {
    input.checked = tab.enabledSuppliers.includes(input.value);
  });
  setSearchUiState(Boolean(tab.source));
  renderTabs();
  renderResults();
  saveSearchState();
};

const closeTab = (tabId) => {
  const tabIndex = searchTabs.findIndex((tab) => tab.id === tabId);

  if (tabIndex === -1) {
    return;
  }

  syncActiveTab();
  const [tab] = searchTabs.splice(tabIndex, 1);
  if (tab.source) {
    tab.source.close();
  }

  if (!searchTabs.length) {
    const newTab = createSearchTab();
    searchTabs.push(newTab);
    activeTabId = null;
    renderTabs();
    activateTab(newTab.id);
    articleInput.focus();
    return;
  }

  if (tab.id === activeTabId) {
    const nextTab = searchTabs[Math.min(tabIndex, searchTabs.length - 1)];
    activeTabId = null;
    renderTabs();
    activateTab(nextTab.id);
    return;
  }

  renderTabs();
  saveSearchState();
};

const renderResults = () => {
  updateSortHeaders();

  if (!results.length) {
    resultsBody.innerHTML = `
      <tr class="results-table__empty">
        <td colspan="7">По вашему запросу ничего не найдено.</td>
      </tr>
    `;
    updateResultCount([]);
    return;
  }

  const sorted = [...results].sort(compareResults);
  const isSearching = Boolean(getActiveTab()?.source);
  resultsBody.innerHTML = sorted
    .map((result) => {
      const supplierName = supplierNames[result.supplier] ?? result.supplier;
      const link = getSafeResultLink(result.link);
      const deliveryDate = result.supplier === "mladov" && !result.deliveryDate
        ? "-"
        : formatDeliveryDate(result.deliveryDate, result.deliveryDateApproximate, result.deliveryDateTo);

      return `
        <tr class="results-table__row" data-link="${escapeHtml(link)}" tabindex="${isSearching ? "-1" : "0"}" aria-disabled="${isSearching}" aria-label="Открыть ${escapeHtml(result.title)}">
          <td>${escapeHtml(supplierName)}</td>
          <td>${escapeHtml(result.brand)}</td>
          <td>${escapeHtml(result.article)}</td>
           <td>${escapeHtml(result.title)}</td>
           <td>${renderWarehouse(result)}</td>
           <td>${escapeHtml(result.price.toLocaleString("ru-RU"))} ₽</td>
          <td>${escapeHtml(deliveryDate)}</td>
        </tr>
      `;
    })
    .join("");
  updateResultCount(sorted);
};

const resetSearchState = () => {
  results = [];
  const tab = getActiveTab();
  if (tab) {
    tab.results = results;
  }
  renderResults();
  saveSearchState();
};

const closeActiveSource = () => {
  const tab = getActiveTab();

  if (tab?.source) {
    tab.source.close();
    tab.source = null;
  }

  if (tab) {
    tab.source = null;
  }
};

const openSettings = () => {
  settingsDrawer.hidden = false;
};

const closeSettings = () => {
  settingsDrawer.hidden = true;
};

const updateRosskoSessionCard = (session) => {
  updateSupplierSearchToggle("rossko", session.authorized);
  rosskoSessionPill.dataset.status = sessionPillStatus(session.authorized);
  rosskoSessionPill.textContent = sessionPillText(session.authorized);
  rosskoAuthForm.dataset.authorized = String(session.authorized);
  rosskoConnectButton.hidden = session.authorized;
  rosskoLogoutButton.hidden = !session.authorized;
  rosskoAuthFeedback.textContent = "";
};

const updateArmtekSessionCard = (session) => {
  updateSupplierSearchToggle("armtek", session.authorized);
  armtekSessionPill.dataset.status = sessionPillStatus(session.authorized);
  armtekSessionPill.textContent = sessionPillText(session.authorized);
  armtekAuthForm.dataset.authorized = String(session.authorized);
  armtekConnectButton.hidden = session.authorized;
  armtekLogoutButton.hidden = !session.authorized;
  armtekAuthFeedback.textContent = "";
};

const updatePartKomSessionCard = (session) => {
  updateSupplierSearchToggle("part-kom", session.authorized);
  partKomSessionPill.dataset.status = sessionPillStatus(session.authorized);
  partKomSessionPill.textContent = sessionPillText(session.authorized);
  partKomAuthForm.dataset.authorized = String(session.authorized);
  partKomConnectButton.hidden = session.authorized;
  partKomLogoutButton.hidden = !session.authorized;
  partKomAuthFeedback.textContent = "";
};

const updateStpartsSessionCard = (session) => {
  updateSupplierSearchToggle("stparts", session.authorized);
  stpartsSessionPill.dataset.status = sessionPillStatus(session.authorized);
  stpartsSessionPill.textContent = sessionPillText(session.authorized);
  stpartsAuthForm.dataset.authorized = String(session.authorized);
  stpartsConnectButton.hidden = session.authorized;
  stpartsLogoutButton.hidden = !session.authorized;
  stpartsAuthFeedback.textContent = "";
};

const updateMotorDetalSessionCard = (session) => {
  updateSupplierSearchToggle("motordetal", session.authorized);
  motorDetalSessionPill.dataset.status = sessionPillStatus(session.authorized);
  motorDetalSessionPill.textContent = sessionPillText(session.authorized);
  motorDetalAuthForm.dataset.authorized = String(session.authorized);
  motorDetalConnectButton.hidden = session.authorized;
  motorDetalLogoutButton.hidden = !session.authorized;
  motorDetalAuthFeedback.textContent = "";
};

const updateMladovSessionCard = (session) => {
  updateSupplierSearchToggle("mladov", session.authorized);
  mladovSessionPill.dataset.status = sessionPillStatus(session.authorized);
  mladovSessionPill.textContent = sessionPillText(session.authorized);
  mladovAuthForm.dataset.authorized = String(session.authorized);
  mladovConnectButton.hidden = session.authorized;
  mladovLogoutButton.hidden = !session.authorized;
  mladovAuthFeedback.textContent = "";
};

const loadSessions = async () => {
  const response = await fetch("/api/suppliers/sessions");
  const payload = await response.json();
  const rosskoSession = payload.sessions.find((session) => session.supplier === "rossko");
  const armtekSession = payload.sessions.find((session) => session.supplier === "armtek");
  const partKomSession = payload.sessions.find((session) => session.supplier === "part-kom");
  const stpartsSession = payload.sessions.find((session) => session.supplier === "stparts");
  const motorDetalSession = payload.sessions.find((session) => session.supplier === "motordetal");
  const mladovSession = payload.sessions.find((session) => session.supplier === "mladov");

  if (rosskoSession) {
    updateRosskoSessionCard(rosskoSession);
  }

  if (armtekSession) {
    updateArmtekSessionCard(armtekSession);
  }

  if (partKomSession) {
    updatePartKomSessionCard(partKomSession);
  }

  if (stpartsSession) {
    updateStpartsSessionCard(stpartsSession);
  }

  if (motorDetalSession) {
    updateMotorDetalSessionCard(motorDetalSession);
  }

  if (mladovSession) {
    updateMladovSessionCard(mladovSession);
  }
};

const postJson = async (url, body) => {
  const response = await fetch(url, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.message ?? "Request failed");
  }

  return payload;
};

const handleAuthorizeResult = (session, feedbackElement, connectedMessage, rejectedMessage, updateSessionCard) => {
  updateSessionCard(session);

  if (session.authorized) {
    authStatus.textContent = connectedMessage;
    feedbackElement.textContent = "";
    return;
  }

  authStatus.textContent = "";
  feedbackElement.textContent = session.details ?? rejectedMessage;
};

const showAuthorizeError = (feedbackElement, error) => {
  authStatus.textContent = "";
  feedbackElement.textContent = error.message;
};

const clearAuthInputs = (...inputs) => {
  inputs.forEach((input) => {
    input.value = "";
  });
};

const openSearchStream = (url) => {
  const controller = new AbortController();
  const stream = {
    closed: false,
    onmessage: null,
    onerror: null,
    close() {
      this.closed = true;
      controller.abort();
    },
  };

  queueMicrotask(async () => {
    try {
      const response = await fetch(url, {
        headers: { Accept: "text/event-stream" },
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error(`Search stream returned HTTP ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (!stream.closed) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });

        let eventEnd = buffer.indexOf("\n\n");
        while (eventEnd !== -1) {
          const event = buffer.slice(0, eventEnd);
          buffer = buffer.slice(eventEnd + 2);
          const data = event
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");

          if (data) {
            stream.onmessage?.({ data });
          }

          eventEnd = buffer.indexOf("\n\n");
        }

        if (done) {
          break;
        }
      }

      if (!stream.closed) {
        stream.onerror?.(new Error("Search stream closed before completion"));
      }
    } catch (error) {
      if (!stream.closed) {
        stream.onerror?.(error);
      }
    }
  });

  return stream;
};

settingsToggle.addEventListener("click", openSettings);
settingsClose.addEventListener("click", closeSettings);
settingsBackdrop.addEventListener("click", closeSettings);
document.addEventListener("click", (event) => {
  if (suppliersDropdown.open && !suppliersDropdown.contains(event.target)) {
    suppliersDropdown.open = false;
  }
});

searchTabsList.addEventListener("click", (event) => {
  const closeButton = event.target.closest("[data-close-tab-id]");
  if (closeButton) {
    event.preventDefault();
    event.stopPropagation();
    closeTab(closeButton.dataset.closeTabId);
    return;
  }

  const tab = event.target.closest("[data-tab-id]");

  if (tab) {
    activateTab(tab.dataset.tabId);
  }
});

newTabButton.addEventListener("click", () => {
  syncActiveTab();

  const existingNewTab = getNewSearchTab();
  if (existingNewTab) {
    if (existingNewTab.id !== activeTabId) {
      activeTabId = null;
      activateTab(existingNewTab.id);
    }
    articleInput.focus();
    return;
  }

  const tab = createSearchTab();
  searchTabs.push(tab);
  activeTabId = null;
  renderTabs();
  activateTab(tab.id);
  articleInput.focus();
});

articleInput.addEventListener("input", saveSearchState);
supplierEnabledInputs.forEach((input) => input.addEventListener("change", saveSearchState));

sortButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const key = button.dataset.sortKey;
    sortState = {
      key,
      direction: sortState.key === key && sortState.direction === "ascending" ? "descending" : "ascending",
    };
    renderResults();
  });
});

resultsBody.addEventListener("click", (event) => {
  if (getActiveTab()?.source) {
    return;
  }

  const row = event.target.closest(".results-table__row");

  if (row?.dataset.link) {
    window.open(row.dataset.link, "_blank", "noreferrer");
  }
});

resultsBody.addEventListener("keydown", (event) => {
  if (getActiveTab()?.source) {
    return;
  }

  if (event.key !== "Enter" && event.key !== " ") {
    return;
  }

  const row = event.target.closest(".results-table__row");

  if (row?.dataset.link) {
    event.preventDefault();
    window.open(row.dataset.link, "_blank", "noreferrer");
  }
});

rosskoAuthForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  try {
    authStatus.textContent = "Подключаем Rossko";
    const payload = await postJson("/api/suppliers/rossko/authorize", {
      login: rosskoLoginInput.value.trim(),
      password: rosskoPasswordInput.value.trim(),
    });
    handleAuthorizeResult(payload.session, rosskoAuthFeedback, "Rossko подключен", "Rossko отклонил авторизацию", updateRosskoSessionCard);
  } catch (error) {
    showAuthorizeError(rosskoAuthFeedback, error);
  }
});

rosskoLogoutButton.addEventListener("click", async () => {
  try {
    authStatus.textContent = "Отключаем Rossko";
    const payload = await postJson("/api/suppliers/rossko/logout");
    updateRosskoSessionCard(payload.session);
    clearAuthInputs(rosskoLoginInput, rosskoPasswordInput);
    authStatus.textContent = "Rossko отключен";
  } catch (error) {
    authStatus.textContent = `Ошибка отключения: ${error.message}`;
  }
});

armtekAuthForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  try {
    authStatus.textContent = "Подключаем Armtek";
    const payload = await postJson("/api/suppliers/armtek/authorize", {
      login: armtekLoginInput.value.trim(),
      password: armtekPasswordInput.value.trim(),
    });
    handleAuthorizeResult(payload.session, armtekAuthFeedback, "Armtek подключен", "Armtek отклонил авторизацию", updateArmtekSessionCard);
  } catch (error) {
    showAuthorizeError(armtekAuthFeedback, error);
  }
});

armtekLogoutButton.addEventListener("click", async () => {
  try {
    authStatus.textContent = "Отключаем Armtek";
    const payload = await postJson("/api/suppliers/armtek/logout");
    updateArmtekSessionCard(payload.session);
    clearAuthInputs(armtekLoginInput, armtekPasswordInput);
    authStatus.textContent = "Armtek отключен";
  } catch (error) {
    authStatus.textContent = `Ошибка отключения: ${error.message}`;
  }
});

partKomAuthForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  try {
    authStatus.textContent = "Подключаем Part-Kom";
    const payload = await postJson("/api/suppliers/part-kom/authorize", {
      login: partKomLoginInput.value.trim(),
      password: partKomPasswordInput.value.trim(),
    });
    handleAuthorizeResult(payload.session, partKomAuthFeedback, "Part-Kom подключен", "Part-Kom отклонил авторизацию", updatePartKomSessionCard);
  } catch (error) {
    showAuthorizeError(partKomAuthFeedback, error);
  }
});

partKomLogoutButton.addEventListener("click", async () => {
  try {
    authStatus.textContent = "Отключаем Part-Kom";
    const payload = await postJson("/api/suppliers/part-kom/logout");
    updatePartKomSessionCard(payload.session);
    clearAuthInputs(partKomLoginInput, partKomPasswordInput);
    authStatus.textContent = "Part-Kom отключен";
  } catch (error) {
    authStatus.textContent = `Ошибка отключения: ${error.message}`;
  }
});

stpartsAuthForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  try {
    authStatus.textContent = "Подключаем STParts";
    const payload = await postJson("/api/suppliers/stparts/authorize", {
      login: stpartsLoginInput.value.trim(),
      password: stpartsPasswordInput.value.trim(),
    });
    handleAuthorizeResult(payload.session, stpartsAuthFeedback, "STParts подключен", "STParts отклонил авторизацию", updateStpartsSessionCard);
  } catch (error) {
    showAuthorizeError(stpartsAuthFeedback, error);
  }
});

stpartsLogoutButton.addEventListener("click", async () => {
  try {
    authStatus.textContent = "Отключаем STParts";
    const payload = await postJson("/api/suppliers/stparts/logout");
    updateStpartsSessionCard(payload.session);
    clearAuthInputs(stpartsLoginInput, stpartsPasswordInput);
    authStatus.textContent = "STParts отключен";
  } catch (error) {
    authStatus.textContent = `Ошибка отключения: ${error.message}`;
  }
});

motorDetalAuthForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  try {
    authStatus.textContent = "Подключаем MotorDetal";
    const payload = await postJson("/api/suppliers/motordetal/authorize", {
      login: motorDetalLoginInput.value.trim(),
      password: motorDetalPasswordInput.value.trim(),
    });
    handleAuthorizeResult(payload.session, motorDetalAuthFeedback, "MotorDetal подключен", "MotorDetal отклонил авторизацию", updateMotorDetalSessionCard);
  } catch (error) {
    showAuthorizeError(motorDetalAuthFeedback, error);
  }
});

motorDetalLogoutButton.addEventListener("click", async () => {
  try {
    authStatus.textContent = "Отключаем MotorDetal";
    const payload = await postJson("/api/suppliers/motordetal/logout");
    updateMotorDetalSessionCard(payload.session);
    clearAuthInputs(motorDetalLoginInput, motorDetalPasswordInput);
    authStatus.textContent = "MotorDetal отключен";
  } catch (error) {
    authStatus.textContent = `Ошибка отключения: ${error.message}`;
  }
});

mladovAuthForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    authStatus.textContent = "Подключаем Механик Ладов";
    const payload = await postJson("/api/suppliers/mladov/authorize", {
      login: mladovLoginInput.value.trim(),
      password: mladovPasswordInput.value.trim(),
    });
    handleAuthorizeResult(payload.session, mladovAuthFeedback, "Механик Ладов подключен", "Механик Ладов отклонил авторизацию", updateMladovSessionCard);
  } catch (error) {
    showAuthorizeError(mladovAuthFeedback, error);
  }
});

mladovLogoutButton.addEventListener("click", async () => {
  try {
    authStatus.textContent = "Отключаем Механик Ладов";
    const payload = await postJson("/api/suppliers/mladov/logout");
    updateMladovSessionCard(payload.session);
    clearAuthInputs(mladovLoginInput, mladovPasswordInput);
    authStatus.textContent = "Механик Ладов отключен";
  } catch (error) {
    authStatus.textContent = `Ошибка отключения: ${error.message}`;
  }
});

form.addEventListener("submit", (event) => {
  event.preventDefault();

  const article = articleInput.value.trim();
  if (!article) {
    return;
  }

  const enabledSuppliers = getEnabledSuppliers();
  if (!enabledSuppliers.length) {
    globalStatus.textContent = "Выберите хотя бы одного поставщика";
    saveSearchState();
    return;
  }

  closeActiveSource();
  resetSearchState();

  const tab = getActiveTab();
  tab.article = article;
  tab.enabledSuppliers = enabledSuppliers;
  tab.hasSearched = true;
  tab.status = `Ищем по артикулу ${article}`;

  globalStatus.textContent = `Ищем по артикулу ${article}`;

  const searchParams = new URLSearchParams({ article });
  searchParams.set("stream", "once");
  enabledSuppliers.forEach((supplier) => searchParams.append("supplier", supplier));

  const source = openSearchStream(`/api/search?${searchParams.toString()}`);
  tab.source = source;
  setSearchUiState(true);
  renderTabs();
  saveSearchState();

  source.onmessage = (messageEvent) => {
    if (tab.source !== source) {
      return;
    }

    const payload = JSON.parse(messageEvent.data);

    if (payload.type === "supplier_status") {
      if (payload.status === "searching") {
        tab.status = `Ищем по ${supplierNames[payload.supplier] ?? payload.supplier}`;
      } else if (payload.status === "completed") {
        tab.status = `Поиск по ${supplierNames[payload.supplier] ?? payload.supplier} завершен`;
      } else if (payload.details) {
        tab.status = payload.details;
      }
      if (tab.id === activeTabId) {
        globalStatus.textContent = tab.status;
      }
      renderTabs();
      saveSearchState();
      return;
    }

    if (payload.type === "result") {
      tab.results.push(payload.result);
      if (tab.id === activeTabId) {
        results = tab.results;
        renderResults();
      }
      renderTabs();
      saveSearchState();
      return;
    }

    if (payload.type === "search_completed") {
      tab.status = "";
      source.close();
      tab.source = null;
      if (tab.id === activeTabId) {
        globalStatus.textContent = tab.status;
        setSearchUiState(false);
        renderResults();
      }
      renderTabs();
      saveSearchState();
      return;
    }

    if (payload.type === "fatal_error") {
      tab.status = `Ошибка: ${payload.message}`;
      source.close();
      tab.source = null;
      if (tab.id === activeTabId) {
        globalStatus.textContent = tab.status;
        setSearchUiState(false);
        renderResults();
      }
      renderTabs();
      saveSearchState();
    }
  };

  source.onerror = () => {
    if (tab.source !== source) {
      return;
    }

    tab.status = "Соединение с потоком поиска было закрыто";
    source.close();
    tab.source = null;
    if (tab.id === activeTabId) {
      globalStatus.textContent = tab.status;
      setSearchUiState(false);
      renderResults();
    }
    renderTabs();
    saveSearchState();
  };
});

restoreSearchState();
if (!searchTabs.length) {
  const tab = createSearchTab();
  searchTabs.push(tab);
  activeTabId = tab.id;
}
const restoredTab = getActiveTab();
if (restoredTab) {
  results = restoredTab.results;
  articleInput.value = restoredTab.article;
  globalStatus.textContent = restoredTab.status;
  supplierEnabledInputs.forEach((input) => {
    input.checked = restoredTab.enabledSuppliers.includes(input.value);
  });
}
setSearchUiState(false);
renderTabs();
renderResults();
loadSessions().catch((error) => {
  authStatus.textContent = `Не удалось загрузить сессии: ${error.message}`;
});
