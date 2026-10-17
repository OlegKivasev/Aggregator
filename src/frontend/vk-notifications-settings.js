const section = document.querySelector("#vk-notifications-settings");
const form = document.querySelector("#vk-notifications-form");
const token = document.querySelector("#vk-notifications-token");
const connection = document.querySelector("#vk-notifications-connection");
const status = document.querySelector("#vk-notifications-status");
const chat = document.querySelector("#vk-notifications-chat");
const chatLabel = document.querySelector("#vk-notifications-chat-label");
const enabled = document.querySelector("#vk-notifications-enabled");
const supplierList = document.querySelector("#vk-notifications-suppliers");
const refresh = document.querySelector("#vk-notifications-refresh");
const disconnect = document.querySelector("#vk-notifications-disconnect");
const names = { armtek: "Armtek", "part-kom": "PartKOM", "forum-auto": "Forum Auto", rossko: "Rossko" };
let state = null;
let busy = false;
const date = (value) => value ? new Date(value).toLocaleString("ru-RU") : "ещё не было";
const validDate = (value) => value === null || typeof value === "string" && Number.isFinite(Date.parse(value));

const validate = (value) => {
  if (!value || typeof value !== "object" || ["configured", "persistent", "enabled", "checking"].some((key) => typeof value[key] !== "boolean")
    || value.intervalMinutes !== 10 || !validDate(value.lastCheckAt) || !validDate(value.nextCheckAt)
    || ![null, "pending", "sent", "failed"].includes(value.testMessage)
    || value.groupName !== null && (typeof value.groupName !== "string" || value.groupName.length > 200)
    || value.error !== null && (typeof value.error !== "string" || value.error.length > 500)
    || !["pending", "failed"].every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0)
    || !Array.isArray(value.chats) || value.chats.length > 1000
    || value.chats.some((item) => !item || !Number.isSafeInteger(item.id) || item.id <= 2_000_000_000 || typeof item.title !== "string" || item.title.length > 200)
    || value.peerId !== null && !value.chats.some((item) => item.id === value.peerId)
    || !Array.isArray(value.suppliers) || value.suppliers.length > 4
    || value.suppliers.some((item) => !item || !Object.hasOwn(names, item.supplier) || !validDate(item.lastSuccessAt) || typeof item.limited !== "boolean"
      || item.error !== null && (typeof item.error !== "string" || item.error.length > 500))) throw new Error("Не удалось проверить настройки уведомлений ВК.");
  return value;
};

const paint = () => {
  form.querySelector("button").disabled = busy || state?.persistent === false;
  token.disabled = busy || state?.persistent === false;
  refresh.disabled = busy;
  disconnect.disabled = busy || !state?.configured;
  chat.disabled = busy || !state?.configured;
  enabled.disabled = busy || !state?.configured || state.peerId === null;
  if (!state) return;
  const selectedChat = state.chats.find((item) => item.id === state.peerId);
  connection.textContent = !state.persistent ? "Для сохранения ключа администратору нужно настроить серверное шифрование."
    : state.configured ? `Сообщество: ${state.groupName}. ${selectedChat ? `Беседа: ${selectedChat.title}.` : state.chats.length ? "Выберите беседу для уведомлений." : "Доступных бесед нет. Проверьте, что бот добавлен в чат и может писать сообщения, затем сохраните ключ повторно."}` : "ВК пока не подключён.";
  chat.replaceChildren(...state.chats.map((item) => {
    const option = document.createElement("option"); option.value = String(item.id); option.textContent = item.title; return option;
  }));
  if (state.peerId === null) chat.selectedIndex = -1; else chat.value = String(state.peerId);
  chatLabel.hidden = !state.configured || state.chats.length === 0 || state.chats.length === 1 && state.peerId !== null;
  enabled.checked = state.enabled;
  const testMessage = state.testMessage === "sent" ? "Тестовое сообщение отправлено. " : state.testMessage === "pending" ? "Тестовое сообщение ожидает отправки. " : state.testMessage === "failed" ? "Не удалось отправить тестовое сообщение. Проверьте права бота и сохраните ключ повторно. " : "";
  status.textContent = state.error ?? (!state.configured ? "" : `${testMessage}${state.enabled ? "Уведомления включены." : "Уведомления о заказах выключены."} Последняя проверка: ${date(state.lastCheckAt)}.${state.enabled && state.nextCheckAt ? ` Следующая: ${date(state.nextCheckAt)}.` : ""} В очереди: ${state.pending}. Ошибок отправки: ${state.failed}.${state.checking ? " Проверяем заказы…" : ""}`);
  status.dataset.error = String(!!state.error || state.failed > 0);
  supplierList.replaceChildren(...state.suppliers.map((item) => {
    const li = document.createElement("li");
    li.textContent = `${names[item.supplier]}: ${item.error ?? `проверка ${date(item.lastSuccessAt)}`}${item.limited ? "; поставщик ограничил выборку — часть событий может быть недоступна" : ""}`;
    return li;
  }));
};

const request = async (path, options) => {
  if (busy) return;
  busy = true; paintControls();
  try {
    const response = await fetch(path, { headers: { "Content-Type": "application/json" }, ...options });
    const payload = await response.json();
    if (!response.ok) throw new Error(typeof payload?.message === "string" ? payload.message : "Не удалось изменить настройки ВК.");
    state = validate(payload);
    paint();
  } catch (error) { status.textContent = error.message; status.dataset.error = "true"; }
  finally { busy = false; token.value = ""; paintControls(); }
};
const paintControls = () => {
  form.querySelector("button").disabled = busy || state?.persistent === false;
  token.disabled = busy || state?.persistent === false;
  refresh.disabled = busy;
  disconnect.disabled = busy || !state?.configured;
  chat.disabled = busy || !state?.configured;
  enabled.disabled = busy || !state?.configured || state.peerId === null;
  if (state && !busy) { enabled.checked = state.enabled; if (state.peerId !== null) chat.value = String(state.peerId); }
};
section.addEventListener("toggle", () => { if (section.open) void request("/api/notifications/vk"); });
form.addEventListener("submit", (event) => { event.preventDefault(); const value = token.value.trim(); token.value = ""; void request("/api/notifications/vk", { method: "PUT", body: JSON.stringify({ token: value }) }); });
refresh.addEventListener("click", () => { void request("/api/notifications/vk"); });
disconnect.addEventListener("click", () => { void request("/api/notifications/vk", { method: "DELETE" }); });
enabled.addEventListener("change", () => { void request("/api/notifications/vk/state", { method: "PUT", body: JSON.stringify({ enabled: enabled.checked }) }); });
chat.addEventListener("change", () => { void request("/api/notifications/vk/state", { method: "PUT", body: JSON.stringify({ enabled: false, peerId: Number(chat.value) }) }); });
