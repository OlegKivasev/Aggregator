import { formatArticle, formatBrand, formatPrice, formatQuantity, getSafeResultLink } from "./result-formatting.js";
import { formatDeliveryDate } from "./supplier-search-summary.js";
import { applySavedColumnWidths, restoreLocalColumnWidths, saveColumnWidths, setupColumnResizing } from "./table-column-widths.js";

const api = async (path, options = {}, allowConflict = false) => {
  const response = await fetch(path, { headers: { "Content-Type": "application/json" }, ...options });
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok && (!allowConflict || response.status !== 409)) throw new Error(payload?.message || "Не удалось выполнить действие в гараже");
  return { response, payload };
};

const element = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};

export const bootstrapGarage = ({ getMarkupPercent }) => {
  const sidebar = document.querySelector("#garage-sidebar");
  const toggle = document.querySelector("#garage-toggle");
  const vehiclesList = document.querySelector("#garage-vehicles");
  const searchForm = document.querySelector("#garage-search-form");
  const search = document.querySelector("#garage-search");
  const create = document.querySelector("#garage-create");
  const contextMenu = document.querySelector("#garage-context-menu");
  const renameButton = document.querySelector("#garage-rename-button");
  const deleteButton = document.querySelector("#garage-delete-button");
  const titlebar = document.querySelector("#garage-titlebar");
  const garageWorkspace = document.querySelector("#garage-workspace");
  const view = document.querySelector("#garage-view");
  const viewName = document.querySelector("#garage-vehicle-name");
  const itemsBody = document.querySelector("#garage-items");
  const status = document.querySelector("#garage-status");
  const resultCount = document.querySelector("#garage-result-count");
  const total = document.querySelector("#garage-total");
  const groupForm = document.querySelector("#garage-group-form");
  const groupName = document.querySelector("#garage-group-name");
  const groupCreate = document.querySelector("#garage-group-create");
  const groupCancel = document.querySelector("#garage-group-cancel");
  const groupSave = document.querySelector("#garage-group-save");
  const groupsToggle = document.querySelector("#garage-groups-toggle");
  const groupsSidebar = document.querySelector("#garage-groups-sidebar");
  const groupsList = document.querySelector("#garage-groups");
  const groupsResize = document.querySelector("#garage-groups-resize");
  const itemMenu = document.querySelector("#garage-item-menu");
  const itemMenuGroups = document.querySelector("#garage-item-menu-groups");
  const itemDeleteButton = document.querySelector("#garage-item-delete-button");
  const groupContextMenu = document.querySelector("#garage-group-context-menu");
  const groupRenameButton = document.querySelector("#garage-group-rename-button");
  const groupDeleteButton = document.querySelector("#garage-group-delete-button");
  const tableSearch = document.querySelector("#garage-table-search");
  const filtersToggle = document.querySelector("#garage-filters-toggle");
  const filtersSidebar = document.querySelector("#garage-filters-sidebar");
  const filtersResize = document.querySelector("#garage-filters-resize");
  const filtersReset = document.querySelector("#garage-filters-reset");
  const filterContainers = {
    supplier: document.querySelector("#garage-filter-supplier"),
    brand: document.querySelector("#garage-filter-brand"),
    article: document.querySelector("#garage-filter-article"),
    availability: document.querySelector("#garage-filter-availability"),
  };
  const back = document.querySelector("#garage-back");
  const refresh = document.querySelector("#garage-refresh");
  const garageSortButtons = [...document.querySelectorAll("[data-garage-sort-key]")];
  const resize = document.querySelector("#garage-resize");
  const modal = document.querySelector("#garage-add-modal");
  const modalTitle = document.querySelector("#garage-add-title");
  const modalForm = document.querySelector("#garage-add-form");
  const modalVehiclePicker = document.querySelector("#garage-add-vehicle-picker");
  const modalSearch = document.querySelector("#garage-add-search");
  const modalVehicles = document.querySelector("#garage-add-vehicles");
  const modalQuantity = document.querySelector("#garage-add-quantity");
  const modalGroupField = document.querySelector("#garage-add-group-field");
  const modalGroup = document.querySelector("#garage-add-group");
  const modalConfirm = document.querySelector("#garage-add-confirm");
  const modalDuplicate = document.querySelector("#garage-add-duplicate");
  const modalDuplicateIncrement = document.querySelector("#garage-add-duplicate-increment");
  const modalDuplicateNew = document.querySelector("#garage-add-duplicate-new");
  const toast = document.querySelector("#garage-toast");
  const searchShell = document.querySelector(".search-shell");
  const searchTabs = document.querySelector("#search-tabs");
  const workspace = document.querySelector(".workspace");
  let vehicles = [];
  let selectedVehicle = null;
  let selectedAddVehicleId = null;
  let pendingOfferId = null;
  let pendingOfferQuantity = null;
  let garageTableSearchTerm = "";
  let garageSortState = { key: "price", direction: "ascending" };
  const selectedFilterValues = new Map(["supplier", "brand", "article", "availability"].map((column) => [column, new Set()]));
  let resizeStart = null;
  let filtersResizeStart = null;
  let groupsResizeStart = null;
  let editingVehicle = null;
  let deletingVehicleId = null;
  let contextVehicleId = null;
  let contextMenuAnchor = null;
  let itemMenuItemId = null;
  let itemMenuAnchor = null;
  let editingGroupId = null;
  let contextGroupId = null;
  let groupContextMenuAnchor = null;
  let selectedGroupId;
  let toastTimer = null;
  const widthStorageKey = "autoservice-garage-sidebar-width-v1";
  const filtersWidthStorageKey = "autoservice-garage-filters-width-v1";
  const groupsWidthStorageKey = "autoservice-garage-groups-width-v1";
  const closeThresholdRatio = 0.02;
  const garageColumnWidths = { supplier: 100, brand: 125, article: 140, title: 323, deliveryDate: 180, availability: 120, quantity: 120, price: 120, sum: 120 };
  Object.assign(garageColumnWidths, restoreLocalColumnWidths("garage", garageColumnWidths));
  const garageActionColumnWidth = 52;

  const setStatus = (message) => { status.textContent = message; };
  const appendOfferLink = (cell, item, text, isTitle = false) => {
    const link = getSafeResultLink(item.link);
    if (!link) {
      cell.textContent = text;
      return;
    }
    const anchor = document.createElement("a");
    anchor.className = "result-offer-link";
    anchor.href = link;
    anchor.target = "_blank";
    anchor.rel = "noreferrer";
    anchor.title = text;
    anchor.textContent = text;
    if (isTitle) {
      const title = document.createElement("div");
      title.className = "result-title-cell";
      title.append(anchor);
      cell.append(title);
      return;
    }
    cell.append(anchor);
  };
  const showToast = (message, tone = "notice") => {
    if (toastTimer !== null) window.clearTimeout(toastTimer);
    toast.textContent = message;
    toast.dataset.tone = tone;
    toast.hidden = false;
    toastTimer = window.setTimeout(() => { toast.hidden = true; toastTimer = null; }, 4_000);
  };
  const setModalQuantityMaximum = (value) => {
    const quantity = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
    if (Number.isFinite(quantity) && quantity >= 0) {
      modalQuantity.max = String(quantity);
      return;
    }
    modalQuantity.removeAttribute("max");
  };
  const setFiltersOpen = (open) => {
    filtersSidebar.hidden = !open;
    filtersToggle.setAttribute("aria-expanded", String(open));
    filtersToggle.setAttribute("aria-label", open ? "Скрыть фильтры" : "Открыть фильтры");
    filtersToggle.title = open ? "Скрыть фильтры" : "Открыть фильтры";
  };
  const setSidebarOpen = (open) => {
    sidebar.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "Скрыть гараж" : "Открыть гараж");
    toggle.title = open ? "Скрыть гараж" : "Открыть гараж";
  };
  const setGroupsOpen = (open) => {
    groupsSidebar.hidden = !open;
    groupsToggle.setAttribute("aria-expanded", String(open));
    groupsToggle.setAttribute("aria-label", open ? "Скрыть группы товаров" : "Открыть группы товаров");
    groupsToggle.title = open ? "Скрыть группы товаров" : "Открыть группы товаров";
  };
  const setSidebarWidth = (value) => {
    const width = Number(value);
    if (!Number.isFinite(width)) return;
    const normalizedWidth = Math.min(420, Math.max(180, Math.round(width / 10) * 10));
    sidebar.style.setProperty("--garage-sidebar-width", `${normalizedWidth}px`);
    try {
      localStorage.setItem(widthStorageKey, String(normalizedWidth));
    } catch {
      // The panel remains resizable for this session when storage is unavailable.
    }
  };
  const restoreSidebarWidth = () => {
    try {
      setSidebarWidth(localStorage.getItem(widthStorageKey) ?? 260);
    } catch {
      setSidebarWidth(260);
    }
  };
  const setFiltersSidebarWidth = (value) => {
    const width = Number(value);
    if (!Number.isFinite(width)) return;
    const normalizedWidth = Math.min(420, Math.max(180, Math.round(width / 10) * 10));
    filtersSidebar.style.setProperty("--filters-sidebar-width", `${normalizedWidth}px`);
    try {
      localStorage.setItem(filtersWidthStorageKey, String(normalizedWidth));
    } catch {
      // The panel remains resizable for this session when storage is unavailable.
    }
  };
  const restoreFiltersSidebarWidth = () => {
    try {
      setFiltersSidebarWidth(localStorage.getItem(filtersWidthStorageKey) ?? 200);
    } catch {
      setFiltersSidebarWidth(200);
    }
  };
  const setGroupsSidebarWidth = (value) => {
    const width = Number(value);
    if (!Number.isFinite(width)) return;
    const normalizedWidth = Math.min(420, Math.max(180, Math.round(width / 10) * 10));
    groupsSidebar.style.setProperty("--garage-sidebar-width", `${normalizedWidth}px`);
    try {
      localStorage.setItem(groupsWidthStorageKey, String(normalizedWidth));
    } catch {
      // The panel remains resizable for this session when storage is unavailable.
    }
  };
  const restoreGroupsSidebarWidth = () => {
    try {
      setGroupsSidebarWidth(localStorage.getItem(groupsWidthStorageKey) ?? 260);
    } catch {
      setGroupsSidebarWidth(260);
    }
  };
  const getCloseWidth = () => (sidebar.closest(".workspace")?.getBoundingClientRect().width ?? 0) * closeThresholdRatio;
  const getFiltersCloseWidth = () => (garageWorkspace.getBoundingClientRect().width ?? 0) * closeThresholdRatio;
  const getGroupsCloseWidth = () => (garageWorkspace.getBoundingClientRect().width ?? 0) * closeThresholdRatio;
  const findVehicle = (id) => vehicles.find((vehicle) => vehicle.id === id) ?? null;
  const focusVehicleEditor = () => requestAnimationFrame(() => vehiclesList.querySelector(".garage-vehicle-editor__input")?.focus());
  const showSearch = () => { garageWorkspace.hidden = true; titlebar.hidden = true; workspace.hidden = false; searchShell.hidden = false; searchTabs.hidden = false; };
  const showVehicle = async (id) => {
    const isAnotherVehicle = selectedVehicle?.id !== id;
    const { payload } = await api(`/api/garage/vehicles/${encodeURIComponent(id)}`);
    selectedVehicle = payload.vehicle;
    if (isAnotherVehicle || (typeof selectedGroupId === "string" && !selectedVehicle.groups.some((group) => group.id === selectedGroupId))) selectedGroupId = undefined;
    viewName.textContent = selectedVehicle.name;
    workspace.hidden = true;
    searchShell.hidden = true;
    searchTabs.hidden = true;
    titlebar.hidden = false;
    garageWorkspace.hidden = false;
    setFiltersOpen(true);
    setStatus("");
    renderItems();
    await loadVehicles();
  };
  const loadVehicles = async () => {
    const { payload } = await api(`/api/garage/vehicles?search=${encodeURIComponent(search.value)}`);
    vehicles = payload.vehicles;
    renderVehicles();
    renderModalVehicles();
  };
  const renderVehicles = () => {
    vehiclesList.replaceChildren();
    if (editingVehicle?.mode === "create") {
      vehiclesList.append(renderVehicleEditor());
    }
    for (const vehicle of vehicles) {
      if (editingVehicle?.vehicleId === vehicle.id) {
        vehiclesList.append(renderVehicleEditor(vehicle));
        continue;
      }
      if (deletingVehicleId === vehicle.id) {
        vehiclesList.append(renderVehicleDelete(vehicle));
        continue;
      }
      const item = element("li", undefined, "garage-vehicles__item");
      const button = element("button", vehicle.name, "garage-vehicles__button");
      button.type = "button";
      button.dataset.vehicleId = vehicle.id;
      button.addEventListener("click", () => showVehicle(vehicle.id).catch((error) => setStatus(error.message)));
      button.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        showContextMenu(vehicle, event.clientX, event.clientY, button);
      });
      button.addEventListener("keydown", (event) => {
        if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
          event.preventDefault();
          const bounds = button.getBoundingClientRect();
          showContextMenu(vehicle, bounds.left + 16, bounds.top + 16, button);
        }
      });
      item.addEventListener("dragenter", (event) => { event.preventDefault(); item.classList.add("is-drop-target"); });
      item.addEventListener("dragover", (event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; });
      item.addEventListener("dragleave", (event) => { if (!item.contains(event.relatedTarget)) item.classList.remove("is-drop-target"); });
      item.addEventListener("drop", (event) => { event.preventDefault(); event.stopPropagation(); item.classList.remove("is-drop-target"); openAdd(event.dataTransfer?.getData("application/x-garage-offer"), vehicle.id, event.dataTransfer?.getData("application/x-garage-offer-quantity")); });
      item.append(button);
      vehiclesList.append(item);
    }
  };
  const renderVehicleEditor = (vehicle = null) => {
    const item = element("li", undefined, "garage-vehicle-editor");
    const form = document.createElement("form");
    form.className = "garage-vehicle-editor__form";
    const input = document.createElement("input");
    input.className = "garage-vehicle-editor__input";
    input.type = "text";
    input.maxLength = 120;
    input.autocomplete = "off";
    input.placeholder = "Наименование автомобиля";
    input.value = vehicle?.name ?? "";
    input.setAttribute("aria-label", "Наименование автомобиля");
    const isCreating = vehicle === null;
    const save = element("button", "Сохранить", "btn btn-primary garage-inline-action garage-vehicle-editor__save");
    save.type = "submit";
    const cancel = element("button", "Отмена", "btn btn-light garage-inline-action");
    cancel.type = "button";
    cancel.addEventListener("click", () => {
      editingVehicle = null;
      renderVehicles();
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const name = input.value.trim();
      if (!name) {
        if (isCreating) {
          editingVehicle = null;
          renderVehicles();
        } else {
          input.focus();
        }
        return;
      }
      save.disabled = true;
      cancel.disabled = true;
      try {
        if (vehicle) {
          const { payload } = await api(`/api/garage/vehicles/${vehicle.id}`, { method: "PATCH", body: JSON.stringify({ revision: vehicle.revision, name }) });
          if (selectedVehicle?.id === vehicle.id) {
            selectedVehicle = { ...selectedVehicle, ...payload.vehicle };
            viewName.textContent = selectedVehicle.name;
          }
        } else {
          await api("/api/garage/vehicles", { method: "POST", body: JSON.stringify({ name }) });
        }
        editingVehicle = null;
        await loadVehicles();
      } catch (error) {
        setStatus(error.message);
        save.disabled = false;
        cancel.disabled = false;
        input.focus();
      }
    });
    if (isCreating) {
      form.addEventListener("focusout", () => {
        queueMicrotask(() => {
          if (editingVehicle?.mode === "create" && !input.value.trim() && !form.contains(document.activeElement)) {
            editingVehicle = null;
            renderVehicles();
          }
        });
      });
      form.append(input);
    } else {
      form.append(input, save, cancel);
    }
    item.append(form);
    return item;
  };
  const renderVehicleDelete = (vehicle) => {
    const item = element("li", undefined, "garage-vehicle-delete");
    item.append(element("span", `Удалить «${vehicle.name}» и все позиции?`));
    const actions = element("div", undefined, "garage-vehicle-delete__actions");
    const confirm = element("button", "Удалить", "btn garage-inline-action garage-vehicle-delete__confirm");
    confirm.type = "button";
    const cancel = element("button", "Отмена", "btn btn-light garage-inline-action");
    cancel.type = "button";
    cancel.addEventListener("click", () => {
      deletingVehicleId = null;
      renderVehicles();
    });
    confirm.addEventListener("click", async () => {
      confirm.disabled = true;
      cancel.disabled = true;
      try {
        await api(`/api/garage/vehicles/${vehicle.id}`, { method: "DELETE", body: JSON.stringify({ revision: vehicle.revision }) });
        deletingVehicleId = null;
        if (selectedVehicle?.id === vehicle.id) {
          selectedVehicle = null;
          showSearch();
        }
        await loadVehicles();
      } catch (error) {
        setStatus(error.message);
        confirm.disabled = false;
        cancel.disabled = false;
      }
    });
    actions.append(confirm, cancel);
    item.append(actions);
    return item;
  };
  const hideContextMenu = (restoreFocus = false) => {
    contextMenu.hidden = true;
    contextVehicleId = null;
    if (restoreFocus && contextMenuAnchor?.isConnected) contextMenuAnchor.focus();
    contextMenuAnchor = null;
  };
  const showContextMenu = (vehicle, clientX, clientY, anchor) => {
    contextVehicleId = vehicle.id;
    contextMenuAnchor = anchor;
    contextMenu.hidden = false;
    const bounds = contextMenu.getBoundingClientRect();
    contextMenu.style.left = `${Math.max(8, Math.min(clientX, window.innerWidth - bounds.width - 8))}px`;
    contextMenu.style.top = `${Math.max(8, Math.min(clientY, window.innerHeight - bounds.height - 8))}px`;
    renameButton.focus();
  };
  const hideItemMenu = (restoreFocus = false) => {
    itemMenu.hidden = true;
    itemMenuItemId = null;
    if (restoreFocus && itemMenuAnchor?.isConnected) itemMenuAnchor.focus();
    itemMenuAnchor = null;
  };
  const hideGroupContextMenu = (restoreFocus = false) => {
    groupContextMenu.hidden = true;
    contextGroupId = null;
    if (restoreFocus && groupContextMenuAnchor?.isConnected) groupContextMenuAnchor.focus();
    groupContextMenuAnchor = null;
  };
  const showGroupContextMenu = (group, clientX, clientY, anchor) => {
    contextGroupId = group.id;
    groupContextMenuAnchor = anchor;
    groupContextMenu.hidden = false;
    const bounds = groupContextMenu.getBoundingClientRect();
    groupContextMenu.style.left = `${Math.max(8, Math.min(clientX, window.innerWidth - bounds.width - 8))}px`;
    groupContextMenu.style.top = `${Math.max(8, Math.min(clientY, window.innerHeight - bounds.height - 8))}px`;
    groupRenameButton.focus();
  };
  const openGroupEditor = (group = null) => {
    editingGroupId = group?.id ?? null;
    groupName.value = group?.name ?? "";
    groupSave.textContent = group ? "Сохранить" : "Создать";
    groupForm.hidden = false;
    requestAnimationFrame(() => groupName.focus());
  };
  const closeGroupEditor = () => {
    editingGroupId = null;
    groupName.value = "";
    groupSave.textContent = "Создать";
    groupForm.hidden = true;
  };
  const showItemMenu = (item, clientX, clientY, anchor) => {
    if (itemMenuItemId === item.id && !itemMenu.hidden) {
      hideItemMenu(true);
      return;
    }
    itemMenuItemId = item.id;
    itemMenuAnchor = anchor;
    itemMenuGroups.replaceChildren();
    const appendMoveAction = (groupId, name) => {
      const button = element("button", name, "garage-item-menu__move");
      button.type = "button";
      button.role = "menuitem";
      button.disabled = item.groupId === groupId;
      button.addEventListener("click", () => {
        hideItemMenu();
        moveItemToGroup(item.id, groupId).catch((error) => { setStatus(error.message); showToast(error.message, "error"); });
      });
      itemMenuGroups.append(button);
    };
    appendMoveAction(null, "Убрать из группы");
    for (const group of selectedVehicle.groups) appendMoveAction(group.id, group.name);
    itemMenu.hidden = false;
    const bounds = itemMenu.getBoundingClientRect();
    itemMenu.style.left = `${Math.max(8, Math.min(clientX, window.innerWidth - bounds.width - 8))}px`;
    itemMenu.style.top = `${Math.max(8, Math.min(clientY, window.innerHeight - bounds.height - 8))}px`;
    itemMenu.querySelector("button:not(:disabled)")?.focus();
  };
  const renderModalVehicles = () => {
    modalVehicles.replaceChildren();
    const term = modalSearch.value.trim().toLocaleLowerCase("ru-RU");
    for (const vehicle of vehicles.filter((candidate) => candidate.name.toLocaleLowerCase("ru-RU").includes(term))) {
      const button = element("button", vehicle.name, "btn btn-light garage-add-modal__vehicle");
      button.type = "button";
      button.dataset.vehicleId = vehicle.id;
      if (vehicle.id === selectedAddVehicleId) button.classList.add("is-selected");
      button.addEventListener("click", () => { selectAddVehicle(vehicle.id).catch((error) => showToast(error.message, "error")); });
      modalVehicles.append(button);
    }
  };
  const renderModalGroups = (groups = []) => {
    modalGroup.replaceChildren(element("option", "Без группы"));
    modalGroup.firstElementChild.value = "";
    for (const group of groups) {
      const option = element("option", group.name);
      option.value = group.id;
      modalGroup.append(option);
    }
    modalGroupField.hidden = !selectedAddVehicleId;
  };
  const selectAddVehicle = async (vehicleId) => {
    selectedAddVehicleId = vehicleId;
    modalConfirm.disabled = false;
    modalVehicles.querySelectorAll("button").forEach((item) => item.classList.toggle("is-selected", item.dataset.vehicleId === vehicleId));
    const { payload } = await api(`/api/garage/vehicles/${encodeURIComponent(vehicleId)}`);
    if (selectedAddVehicleId === vehicleId) renderModalGroups(payload.vehicle.groups);
  };
  const garageSortValue = (item, key) => {
    if (key === "availability") return item.supplierQuantity ?? -1;
    if (key === "quantity") return item.requiredQuantity;
    if (key === "price") return item.regularPrice;
    if (key === "sum") return item.regularPrice * item.requiredQuantity;
    if (key === "deliveryDate") {
      const timestamp = item.deliveryDate ? new Date(item.deliveryDate).getTime() : Number.NaN;
      return Number.isFinite(timestamp) ? timestamp : Number.POSITIVE_INFINITY;
    }
    return item[key] ?? "";
  };
  const updateGarageSortHeaders = () => {
    for (const button of garageSortButtons) {
      const active = button.dataset.garageSortKey === garageSortState.key;
      button.classList.toggle("is-active", active);
      button.closest("th")?.setAttribute("aria-sort", active ? garageSortState.direction : "none");
    }
  };
  const compareGarageItems = (left, right) => {
    const leftValue = garageSortValue(left, garageSortState.key);
    const rightValue = garageSortValue(right, garageSortState.key);
    const comparison = typeof leftValue === "number" && typeof rightValue === "number"
      ? leftValue - rightValue
      : String(leftValue).localeCompare(String(rightValue), "ru-RU", { numeric: true, sensitivity: "base" });
    if (comparison !== 0) return garageSortState.direction === "ascending" ? comparison : -comparison;
    return left.title.localeCompare(right.title, "ru-RU", { numeric: true, sensitivity: "base" });
  };
  const updateGarageResultCount = (items) => {
    const suppliers = new Map();
    for (const item of items) suppliers.set(item.supplier, (suppliers.get(item.supplier) ?? 0) + 1);
    const breakdown = [...suppliers].map(([supplier, count]) => `${supplier}: ${count} позиций`).join("\n");
    resultCount.textContent = String(items.length);
    resultCount.dataset.tooltip = breakdown;
    resultCount.title = `Показано предложений: ${items.length}`;
    resultCount.setAttribute("aria-label", breakdown ? `По поставщикам:\n${breakdown}` : "Нет предложений");
  };
  const sumGarageItems = (items) => items.reduce((sum, item) => sum + item.regularPrice * item.requiredQuantity, 0);
  const sumGaragePurchaseItems = (items) => items.reduce((sum, item) => sum + item.purchasePrice * item.requiredQuantity, 0);
  const renderGarageTotal = (items) => {
    const retail = element("strong", `Итого: ${formatPrice(sumGarageItems(items))}`);
    const purchase = element("span", `Закуп: ${formatPrice(sumGaragePurchaseItems(items))}`, "garage-total__purchase");
    total.replaceChildren(retail, purchase);
  };
  const groupItems = (items) => {
    const groups = selectedVehicle.groups.map((group) => ({ id: group.id, name: group.name }));
    const byId = new Map(groups.map((group) => [group.id, []]));
    const ungrouped = [];
    for (const item of items) {
      const group = item.groupId ? byId.get(item.groupId) : null;
      if (group) group.push(item); else ungrouped.push(item);
    }
    const sections = groups.map((group) => ({ ...group, items: byId.get(group.id) ?? [] })).filter((group) => group.items.length);
    if (ungrouped.length || !groups.length) sections.push({ id: null, name: groups.length ? "Другие товары" : "Все товары", items: ungrouped });
    return sections;
  };
  const appendGroupSummary = (name, items) => {
    const row = element("tr", undefined, "garage-group-summary");
    const cell = document.createElement("td");
    cell.colSpan = getGarageVisibleColumns().length + 1;
    const content = element("div", undefined, "garage-group-summary__content");
    content.append(element("strong", name), element("span", formatPrice(sumGarageItems(items))));
    cell.append(content);
    row.append(cell);
    itemsBody.append(row);
  };
  const moveItemToGroup = async (itemId, groupId) => {
    const item = selectedVehicle?.items.find((candidate) => candidate.id === itemId);
    if (!item || item.groupId === groupId) return;
    await api(`/api/garage/items/${item.id}`, { method: "PATCH", body: JSON.stringify({ revision: item.revision, requiredQuantity: item.requiredQuantity, comment: item.comment, groupId }) });
    await showVehicle(selectedVehicle.id);
    showToast("Товар перемещён в группу.", "success");
  };
  const renderGarageGroups = () => {
    groupsList.replaceChildren();
    const appendGroup = (id, name, items, canDrop = true) => {
      const listItem = element("li", undefined, "garage-vehicles__item garage-group-item");
      const button = element("button", undefined, "garage-vehicles__button garage-group-item__button");
      button.type = "button";
      button.setAttribute("aria-pressed", String(selectedGroupId === id));
      button.append(element("span", name), element("span", `${items.length} · ${formatPrice(sumGarageItems(items))}`, "garage-group-item__meta"));
      button.addEventListener("click", () => {
        selectedGroupId = selectedGroupId === id ? undefined : id;
        renderItems();
      });
      if (typeof id === "string") {
        button.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          const group = selectedVehicle.groups.find((candidate) => candidate.id === id);
          if (group) showGroupContextMenu(group, event.clientX, event.clientY, button);
        });
        button.addEventListener("keydown", (event) => {
          if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
            event.preventDefault();
            const group = selectedVehicle.groups.find((candidate) => candidate.id === id);
            const bounds = button.getBoundingClientRect();
            if (group) showGroupContextMenu(group, bounds.left + 16, bounds.top + 16, button);
          }
        });
      }
      const hasDraggedItem = (event) => Array.from(event.dataTransfer?.types ?? []).includes("application/x-garage-item");
      listItem.addEventListener("dragenter", (event) => { if (canDrop && hasDraggedItem(event)) { event.preventDefault(); listItem.classList.add("is-drop-target"); } });
      listItem.addEventListener("dragover", (event) => { if (canDrop && hasDraggedItem(event)) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } });
      listItem.addEventListener("dragleave", (event) => { if (!listItem.contains(event.relatedTarget)) listItem.classList.remove("is-drop-target"); });
      listItem.addEventListener("drop", (event) => {
        const itemId = event.dataTransfer?.getData("application/x-garage-item");
        listItem.classList.remove("is-drop-target");
        if (!canDrop || !itemId) return;
        event.preventDefault();
        moveItemToGroup(itemId, id).catch((error) => { setStatus(error.message); showToast(error.message, "error"); });
      });
      listItem.append(button);
      groupsList.append(listItem);
    };
    appendGroup(undefined, "Все группы", selectedVehicle.items, false);
    for (const group of selectedVehicle.groups) appendGroup(group.id, group.name, selectedVehicle.items.filter((item) => item.groupId === group.id));
  };
  const getGarageFilterValue = (item, column) => {
    if (column === "supplier") return item.supplier;
    if (column === "brand") return formatBrand(item.brand);
    if (column === "article") return formatArticle(item.article);
    return formatQuantity(item.supplierQuantity);
  };
  const renderGarageFilters = () => {
    for (const [column, container] of Object.entries(filterContainers)) {
      const values = [...new Set(selectedVehicle.items.map((item) => getGarageFilterValue(item, column)))].sort((left, right) => left.localeCompare(right, "ru-RU", { numeric: true, sensitivity: "base" }));
      const selected = selectedFilterValues.get(column);
      container.replaceChildren(...values.map((value) => {
        const button = element("button", value, "filters-sidebar__value");
        button.type = "button";
        button.dataset.garageFilterColumn = column;
        button.dataset.garageFilterValue = value;
        button.setAttribute("aria-pressed", String(selected.has(value)));
        button.addEventListener("click", () => {
          if (selected.has(value)) selected.delete(value); else selected.add(value);
          renderItems();
        });
        return button;
      }));
    }
    filtersReset.hidden = ![...selectedFilterValues.values()].some((values) => values.size > 0);
  };
  const getGarageVisibleColumns = () => [
    "supplier", "brand", "article", "title", "deliveryDate", "availability", "quantity", "price", "sum",
  ];
  const applyGarageTableColumns = () => {
    const columns = getGarageVisibleColumns();
    const minimumWidth = columns.reduce((width, column) => width + garageColumnWidths[column], garageActionColumnWidth);
    view.style.setProperty("--results-table-min-width", `${minimumWidth}px`);
    view.querySelectorAll("th[data-garage-column]").forEach((header) => {
      const width = garageColumnWidths[header.dataset.garageColumn];
      header.style.width = !header.hidden && width ? `${width / minimumWidth * 100}%` : "";
    });
  };
  const renderItems = () => {
    itemsBody.replaceChildren();
    updateGarageSortHeaders();
    const groupedItems = selectedGroupId === undefined
      ? selectedVehicle.items
      : selectedVehicle.items.filter((item) => item.groupId === selectedGroupId);
    updateGarageResultCount(groupedItems);
    renderGarageTotal(groupedItems);
    renderGarageFilters();
    renderGarageGroups();
    applyGarageTableColumns();
    const term = garageTableSearchTerm.toLocaleLowerCase("ru-RU");
    const visibleItems = groupedItems.filter((item) => [formatBrand(item.brand), formatArticle(item.article), item.title]
      .some((value) => value.toLocaleLowerCase("ru-RU").includes(term))
      && [...selectedFilterValues].every(([column, values]) => values.size === 0 || values.has(getGarageFilterValue(item, column))));
    if (!visibleItems.length) {
      const empty = element("tr", undefined, "results-table__empty");
      const emptyCell = element("td", "Нет позиций с выбранным условием.");
      emptyCell.colSpan = getGarageVisibleColumns().length + 1;
      empty.append(emptyCell);
      itemsBody.append(empty);
      return;
    }
    for (const group of groupItems(visibleItems)) {
      appendGroupSummary(group.name, group.items);
      for (const item of [...group.items].sort(compareGarageItems)) {
      const row = element("tr", undefined, item.availabilityStatus === "available" || item.availabilityStatus === "unknown" ? "" : "garage-item--problem");
      const cells = [["supplier", item.supplier], ["brand", formatBrand(item.brand)], ["article", formatArticle(item.article)], ["title", item.title], ["deliveryDate", formatDeliveryDate(item.deliveryDate)], ["availability", formatQuantity(item.supplierQuantity)]];
      for (const [column, value] of cells) {
        const cell = element("td");
        cell.dataset.garageColumn = column;
        if (column === "article" || column === "title") {
          appendOfferLink(cell, item, value, column === "title");
        } else {
          cell.textContent = value;
        }
        row.append(cell);
      }
      const requiredCell = document.createElement("td"); requiredCell.dataset.garageColumn = "quantity";
      const requiredDisplay = element("button", formatQuantity(item.requiredQuantity), "garage-quantity-display"); requiredDisplay.type = "button"; requiredDisplay.setAttribute("aria-label", `Изменить количество: ${item.title}`);
      const restoreQuantityDisplay = () => requiredCell.replaceChildren(requiredDisplay);
      requiredDisplay.addEventListener("click", () => {
        const required = document.createElement("input"); required.className = "garage-quantity-input"; required.type = "number"; required.min = "0.001"; required.step = "0.001"; if (typeof item.supplierQuantity === "number" && item.supplierQuantity >= 0) required.max = String(item.supplierQuantity); required.value = String(item.requiredQuantity); required.setAttribute("aria-label", `Количество: ${item.title}`);
        required.addEventListener("change", async () => {
          const requiredQuantity = Number(required.value);
          if (!Number.isFinite(requiredQuantity) || requiredQuantity <= 0) {
            showToast("Укажите количество больше нуля.", "error");
            restoreQuantityDisplay();
            return;
          }
          required.disabled = true;
          try {
            await api(`/api/garage/items/${item.id}`, { method: "PATCH", body: JSON.stringify({ revision: item.revision, requiredQuantity, comment: item.comment }) });
            await showVehicle(selectedVehicle.id);
          } catch (error) {
            setStatus(error.message);
            showToast(error.message, "error");
            restoreQuantityDisplay();
          }
        });
        required.addEventListener("blur", () => { if (!required.disabled) restoreQuantityDisplay(); });
        requiredCell.replaceChildren(required);
        required.focus();
        required.select();
      });
      requiredCell.append(requiredDisplay); row.append(requiredCell);
      const regularPriceCell = document.createElement("td"); regularPriceCell.dataset.garageColumn = "price";
      regularPriceCell.append(element("span", formatPrice(item.regularPrice), "main-result-price"), element("span", formatPrice(item.purchasePrice), "main-result-purchase-price"));
      row.append(regularPriceCell);
      const sumCell = element("td", formatPrice(item.regularPrice * item.requiredQuantity)); sumCell.dataset.garageColumn = "sum"; row.append(sumCell);
      const actions = document.createElement("td"); actions.className = "garage-actions-cell";
      const menu = element("button", "⋮", "garage-item-menu-toggle");
      menu.type = "button";
      menu.draggable = true;
      menu.title = "Действия с товаром";
      menu.setAttribute("aria-label", `Действия с «${item.title}»: перетащите в группу или откройте меню`);
      menu.addEventListener("click", (event) => {
        event.stopPropagation();
        showItemMenu(item, event.clientX, event.clientY, menu);
      });
      menu.addEventListener("dragstart", (event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("application/x-garage-item", item.id);
        setGroupsOpen(true);
      });
      actions.append(menu); row.append(actions); itemsBody.append(row);
      }
    }
  };
  const openAdd = (offerId, vehicleId = null, supplierQuantity = null) => {
    if (!offerId) {
      showToast("Позиция устарела. Повторите поиск, чтобы добавить её в гараж.", "error");
      return;
    }
    if (!vehicles.length) {
      showToast("Сначала создайте автомобиль, затем добавьте в него товар.");
      return;
    }
    const vehicle = vehicleId ? findVehicle(vehicleId) : null;
    pendingOfferId = offerId;
    pendingOfferQuantity = supplierQuantity;
    selectedAddVehicleId = vehicle?.id ?? null;
    const hasSelectedVehicle = Boolean(vehicle);
    modal.dataset.vehicleSelected = String(hasSelectedVehicle);
    modalTitle.textContent = hasSelectedVehicle ? `Добавить в «${vehicle.name}»` : "Добавить в автомобиль";
    modalVehiclePicker.hidden = hasSelectedVehicle;
    modalVehicles.hidden = hasSelectedVehicle;
    modalConfirm.disabled = !hasSelectedVehicle;
    modalConfirm.hidden = hasSelectedVehicle;
    modalDuplicate.hidden = true;
    modal.hidden = false;
    modalSearch.value = "";
    modalQuantity.value = "1";
    setModalQuantityMaximum(pendingOfferQuantity);
    renderModalGroups(selectedVehicle?.id === selectedAddVehicleId ? selectedVehicle.groups : []);
    if (selectedAddVehicleId && selectedVehicle?.id !== selectedAddVehicleId) {
      selectAddVehicle(selectedAddVehicleId).catch((error) => showToast(error.message, "error"));
    }
    renderModalVehicles();
    requestAnimationFrame(() => (hasSelectedVehicle ? modalQuantity : modalSearch).focus());
  };
  const closeModal = () => {
    modal.hidden = true;
    modal.dataset.vehicleSelected = "false";
    modalTitle.textContent = "Добавить в автомобиль";
    modalVehiclePicker.hidden = false;
    modalVehicles.hidden = false;
    modalConfirm.hidden = false;
    modalDuplicate.hidden = true;
    pendingOfferId = null;
    pendingOfferQuantity = null;
    setModalQuantityMaximum(null);
    selectedAddVehicleId = null;
    renderModalGroups();
  };
  toggle.addEventListener("click", () => setSidebarOpen(sidebar.hidden));
  sidebar.addEventListener("dragenter", (event) => { event.preventDefault(); sidebar.classList.add("is-drop-target"); });
  sidebar.addEventListener("dragover", (event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; });
  sidebar.addEventListener("dragleave", (event) => { if (!sidebar.contains(event.relatedTarget)) sidebar.classList.remove("is-drop-target"); });
  sidebar.addEventListener("drop", (event) => { event.preventDefault(); sidebar.classList.remove("is-drop-target"); openAdd(event.dataTransfer?.getData("application/x-garage-offer"), null, event.dataTransfer?.getData("application/x-garage-offer-quantity")); });
  resize.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    resizeStart = { pointerId: event.pointerId, startX: event.clientX, startWidth: sidebar.getBoundingClientRect().width };
    resize.setPointerCapture(event.pointerId);
  });
  resize.addEventListener("pointermove", (event) => {
    if (!resizeStart || event.pointerId !== resizeStart.pointerId) return;
    const width = resizeStart.startWidth + resizeStart.startX - event.clientX;
    if (width <= getCloseWidth()) {
      resizeStart = null;
      resize.releasePointerCapture(event.pointerId);
      setSidebarOpen(false);
      return;
    }
    setSidebarWidth(width);
  });
  const stopResize = (event) => {
    if (resizeStart && event.pointerId === resizeStart.pointerId) resizeStart = null;
  };
  resize.addEventListener("pointerup", stopResize);
  resize.addEventListener("pointercancel", stopResize);
  resize.addEventListener("lostpointercapture", () => { resizeStart = null; });
  resize.addEventListener("keydown", (event) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const width = sidebar.getBoundingClientRect().width;
    if (event.key === "ArrowRight" && width <= 180) {
      setSidebarOpen(false);
      return;
    }
    setSidebarWidth(width + (event.key === "ArrowLeft" ? 10 : -10));
  });
  filtersResize.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    filtersResizeStart = { pointerId: event.pointerId, startX: event.clientX, startWidth: filtersSidebar.getBoundingClientRect().width };
    filtersResize.setPointerCapture(event.pointerId);
  });
  filtersResize.addEventListener("pointermove", (event) => {
    if (!filtersResizeStart || event.pointerId !== filtersResizeStart.pointerId) return;
    const width = filtersResizeStart.startWidth + event.clientX - filtersResizeStart.startX;
    if (width <= getFiltersCloseWidth()) {
      filtersResizeStart = null;
      filtersResize.releasePointerCapture(event.pointerId);
      setFiltersOpen(false);
      return;
    }
    setFiltersSidebarWidth(width);
  });
  const stopFiltersResize = (event) => {
    if (filtersResizeStart && event.pointerId === filtersResizeStart.pointerId) filtersResizeStart = null;
  };
  filtersResize.addEventListener("pointerup", stopFiltersResize);
  filtersResize.addEventListener("pointercancel", stopFiltersResize);
  filtersResize.addEventListener("lostpointercapture", () => { filtersResizeStart = null; });
  filtersResize.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const width = filtersSidebar.getBoundingClientRect().width;
    if (event.key === "ArrowLeft" && width <= 180) {
      setFiltersOpen(false);
      return;
    }
    setFiltersSidebarWidth(width + (event.key === "ArrowRight" ? 10 : -10));
  });
  groupsResize.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    groupsResizeStart = { pointerId: event.pointerId, startX: event.clientX, startWidth: groupsSidebar.getBoundingClientRect().width };
    groupsResize.setPointerCapture(event.pointerId);
  });
  groupsResize.addEventListener("pointermove", (event) => {
    if (!groupsResizeStart || event.pointerId !== groupsResizeStart.pointerId) return;
    const width = groupsResizeStart.startWidth + groupsResizeStart.startX - event.clientX;
    if (width <= getGroupsCloseWidth()) {
      groupsResizeStart = null;
      groupsResize.releasePointerCapture(event.pointerId);
      setGroupsOpen(false);
      return;
    }
    setGroupsSidebarWidth(width);
  });
  const stopGroupsResize = (event) => {
    if (groupsResizeStart && event.pointerId === groupsResizeStart.pointerId) groupsResizeStart = null;
  };
  groupsResize.addEventListener("pointerup", stopGroupsResize);
  groupsResize.addEventListener("pointercancel", stopGroupsResize);
  groupsResize.addEventListener("lostpointercapture", () => { groupsResizeStart = null; });
  groupsResize.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const width = groupsSidebar.getBoundingClientRect().width;
    if (event.key === "ArrowRight" && width <= 180) {
      setGroupsOpen(false);
      return;
    }
    setGroupsSidebarWidth(width + (event.key === "ArrowLeft" ? 10 : -10));
  });
  searchForm.addEventListener("submit", (event) => event.preventDefault());
  search.addEventListener("input", () => loadVehicles().catch((error) => setStatus(error.message)));
  tableSearch.addEventListener("input", () => { garageTableSearchTerm = tableSearch.value.trim(); renderItems(); });
  filtersToggle.addEventListener("click", () => setFiltersOpen(filtersSidebar.hidden));
  groupsToggle.addEventListener("click", () => setGroupsOpen(groupsSidebar.hidden));
  groupCreate.addEventListener("click", () => openGroupEditor());
  groupCancel.addEventListener("click", closeGroupEditor);
  filtersReset.addEventListener("click", () => {
    selectedFilterValues.forEach((values) => values.clear());
    renderItems();
  });
  groupForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!selectedVehicle) return;
    const name = groupName.value.trim();
    if (!name) return;
    try {
      const { payload: currentVehiclePayload } = await api(`/api/garage/vehicles/${selectedVehicle.id}`);
      const vehicleRevision = currentVehiclePayload?.vehicle?.revision;
      if (!Number.isInteger(vehicleRevision)) throw new Error("Не удалось обновить данные автомобиля.");
      if (editingGroupId) {
        await api(`/api/garage/vehicles/${selectedVehicle.id}/groups/${editingGroupId}`, { method: "PATCH", body: JSON.stringify({ vehicleRevision, name }) });
        showToast(`Группа переименована в «${name}».`, "success");
      } else {
        await api(`/api/garage/vehicles/${selectedVehicle.id}/groups`, { method: "POST", body: JSON.stringify({ vehicleRevision, name }) });
        showToast(`Группа «${name}» создана.`, "success");
      }
      closeGroupEditor();
      await showVehicle(selectedVehicle.id);
    } catch (error) {
      setStatus(error.message);
      showToast(error.message, "error");
    }
  });
  groupRenameButton.addEventListener("click", () => {
    const group = selectedVehicle?.groups.find((candidate) => candidate.id === contextGroupId);
    hideGroupContextMenu();
    if (group) openGroupEditor(group);
  });
  groupDeleteButton.addEventListener("click", async () => {
    const group = selectedVehicle?.groups.find((candidate) => candidate.id === contextGroupId);
    hideGroupContextMenu();
    if (!group) return;
    groupDeleteButton.disabled = true;
    try {
      const { payload } = await api(`/api/garage/vehicles/${selectedVehicle.id}`);
      await api(`/api/garage/vehicles/${selectedVehicle.id}/groups/${group.id}`, { method: "DELETE", body: JSON.stringify({ vehicleRevision: payload.vehicle.revision }) });
      if (selectedGroupId === group.id) selectedGroupId = undefined;
      await showVehicle(selectedVehicle.id);
      showToast(`Группа «${group.name}» удалена. Товары остались без группы.`, "success");
    } catch (error) {
      setStatus(error.message);
      showToast(error.message, "error");
    } finally {
      groupDeleteButton.disabled = false;
    }
  });
  itemDeleteButton.addEventListener("click", async () => {
    const item = selectedVehicle?.items.find((candidate) => candidate.id === itemMenuItemId);
    hideItemMenu();
    if (!item) return;
    itemDeleteButton.disabled = true;
    try {
      await api(`/api/garage/items/${item.id}`, { method: "DELETE", body: JSON.stringify({ revision: item.revision }) });
      await showVehicle(selectedVehicle.id);
      showToast("Товар удалён.", "success");
    } catch (error) {
      setStatus(error.message);
      showToast(error.message, "error");
    } finally {
      itemDeleteButton.disabled = false;
    }
  });
  modalSearch.addEventListener("input", renderModalVehicles);
  create.addEventListener("click", () => {
    deletingVehicleId = null;
    editingVehicle = { mode: "create" };
    renderVehicles();
    focusVehicleEditor();
  });
  renameButton.addEventListener("click", () => {
    const vehicle = findVehicle(contextVehicleId);
    hideContextMenu();
    if (!vehicle) return;
    deletingVehicleId = null;
    editingVehicle = { mode: "rename", vehicleId: vehicle.id };
    renderVehicles();
    focusVehicleEditor();
  });
  deleteButton.addEventListener("click", () => {
    const vehicle = findVehicle(contextVehicleId);
    hideContextMenu();
    if (!vehicle) return;
    editingVehicle = null;
    deletingVehicleId = vehicle.id;
    renderVehicles();
  });
  back.addEventListener("click", showSearch);
  garageSortButtons.forEach((button) => button.addEventListener("click", () => {
    const key = button.dataset.garageSortKey;
    if (!key) return;
    garageSortState = garageSortState.key === key
      ? { key, direction: garageSortState.direction === "ascending" ? "descending" : "ascending" }
      : { key, direction: "ascending" };
    renderItems();
  }));
  refresh.addEventListener("click", async () => { refresh.disabled = true; try { const { payload } = await api(`/api/garage/vehicles/${selectedVehicle.id}/refresh`, { method: "POST", body: JSON.stringify({ revision: selectedVehicle.revision }) }); selectedVehicle = payload.vehicle; renderItems(); await loadVehicles(); } catch (error) { setStatus(error.message); showToast(error.message, "error"); } finally { refresh.disabled = false; } });
  modal.querySelectorAll("[data-garage-close]").forEach((button) => button.addEventListener("click", closeModal));
  const addOfferToVehicle = async (duplicateStrategy) => {
    const vehicle = vehicles.find((item) => item.id === selectedAddVehicleId);
    if (!vehicle || !pendingOfferId) return;
    const requiredQuantity = Number(modalQuantity.value);
    const maximumQuantity = modalQuantity.max === "" ? null : Number(modalQuantity.max);
    if (maximumQuantity !== null && requiredQuantity > maximumQuantity) {
      modalQuantity.value = String(maximumQuantity);
      modalQuantity.focus();
      return;
    }
    try {
      const { payload: currentVehiclePayload } = await api(`/api/garage/vehicles/${vehicle.id}`);
      const currentVehicleRevision = currentVehiclePayload?.vehicle?.revision;
      if (!Number.isInteger(currentVehicleRevision)) throw new Error("Не удалось обновить данные автомобиля.");
      const result = await api(`/api/garage/vehicles/${vehicle.id}/items`, { method: "POST", body: JSON.stringify({ vehicleRevision: currentVehicleRevision, offerId: pendingOfferId, markupPercent: getMarkupPercent(), requiredQuantity, groupId: modalGroup.value || null, ...(duplicateStrategy ? { duplicateStrategy } : {}) }) }, true);
      if (result.response.status === 409 && result.payload?.duplicate && !duplicateStrategy) {
        const supplierQuantity = result.payload.duplicate.supplierQuantity;
        if (typeof supplierQuantity === "number" && supplierQuantity >= 0) {
          const remainingQuantity = Math.max(0, supplierQuantity - result.payload.duplicate.requiredQuantity);
          if (remainingQuantity < 0.001) {
            closeModal();
            showToast("Всё доступное количество уже добавлено в автомобиль.");
            return;
          }
          setModalQuantityMaximum(remainingQuantity);
          if (Number(modalQuantity.value) > remainingQuantity) modalQuantity.value = String(remainingQuantity);
        }
        modalConfirm.hidden = true;
        modalDuplicate.hidden = false;
        modalDuplicateIncrement.focus();
        return;
      }
      closeModal();
      await loadVehicles();
      if (selectedVehicle?.id === vehicle.id) await showVehicle(vehicle.id);
      showToast(`Товар добавлен в «${vehicle.name}».`, "success");
    } catch (error) {
      setStatus(error.message);
      showToast(error.message, "error");
    }
  };
  modalForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (selectedAddVehicleId) addOfferToVehicle();
  });
  modalDuplicateIncrement.addEventListener("click", () => addOfferToVehicle("increment"));
  modalDuplicateNew.addEventListener("click", () => addOfferToVehicle("new"));
  document.addEventListener("click", (event) => {
    if (!contextMenu.hidden && !contextMenu.contains(event.target)) hideContextMenu();
    if (!itemMenu.hidden && !itemMenu.contains(event.target)) hideItemMenu();
    if (!groupContextMenu.hidden && !groupContextMenu.contains(event.target)) hideGroupContextMenu();
    const button = event.target.closest(".garage-offer-button");
    if (button) openAdd(button.dataset.garageOfferId, null, button.dataset.garageOfferQuantity);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !contextMenu.hidden) hideContextMenu(true);
    if (event.key === "Escape" && !itemMenu.hidden) hideItemMenu(true);
    if (event.key === "Escape" && !groupContextMenu.hidden) hideGroupContextMenu(true);
  });
  window.addEventListener("resize", () => { hideContextMenu(true); hideItemMenu(true); hideGroupContextMenu(true); });
  window.addEventListener("scroll", () => { hideContextMenu(true); hideItemMenu(true); hideGroupContextMenu(true); }, true);
  document.addEventListener("dragstart", (event) => { const button = event.target.closest(".garage-offer-button"); if (button?.dataset.garageOfferId) { event.dataTransfer.effectAllowed = "copy"; event.dataTransfer.setData("application/x-garage-offer", button.dataset.garageOfferId); event.dataTransfer.setData("application/x-garage-offer-quantity", button.dataset.garageOfferQuantity ?? ""); setSidebarOpen(true); } });
  restoreSidebarWidth();
  restoreFiltersSidebarWidth();
  restoreGroupsSidebarWidth();
  loadVehicles().catch((error) => setStatus(error.message));
  setupColumnResizing({
    table: view.querySelector("table"),
    columnAttribute: "data-garage-column",
    widths: garageColumnWidths,
    apply: applyGarageTableColumns,
    save: () => saveColumnWidths("garage", garageColumnWidths),
  });
  return {
    applyColumnWidths(savedWidths) {
      Object.assign(garageColumnWidths, applySavedColumnWidths(garageColumnWidths, savedWidths));
      applyGarageTableColumns();
    },
  };
};
