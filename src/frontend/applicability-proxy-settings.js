const drawer = document.querySelector("#applicability-settings-drawer");
const form = document.querySelector("#applicability-proxy-form");
const routes = document.querySelector("#applicability-proxy-routes");
const indicator = document.querySelector("#applicability-route-indicator");
const feedback = document.querySelector("#applicability-proxy-feedback");
const persistence = document.querySelector("#applicability-proxy-persistence");
const usage = document.querySelector("#applicability-proxy-usage");
const addButton = document.querySelector("#applicability-proxy-add");
const password = document.querySelector("#applicability-proxy-password");
const importForm = document.querySelector("#applicability-proxy-import-form");
const importFile = document.querySelector("#applicability-proxy-import-file");
const importButton = document.querySelector("#applicability-proxy-import");
const routeNotice = document.querySelector("#applicability-route-notice");
let noticeTimer = null;
let state = null;
let stateReceivedAt = 0;
let loading = false;
let mutating = false;
let importing = false;
let lastRefresh = 0;
let stateRevision = 0;

const notify = (message, error = false) => {
  feedback.textContent = message;
  feedback.dataset.error = String(error);
  feedback.hidden = !message;
};

const readState = async (response) => {
  const payload = await response.json();
  if (!response.ok) throw new Error(typeof payload?.message === "string" ? payload.message : "Не удалось изменить соединение PartsAPI.");
  const validId = (id) => typeof id === "string" && /^[0-9a-f-]{36}$/.test(id);
  const validHost = (host) => typeof host === "string" && host.length <= 253 && host.split(".").length >= 2
    && host.split(".").every((label) => label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label));
  const validCounters = (counters) => counters && typeof counters === "object" && !Array.isArray(counters)
    && ["requestCount", "dataResponseCount", "emptyResponseCount", "failedRequestCount"]
      .every((key) => Number.isSafeInteger(counters[key]) && counters[key] >= 0 && counters[key] <= 1_000_000_000)
    && counters.dataResponseCount + counters.emptyResponseCount + counters.failedRequestCount <= counters.requestCount;
  const validWindow = (window) => window && ((window.windowStartedAt === null && window.resetAt === null && window.secondsUntilReset === null)
    || (Number.isSafeInteger(window.windowStartedAt) && window.windowStartedAt >= 0
      && Number.isSafeInteger(window.resetAt) && window.resetAt === window.windowStartedAt + 86_400_000
      && Number.isSafeInteger(window.secondsUntilReset) && window.secondsUntilReset >= 0 && window.secondsUntilReset <= 86_400));
  if (typeof payload?.persistent !== "boolean" || typeof payload.directLimited !== "boolean"
    || ![null, "manual", "ip-limit"].includes(payload.lastSwitchReason)
    || !validCounters(payload.usage) || !validWindow(payload.usage)
    || !validCounters(payload.directUsage)
    || (payload.importedCount !== undefined && (!Number.isInteger(payload.importedCount) || payload.importedCount < 0 || payload.importedCount > 100
      || !Number.isInteger(payload.duplicateCount) || payload.duplicateCount < 0 || payload.duplicateCount > 100))
    || !Array.isArray(payload.proxies) || payload.proxies.length > 100
    || payload.proxies.some((proxy) => !proxy || !validId(proxy.id) || !["http", "https"].includes(proxy.protocol)
      || !validHost(proxy.host)
      || !Number.isInteger(proxy.port) || proxy.port < 1 || proxy.port > 65535 || typeof proxy.limited !== "boolean" || !validCounters(proxy.usage))
    || new Set(payload.proxies.map(({ id }) => id)).size !== payload.proxies.length
    || (payload.activeRouteId !== null && !payload.proxies.some(({ id }) => id === payload.activeRouteId))) {
    throw new Error("Не удалось проверить соединение PartsAPI.");
  }
  return payload;
};

const formatRemaining = () => {
  const seconds = Math.max(0, state.usage.secondsUntilReset - Math.floor((Date.now() - stateReceivedAt) / 1000));
  if (seconds <= 0) return "сейчас";
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (hours > 0) return `${hours} ч ${minutes} мин`;
  if (minutes > 0) return `${minutes} мин`;
  return "меньше минуты";
};

const describeCounters = (counters) => `Данные: ${counters.dataResponseCount}; пустые ответы: ${counters.emptyResponseCount}; ошибки и отмены: ${counters.failedRequestCount}`;

const formatRequestCount = (count) => {
  const lastTwo = count % 100;
  const last = count % 10;
  const word = lastTwo >= 11 && lastTwo <= 14 ? "запросов" : last === 1 ? "запрос" : last >= 2 && last <= 4 ? "запроса" : "запросов";
  return `${count} ${word}`;
};

const renderUsage = () => {
  if (!state) return;
  const reset = state.usage.resetAt === null ? "Окно 24 часа начнётся с первого запроса" : `Расчётный сброс лимитов: через ${formatRemaining()}`;
  usage.textContent = `Основной ключ: ${formatRequestCount(state.usage.requestCount)} · ${reset}`;
  usage.title = `${describeCounters(state.usage)}. ${reset}`;
  usage.setAttribute("aria-label", `${usage.textContent}. ${describeCounters(state.usage)}`);
  indicator.title = `Всего: ${formatRequestCount(state.usage.requestCount)}. ${describeCounters(state.usage)}. ${reset}. Нажмите, чтобы выбрать соединение.`;
};

const render = (next) => {
  const switched = state && next.activeRouteId !== state.activeRouteId && next.lastSwitchReason === "ip-limit";
  if (next !== state) stateReceivedAt = Date.now();
  state = next;
  renderUsage();
  const active = state.proxies.find(({ id }) => id === state.activeRouteId);
  const limited = active ? active.limited : state.directLimited;
  const name = active ? `прокси ${active.host}:${active.port}` : "прямое соединение";
  if (switched) {
    if (noticeTimer !== null) clearTimeout(noticeTimer);
    routeNotice.textContent = `Лимит IP: PartsAPI автоматически переключён на ${name}.`;
    routeNotice.hidden = false;
    noticeTimer = setTimeout(() => { routeNotice.hidden = true; noticeTimer = null; }, 6_000);
  }
  indicator.textContent = `PartsAPI: ${name} · ${formatRequestCount(state.usage.requestCount)}${limited ? " · лимит IP" : state.lastSwitchReason === "ip-limit" ? " · автопереключение" : ""}`;
  indicator.dataset.route = active ? "proxy" : "direct";
  indicator.dataset.limited = String(limited);
  persistence.textContent = state.persistent ? "Данные прокси сохраняются зашифрованными на сервере." : "Для сохранения прокси нужно настроить защищённое хранение на сервере.";
  addButton.disabled = mutating || importing || !state.persistent || state.proxies.length >= 100;
  importButton.disabled = mutating || importing || !state.persistent || state.proxies.length >= 100;
  const previousScrollTop = routes.scrollTop;
  routes.replaceChildren();
  const choices = [{ id: null, label: "Прямое соединение", limited: state.directLimited }, ...state.proxies.map((proxy) => ({ ...proxy, label: `${proxy.host}:${proxy.port} · ${proxy.protocol.toUpperCase()}` }))];
  for (const choice of choices) {
    const row = document.createElement("div");
    row.className = "applicability-proxy-route";
    row.dataset.active = String(choice.id === state.activeRouteId);
    row.dataset.limited = String(choice.limited);
    const label = document.createElement("span");
    label.textContent = choice.label;
    const status = document.createElement("small");
    const counters = choice.id === null ? state.directUsage : choice.usage;
    const stateText = choice.limited ? "Лимит IP · можно выбрать для повторной проверки" : choice.id === state.activeRouteId ? "Используется для новых запросов" : "Доступно для выбора";
    const counter = document.createElement("span");
    counter.className = "applicability-proxy-counter";
    counter.textContent = formatRequestCount(counters.requestCount);
    counter.title = describeCounters(counters);
    counter.setAttribute("aria-label", `${formatRequestCount(counters.requestCount)}. ${describeCounters(counters)}`);
    status.append(counter, document.createTextNode(` · ${stateText}`));
    label.append(status);
    const actions = document.createElement("div");
    actions.className = "applicability-proxy-route-actions";
    const select = document.createElement("button");
    select.type = "button";
    select.className = "btn btn-light";
    select.textContent = choice.limited ? "Повторить" : choice.id === state.activeRouteId ? "Выбрано" : "Выбрать";
    select.disabled = mutating || importing || !state.persistent || (choice.id === state.activeRouteId && !choice.limited);
    select.addEventListener("click", () => mutate("/api/applicability/proxy-route", "PUT", { routeId: choice.id }));
    actions.append(select);
    if (choice.id !== null) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "btn btn-light";
      remove.textContent = "Удалить";
      remove.disabled = mutating || importing || choice.id === state.activeRouteId;
      remove.addEventListener("click", () => mutate(`/api/applicability/proxies/${choice.id}`, "DELETE"));
      actions.append(remove);
    }
    row.append(label, actions);
    routes.append(row);
  }
  routes.scrollTop = previousScrollTop;
};

const refresh = async (force = false) => {
  if (loading || mutating || (!force && Date.now() - lastRefresh < 1500)) return;
  loading = true;
  const revision = stateRevision;
  try {
    const next = await readState(await fetch("/api/applicability/proxies", { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(5_000) }));
    if (!mutating && revision === stateRevision) render(next);
  } catch (error) {
    if (revision !== stateRevision) return;
    indicator.textContent = "PartsAPI: соединение неизвестно";
    indicator.dataset.limited = "true";
    if (!drawer.hidden) notify(error instanceof Error ? error.message : "Не удалось проверить соединение PartsAPI.", true);
  } finally {
    loading = false;
    lastRefresh = Date.now();
  }
};

const mutate = async (url, method, payload) => {
  if (mutating) return;
  mutating = true;
  stateRevision += 1;
  if (state) render(state);
  notify("");
  try {
    const next = await readState(await fetch(url, {
      method, headers: { "Content-Type": "application/json", Accept: "application/json" },
      ...(payload ? { body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(10_000),
    }));
    render(next);
    if (url === "/api/applicability/proxies/import") {
      importForm.reset();
      notify(`Импортировано: ${next.importedCount}. Дубликатов пропущено: ${next.duplicateCount}. Автопереключение включено.`);
    } else if (method === "POST") {
      form.reset();
      password.type = "password";
      password.closest(".password-field").querySelector(".password-toggle").setAttribute("aria-label", "Показать пароль");
      notify("Прокси добавлен. Автопереключение включено.");
    } else {
      notify(method === "DELETE" ? "Прокси удалён." : "Соединение выбрано для новых запросов.");
    }
  } catch (error) {
    notify(error instanceof Error ? error.message : "Не удалось изменить соединение PartsAPI.", true);
  } finally {
    mutating = false;
    if (state) render(state);
  }
};

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (importing) return;
  const fields = new FormData(form);
  mutate("/api/applicability/proxies", "POST", {
    protocol: fields.get("protocol"), host: fields.get("host").trim(), port: Number(fields.get("port")),
    login: fields.get("login"), password: fields.get("password"),
  });
});
importForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (mutating || importing) return;
  const file = importFile.files?.[0];
  if (!file || file.size > 512 * 1024) { notify("Выберите текстовый файл размером до 512 КБ.", true); return; }
  importing = true;
  const protocol = new FormData(importForm).get("protocol");
  if (state) render(state);
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
    await mutate("/api/applicability/proxies/import", "POST", { protocol, text });
  } catch {
    notify("Не удалось прочитать файл. Сохраните его в кодировке UTF-8 и повторите импорт.", true);
  } finally {
    importing = false;
    if (state) render(state);
  }
});
indicator.addEventListener("click", () => {
  drawer.hidden = false;
  document.querySelector("#applicability-proxy-settings").open = true;
  refresh(true);
});
document.querySelector("#applicability-settings-toggle").addEventListener("click", () => refresh(true));
document.addEventListener("partsapi-request-finished", () => refresh(true));
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(true); });
// Refresh live routing while the applicability view is visible, including switches in concurrent searches.
const timer = setInterval(() => {
  if (!document.hidden && !document.querySelector("#applicability-function").hidden) {
    renderUsage();
    refresh();
  }
}, 1000);
window.addEventListener("pagehide", () => { clearInterval(timer); if (noticeTimer !== null) clearTimeout(noticeTimer); }, { once: true });
refresh(true);
