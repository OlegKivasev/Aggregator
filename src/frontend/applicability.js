const markupFunction = document.querySelector("#markup-function");
const applicabilityFunction = document.querySelector("#applicability-function");
const markupTab = document.querySelector("#markup-function-tab");
const applicabilityTab = document.querySelector("#applicability-function-tab");
const form = document.querySelector("#applicability-search-form");
const skuInput = document.querySelector("#applicability-sku");
const makeInput = document.querySelector("#applicability-make");
const makesList = document.querySelector("#applicability-makes");
const apiKeyInput = document.querySelector("#applicability-api-key");
const settings = document.querySelector("#applicability-settings");
const settingsToggle = document.querySelector("#applicability-settings-toggle");
const submitButton = document.querySelector("#applicability-submit");
const feedback = document.querySelector("#applicability-feedback");
const result = document.querySelector("#applicability-result");
const resultSummary = document.querySelector("#applicability-result-summary");
const resultsBody = document.querySelector("#applicability-results-body");

let makesByName = new Map();
let activeRequest = null;

const setActiveFunction = (name) => {
  const isApplicability = name === "applicability";
  markupFunction.hidden = isApplicability;
  applicabilityFunction.hidden = !isApplicability;
  markupTab.classList.toggle("active", !isApplicability);
  applicabilityTab.classList.toggle("active", isApplicability);
  markupTab.setAttribute("aria-selected", String(!isApplicability));
  applicabilityTab.setAttribute("aria-selected", String(isApplicability));
  if (isApplicability) skuInput.focus();
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

const renderResults = (vehicles) => {
  resultsBody.replaceChildren();
  result.hidden = false;
  result.open = false;
  result.classList.toggle("is-empty", vehicles.length === 0);
  resultSummary.textContent = vehicles.length
    ? `Найдено автомобилей: ${vehicles.length}`
    : "Не найдено";
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
    setFeedback("Не удалось загрузить список марок. Обновите страницу и повторите попытку.");
  }
};

markupTab.addEventListener("click", () => setActiveFunction("markup"));
applicabilityTab.addEventListener("click", () => setActiveFunction("applicability"));
settingsToggle.addEventListener("click", () => {
  settings.hidden = !settings.hidden;
  if (!settings.hidden) apiKeyInput.focus();
});

makeInput.addEventListener("input", () => {
  makeInput.dataset.makeId = selectedMake()?.id ? String(selectedMake().id) : "";
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const sku = skuInput.value.trim();
  const make = selectedMake();
  const apiKey = apiKeyInput.value.trim();
  if (!sku) return;
  if (!make) {
    setFeedback("Выберите марку из списка.");
    makeInput.focus();
    return;
  }
  if (!apiKey) {
    settings.hidden = false;
    setFeedback("Укажите API-ключ PartsAPI в настройках.");
    apiKeyInput.focus();
    return;
  }

  activeRequest?.abort();
  const controller = new AbortController();
  activeRequest = controller;
  submitButton.disabled = true;
  submitButton.textContent = "Ищем…";
  setFeedback("", "notice");
  result.hidden = true;
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
    renderResults(payload.results);
  } catch (error) {
    if (error.name !== "AbortError") {
      setFeedback(error instanceof Error ? error.message : "Не удалось выполнить поиск применимости.");
    }
  } finally {
    if (activeRequest === controller) {
      activeRequest = null;
      submitButton.disabled = false;
      submitButton.textContent = "Найти";
    }
  }
});

loadMakes();
