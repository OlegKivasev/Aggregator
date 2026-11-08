const authScreen = document.querySelector("#auth-screen");
const loginForm = document.querySelector("#auth-login-form");
const fioInput = document.querySelector("#auth-fio");
const fioOptions = document.querySelector("#auth-fio-options");
const fioPicker = document.querySelector(".auth-fio-picker");
const fioToggle = document.querySelector("#auth-fio-toggle");
const passwordInput = document.querySelector("#auth-password");
const loginButton = document.querySelector("#auth-login-button");
const loginFeedback = document.querySelector("#auth-login-feedback");
const authToolbar = document.querySelector("#auth-toolbar");
const userBadge = document.querySelector("#auth-user-badge");
const logoutButton = document.querySelector("#auth-logout-button");
const usersSettings = document.querySelector("#users-settings");
const usersList = document.querySelector("#users-list");
const usersFeedback = document.querySelector("#users-feedback");
const userCreateForm = document.querySelector("#user-create-form");
const userFioInput = document.querySelector("#user-fio");
const userPasswordInput = document.querySelector("#user-password");
const permissionInputs = [...document.querySelectorAll("#user-permissions input[type=checkbox]")];

const messageFor = async (response, fallback) => {
  try {
    const payload = await response.json();
    return typeof payload?.message === "string" ? payload.message : fallback;
  } catch {
    return fallback;
  }
};

const accessLabel = (user) => user.isAdmin ? "Администратор" : user.permissions.map((permission) => ({
  markup: "Проценка", applicability: "Применимость", repairs: "Заказ-наряды", testRepairs: "Тестовые заказ-наряды",
}[permission] ?? permission)).join(", ") || "Нет доступа";

const applyAccess = (user) => {
  window.aggregatorAuthState = { ready: true, user };
  const isAuthenticated = typeof user?.fio === "string" && user.fio.length > 0;
  const canMarkup = user?.isAdmin || user?.permissions?.includes("markup");
  const canApplicability = user?.isAdmin || user?.permissions?.includes("applicability");
  const canRepairs = user?.isAdmin || user?.permissions?.includes("repairs");
  const canTestRepairs = user?.isAdmin || user?.permissions?.includes("testRepairs");
  const markupTab = document.querySelector("#markup-function-tab");
  const applicabilityTab = document.querySelector("#applicability-function-tab");
  const repairsTab = document.querySelector("#repairs-function-tab");
  const testRepairsTab = document.querySelector("#test-repairs-function-tab");
  const markupSection = document.querySelector("#markup-function");
  const applicabilitySection = document.querySelector("#applicability-function");
  const repairsSection = document.querySelector("#repairs-function");
  const testRepairsSection = document.querySelector("#test-repairs-function");
  if (markupTab) markupTab.hidden = !canMarkup;
  if (applicabilityTab) applicabilityTab.hidden = !canApplicability;
  if (repairsTab) repairsTab.hidden = !canRepairs;
  if (testRepairsTab) testRepairsTab.hidden = !canTestRepairs;
  if (markupSection) markupSection.hidden = !canMarkup;
  if (applicabilitySection) applicabilitySection.hidden = !canApplicability;
  if (repairsSection) repairsSection.hidden = !canRepairs;
  if (testRepairsSection) testRepairsSection.hidden = !canTestRepairs;
  document.querySelectorAll("[data-admin-only]").forEach((element) => { element.hidden = !user?.isAdmin; });
  const settingsToggle = document.querySelector("#settings-toggle");
  if (settingsToggle) settingsToggle.hidden = !user?.isAdmin;
  if (usersSettings) usersSettings.hidden = !user?.isAdmin || !isAuthenticated;
  if (userBadge) {
    userBadge.textContent = user ? user.fio : "";
    userBadge.hidden = !isAuthenticated;
  }
  if (logoutButton) logoutButton.hidden = !isAuthenticated;
  if (authToolbar) authToolbar.hidden = !isAuthenticated;
  document.dispatchEvent(new CustomEvent("aggregator-auth-ready", { detail: user }));
  const activeTab = document.querySelector(".function-tab.active");
  if (!activeTab || activeTab.hidden) document.querySelector(".function-tab:not([hidden])")?.click();
};

const renderUsers = (users) => {
  if (!usersList) return;
  usersList.replaceChildren();
  const heading = document.createElement("h3");
  heading.textContent = "Учетные записи";
  usersList.append(heading);
  for (const user of users) {
    const row = document.createElement("div");
    row.className = "users-list__row";
    const info = document.createElement("div");
    const fio = document.createElement("strong");
    fio.textContent = user.fio;
    const permissions = document.createElement("span");
    permissions.textContent = accessLabel(user);
    permissions.className = "panel__meta";
    info.append(fio, permissions);
    row.append(info);
    if (!user.isAdmin) {
      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "btn btn-light";
      deleteButton.textContent = "Удалить";
      deleteButton.addEventListener("click", async () => {
        if (!window.confirm(`Удалить пользователя «${user.fio}»?`)) return;
        const response = await fetch("/api/users", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: user.id }) });
        if (!response.ok) {
          usersFeedback.textContent = await messageFor(response, "Не удалось удалить пользователя.");
          return;
        }
        await loadUsers();
      });
      row.append(deleteButton);
    }
    usersList.append(row);
  }
};

let loginUsers = [];
let activeLoginUserIndex = -1;

const closeLoginUsers = () => {
  if (!fioOptions || !fioInput || !fioToggle) return;
  fioOptions.hidden = true;
  fioInput.setAttribute("aria-expanded", "false");
  fioToggle.setAttribute("aria-expanded", "false");
  fioInput.removeAttribute("aria-activedescendant");
  activeLoginUserIndex = -1;
};

const selectLoginUser = (user) => {
  fioInput.value = user.fio;
  closeLoginUsers();
  fioInput.focus();
};

const openLoginUsers = () => {
  if (!fioOptions || !fioInput || !fioToggle) return;
  const filter = fioInput.value.trim().toLocaleLowerCase("ru-RU");
  if (!filter) {
    closeLoginUsers();
    return;
  }
  const shown = loginUsers.filter((user) => user.fio.toLocaleLowerCase("ru-RU").includes(filter));
  activeLoginUserIndex = -1;
  fioInput.removeAttribute("aria-activedescendant");
  fioOptions.replaceChildren(...shown.map((user, index) => {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "search-history__option";
    option.id = `${fioOptions.id}-${index}`;
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", "false");
    option.tabIndex = -1;
    option.textContent = user.fio;
    option.addEventListener("click", () => selectLoginUser(user));
    return option;
  }));
  if (!shown.length) {
    const empty = document.createElement("p");
    empty.className = "search-history__empty";
    empty.textContent = loginUsers.length ? "Совпадений нет" : "Пользователей пока нет";
    fioOptions.append(empty);
  }
  fioOptions.hidden = false;
  fioInput.setAttribute("aria-expanded", "true");
  fioToggle.setAttribute("aria-expanded", "true");
};

fioInput?.addEventListener("input", () => openLoginUsers());
fioToggle?.addEventListener("click", () => {
  if (fioOptions?.hidden && fioInput?.value.trim()) openLoginUsers();
  else closeLoginUsers();
});
fioInput?.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && fioOptions && !fioOptions.hidden) {
    event.preventDefault();
    closeLoginUsers();
    return;
  }
  if (!["ArrowDown", "ArrowUp"].includes(event.key)) {
    if (event.key === "Enter" && fioOptions && !fioOptions.hidden && activeLoginUserIndex >= 0) {
      event.preventDefault();
      const option = fioOptions.children[activeLoginUserIndex];
      if (option?.getAttribute("role") === "option") option.click();
    }
    return;
  }
  event.preventDefault();
  if (fioOptions?.hidden) openLoginUsers();
  const options = fioOptions ? [...fioOptions.querySelectorAll('[role="option"]')] : [];
  if (!options.length) return;
  activeLoginUserIndex = (activeLoginUserIndex + (event.key === "ArrowDown" ? 1 : activeLoginUserIndex < 0 ? 0 : -1) + options.length) % options.length;
  options.forEach((option, index) => option.setAttribute("aria-selected", String(index === activeLoginUserIndex)));
  const active = options[activeLoginUserIndex];
  fioInput.setAttribute("aria-activedescendant", active.id);
  active.scrollIntoView({ block: "nearest" });
});
fioPicker?.addEventListener("focusout", (event) => {
  if (!fioPicker.contains(event.relatedTarget)) closeLoginUsers();
});
document.addEventListener("pointerdown", (event) => {
  if (fioPicker && !fioPicker.contains(event.target)) closeLoginUsers();
});

const loadUsers = async () => {
  const response = await fetch("/api/users", { cache: "no-store" });
  if (!response.ok) throw new Error(await messageFor(response, "Не удалось загрузить пользователей."));
  const payload = await response.json();
  if (!Array.isArray(payload?.users)) throw new Error("Некорректный список пользователей.");
  renderUsers(payload.users);
};

const loadLoginUsers = async () => {
  if (!fioOptions) return;
  const response = await fetch("/api/auth/users", { cache: "no-store" });
  if (!response.ok) throw new Error("Не удалось загрузить пользователей.");
  const payload = await response.json();
  if (!Array.isArray(payload?.users)) throw new Error("Некорректный список пользователей.");
  loginUsers = payload.users
    .filter((user) => user && typeof user.fio === "string" && user.fio.trim())
    .map((user) => ({ fio: user.fio.trim() }));
};

userCreateForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  usersFeedback.textContent = "";
  const permissions = permissionInputs.filter((input) => input.checked).map((input) => input.value);
  const response = await fetch("/api/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fio: userFioInput.value, password: userPasswordInput.value, permissions }),
  });
  if (!response.ok) {
    usersFeedback.textContent = await messageFor(response, "Не удалось создать пользователя.");
    return;
  }
  userCreateForm.reset();
  usersFeedback.textContent = "Пользователь создан.";
  await loadUsers();
});

logoutButton?.addEventListener("click", async () => {
  await fetch("/api/auth/logout", { method: "POST" });
  window.location.reload();
});

loginForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginButton.disabled = true;
  loginFeedback.textContent = "";
  try {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fio: fioInput.value, password: passwordInput.value }),
    });
    if (!response.ok) {
      loginFeedback.textContent = await messageFor(response, "Не удалось войти.");
      return;
    }
    window.location.reload();
  } finally {
    loginButton.disabled = false;
  }
});

const bootstrap = async () => {
  try {
    const response = await fetch("/api/auth/session", { cache: "no-store" });
    const payload = await response.json();
    if (!payload?.enabled) {
      applyAccess({ isAdmin: true, permissions: ["markup", "applicability", "repairs"] });
      return;
    }
    if (!payload.user) {
      try { await loadLoginUsers(); } catch { /* Login still works without suggestions. */ }
      authScreen.hidden = false;
      document.body.classList.add("auth-required");
      return;
    }
    applyAccess(payload.user);
    if (payload.user.isAdmin) {
      try { await loadUsers(); } catch (error) { usersFeedback.textContent = error instanceof Error ? error.message : "Не удалось загрузить пользователей."; }
    }
  } catch {
    authScreen.hidden = false;
    loginFeedback.textContent = "Сервер авторизации недоступен.";
  }
};

void bootstrap();
