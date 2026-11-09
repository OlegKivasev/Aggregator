import { setupUserListOrder } from "./user-list-order.js";

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
const userCreateDialog = document.querySelector("#user-create-dialog");
const userCreateOpen = document.querySelector("#user-create-open");
const userCreateSubmit = document.querySelector("#user-create-submit");
const userCreateFeedback = document.querySelector("#user-create-feedback");
const userCreateCancelButtons = [...document.querySelectorAll("[data-user-create-cancel]")];
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
  markup: "Проценка", applicability: "Применимость", repairs: "Заказ-наряды", testRepairs: "Тестовые заказ-наряды", nomenclature: "Номенклатура",
}[permission] ?? permission)).join(", ") || "Нет доступа";

const applyAccess = (user) => {
  window.aggregatorAuthState = { ready: true, user };
  const isAuthenticated = typeof user?.fio === "string" && user.fio.length > 0;
  const canMarkup = user?.isAdmin || user?.permissions?.includes("markup");
  const canApplicability = user?.isAdmin || user?.permissions?.includes("applicability");
  const canRepairs = user?.isAdmin || user?.permissions?.includes("repairs");
  const canTestRepairs = user?.isAdmin || user?.permissions?.includes("testRepairs");
  const canNomenclature = user?.isAdmin || user?.permissions?.includes("nomenclature");
  const singleForm = !user?.isAdmin && user?.permissions?.length === 1;
  const functionTabs = document.querySelector(".function-tabs");
  if (functionTabs) functionTabs.hidden = singleForm;
  document.querySelector(".function-layout")?.classList.toggle("function-layout--single", singleForm);
  const markupTab = document.querySelector("#markup-function-tab");
  const applicabilityTab = document.querySelector("#applicability-function-tab");
  const repairsTab = document.querySelector("#repairs-function-tab");
  const testRepairsTab = document.querySelector("#test-repairs-function-tab");
  const nomenclatureTab = document.querySelector("#nomenclature-function-tab");
  const markupSection = document.querySelector("#markup-function");
  const applicabilitySection = document.querySelector("#applicability-function");
  const repairsSection = document.querySelector("#repairs-function");
  const testRepairsSection = document.querySelector("#test-repairs-function");
  const nomenclatureSection = document.querySelector("#nomenclature-function");
  if (markupTab) markupTab.hidden = !canMarkup;
  if (applicabilityTab) applicabilityTab.hidden = !canApplicability;
  if (repairsTab) repairsTab.hidden = !canRepairs;
  if (testRepairsTab) testRepairsTab.hidden = !canTestRepairs;
  if (nomenclatureTab) nomenclatureTab.hidden = !canNomenclature;
  if (markupSection) markupSection.hidden = !canMarkup;
  if (applicabilitySection) applicabilitySection.hidden = !canApplicability;
  if (repairsSection) repairsSection.hidden = !canRepairs;
  if (testRepairsSection) testRepairsSection.hidden = !canTestRepairs;
  if (nomenclatureSection) nomenclatureSection.hidden = !canNomenclature;
  document.querySelectorAll("[data-admin-only]").forEach((element) => { element.hidden = !user?.isAdmin; });
  const settingsToggle = document.querySelector("#settings-toggle");
  if (settingsToggle) settingsToggle.hidden = !user?.isAdmin;
  if (usersSettings) usersSettings.hidden = !user?.isAdmin || !isAuthenticated;
  if (userBadge) {
    userBadge.textContent = user ? user.fio : "";
    userBadge.hidden = !isAuthenticated;
  }
  if (logoutButton) logoutButton.hidden = !isAuthenticated;
  if (authToolbar) authToolbar.hidden = !isAuthenticated && !user?.isAdmin;
  document.dispatchEvent(new CustomEvent("aggregator-auth-ready", { detail: user }));
  const activeTab = document.querySelector(".function-tab.active");
  (activeTab && !activeTab.hidden ? activeTab : document.querySelector(".function-tab:not([hidden])"))?.click();
};

const renderUsers = (users) => {
  if (!usersList) return;
  usersList.replaceChildren();
  const heading = document.createElement("h3");
  heading.textContent = "Учетные записи";
  usersList.append(heading);
  for (const user of users) {
    const row = document.createElement("details");
    row.className = "users-list__row";
    row.dataset.userId = user.id;
    const summary = document.createElement("summary");
    summary.className = "users-list__summary";
    const info = document.createElement("div");
    const fio = document.createElement("strong");
    fio.textContent = user.fio;
    const permissions = document.createElement("span");
    permissions.textContent = accessLabel(user);
    permissions.className = "panel__meta";
    info.append(fio, permissions);
    summary.append(info);
    const handle = document.createElement("button");
    handle.type = "button";
    handle.className = "users-list__handle";
    handle.textContent = "⠿";
    handle.setAttribute("aria-label", `Переместить пользователя ${user.fio}`);
    handle.title = "Перетащите за край карточки или используйте стрелки ↑/↓";
    summary.append(handle);
    summary.addEventListener("click", (event) => {
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && info.contains(selection.anchorNode)) event.preventDefault();
    });
    row.append(summary);
    const form = document.createElement("form");
    form.className = "auth-form users-list__form";
    form.innerHTML = `
      <label class="field"><span>ФИО</span><input name="fio" type="text" maxlength="256" autocomplete="off" required></label>
      <label class="field"><span>Новый пароль</span><span class="password-field"><input name="password" type="password" autocomplete="new-password" minlength="3" maxlength="4096"><button class="password-toggle" type="button" aria-label="Показать пароль" aria-pressed="false"><span aria-hidden="true">&#128065;</span></button></span></label>
      <p class="settings-drawer__hint">Оставьте пароль пустым, чтобы сохранить текущий.</p>
      <fieldset class="supplier-options__list"><legend>Доступные формы</legend></fieldset>
      <div class="auth-actions"><button class="btn btn-primary" type="submit">Сохранить</button></div>
      <p class="auth-feedback" role="status" aria-live="polite"></p>`;
    const fioInput = form.elements.namedItem("fio");
    fioInput.value = user.fio;
    const passwordInput = form.elements.namedItem("password");
    passwordInput.id = `user-edit-password-${usersList.children.length}`;
    const passwordToggle = form.querySelector(".password-toggle");
    passwordToggle.setAttribute("aria-controls", passwordInput.id);
    const hidePassword = () => {
      passwordInput.type = "password";
      passwordToggle.setAttribute("aria-label", "Показать пароль");
      passwordToggle.setAttribute("aria-pressed", "false");
    };
    row.addEventListener("toggle", () => { if (!row.open) hidePassword(); });
    const fieldset = form.querySelector("fieldset");
    for (const source of permissionInputs) {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = source.value;
      input.checked = user.isAdmin || user.permissions.includes(source.value);
      input.disabled = user.isAdmin;
      const text = document.createElement("span");
      text.textContent = source.closest("label").textContent;
      label.append(input, text);
      fieldset.append(label);
    }
    const feedback = form.querySelector(".auth-feedback");
    const saveButton = form.querySelector('[type="submit"]');
    const actions = form.querySelector(".auth-actions");
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      feedback.textContent = "";
      delete feedback.dataset.state;
      saveButton.disabled = true;
      const deleteButton = actions.querySelector(".users-list__delete");
      if (deleteButton) deleteButton.disabled = true;
      try {
        const response = await fetch("/api/users", {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: user.id, fio: fioInput.value, password: passwordInput.value,
            permissions: [...fieldset.querySelectorAll("input:checked")].map((input) => input.value) }),
        });
        if (!response.ok) throw new Error(await messageFor(response, "Не удалось сохранить пользователя."));
        const payload = await response.json();
        Object.assign(user, payload.user);
        fio.textContent = user.fio;
        handle.setAttribute("aria-label", `Переместить пользователя ${user.fio}`);
        fioInput.value = user.fio;
        permissions.textContent = accessLabel(user);
        passwordInput.value = "";
        hidePassword();
        if (window.aggregatorAuthState?.user?.id === user.id) applyAccess(user);
        feedback.textContent = "Изменения сохранены.";
        feedback.dataset.state = "success";
      } catch (error) {
        feedback.textContent = error instanceof Error ? error.message : "Не удалось сохранить пользователя.";
      } finally {
        saveButton.disabled = false;
        if (deleteButton) deleteButton.disabled = false;
      }
    });
    if (!user.isAdmin) {
      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "btn btn-light users-list__delete";
      deleteButton.setAttribute("aria-label", "Удалить пользователя");
      deleteButton.title = "Удалить пользователя";
      const icon = document.createElement("img");
      icon.src = "/recycle-bin.png";
      icon.alt = "";
      deleteButton.append(icon);
      deleteButton.addEventListener("click", async () => {
        if (!window.confirm(`Удалить пользователя «${user.fio}»?`)) return;
        deleteButton.disabled = true;
        saveButton.disabled = true;
        feedback.textContent = "";
        delete feedback.dataset.state;
        try {
          const response = await fetch("/api/users", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: user.id }) });
          if (!response.ok) throw new Error(await messageFor(response, "Не удалось удалить пользователя."));
          row.remove();
          usersFeedback.textContent = "Пользователь удалён.";
          usersFeedback.dataset.state = "success";
        } catch (error) {
          feedback.textContent = error instanceof Error ? error.message : "Не удалось удалить пользователя.";
        } finally {
          deleteButton.disabled = false;
          saveButton.disabled = false;
        }
      });
      actions.append(deleteButton);
    }
    row.append(form);
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
  if (!shown.length) {
    fioOptions.replaceChildren();
    closeLoginUsers();
    return;
  }
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

setupUserListOrder({
  list: usersList,
  save: async (userIds) => {
    usersFeedback.textContent = "";
    delete usersFeedback.dataset.state;
    const response = await fetch("/api/users/order", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userIds }), signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(await messageFor(response, "Не удалось сохранить порядок пользователей."));
    usersFeedback.textContent = "Порядок пользователей сохранён.";
    usersFeedback.dataset.state = "success";
  },
  onError: (message) => {
    usersFeedback.textContent = message;
    delete usersFeedback.dataset.state;
  },
});

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

let creatingUser = false;

userCreateOpen?.addEventListener("click", () => {
  usersFeedback.textContent = "";
  delete usersFeedback.dataset.state;
  userCreateDialog.showModal();
});
for (const button of userCreateCancelButtons) {
  button.addEventListener("click", () => { if (!creatingUser) userCreateDialog.close(); });
}
userCreateDialog?.addEventListener("cancel", (event) => {
  if (creatingUser) event.preventDefault();
});
userCreateDialog?.addEventListener("keydown", (event) => {
  if (event.key === "Escape" || event.key === "Tab") event.stopPropagation();
});
userCreateDialog?.addEventListener("close", () => {
  userCreateForm.reset();
  userCreateFeedback.textContent = "";
  userPasswordInput.type = "password";
  const toggle = userCreateForm.querySelector(".password-toggle");
  toggle.setAttribute("aria-label", "Показать пароль");
  toggle.setAttribute("aria-pressed", "false");
  userCreateOpen.focus({ preventScroll: true });
});

userCreateForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (creatingUser) return;
  creatingUser = true;
  userCreateSubmit.disabled = true;
  userCreateCancelButtons.forEach((button) => { button.disabled = true; });
  userCreateFeedback.textContent = "";
  const permissions = permissionInputs.filter((input) => input.checked).map((input) => input.value);
  try {
    const response = await fetch("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fio: userFioInput.value, password: userPasswordInput.value, permissions }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(await messageFor(response, "Не удалось создать пользователя."));
    userCreateDialog.close();
    usersFeedback.textContent = "Пользователь создан.";
    usersFeedback.dataset.state = "success";
    try {
      await loadUsers();
    } catch {
      usersFeedback.textContent = "Пользователь создан, но не удалось обновить список. Обновите страницу.";
      delete usersFeedback.dataset.state;
    }
  } catch (error) {
    userCreateFeedback.textContent = error instanceof Error && error.name !== "TimeoutError"
      ? error.message : "Не удалось создать пользователя. Повторите попытку.";
  } finally {
    creatingUser = false;
    userCreateSubmit.disabled = false;
    userCreateCancelButtons.forEach((button) => { button.disabled = false; });
  }
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
