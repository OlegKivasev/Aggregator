const api = async (path, options = {}) => {
  const response = await fetch(path, { headers: { "Content-Type": "application/json" }, ...options });
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok && response.status !== 409) throw new Error(payload?.message || "Не удалось выполнить действие в гараже");
  return { response, payload };
};

const element = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};

const price = (value) => Number.isFinite(value) ? `${value.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽` : "—";
const quantity = (value) => Number.isFinite(value) ? value.toLocaleString("ru-RU", { maximumFractionDigits: 3 }) : "—";

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
  const view = document.querySelector("#garage-view");
  const viewName = document.querySelector("#garage-vehicle-name");
  const itemsBody = document.querySelector("#garage-items");
  const status = document.querySelector("#garage-status");
  const back = document.querySelector("#garage-back");
  const refresh = document.querySelector("#garage-refresh");
  const priceToggle = document.querySelector("#garage-price-toggle");
  const purchasePriceHeading = document.querySelector("#garage-purchase-price-heading");
  const garageSortButtons = [...document.querySelectorAll("[data-garage-sort-key]")];
  const resize = document.querySelector("#garage-resize");
  const modal = document.querySelector("#garage-add-modal");
  const modalSearch = document.querySelector("#garage-add-search");
  const modalVehicles = document.querySelector("#garage-add-vehicles");
  const modalQuantity = document.querySelector("#garage-add-quantity");
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
  let showPurchase = false;
  let garageSortState = { key: "price", direction: "ascending" };
  let resizeStart = null;
  let editingVehicle = null;
  let deletingVehicleId = null;
  let contextVehicleId = null;
  let contextMenuAnchor = null;
  let toastTimer = null;
  const widthStorageKey = "autoservice-garage-sidebar-width-v1";
  const closeThresholdRatio = 0.02;

  const setStatus = (message) => { status.textContent = message; };
  const showToast = (message, tone = "info") => {
    if (toastTimer !== null) window.clearTimeout(toastTimer);
    toast.textContent = message;
    toast.dataset.tone = tone;
    toast.hidden = false;
    toastTimer = window.setTimeout(() => { toast.hidden = true; toastTimer = null; }, 4_000);
  };
  const setPurchasePricesVisible = (visible) => {
    showPurchase = visible;
    priceToggle.setAttribute("aria-pressed", String(visible));
    priceToggle.setAttribute("aria-label", visible ? "Скрыть закупочные цены" : "Показать закупочные цены");
    priceToggle.title = visible ? "Скрыть закупочные цены" : "Показать закупочные цены";
    purchasePriceHeading.hidden = !visible;
    if (selectedVehicle) renderItems();
  };
  const setSidebarOpen = (open) => {
    sidebar.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "Скрыть гараж" : "Открыть гараж");
    toggle.title = open ? "Скрыть гараж" : "Открыть гараж";
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
  const getCloseWidth = () => (sidebar.closest(".workspace")?.getBoundingClientRect().width ?? 0) * closeThresholdRatio;
  const findVehicle = (id) => vehicles.find((vehicle) => vehicle.id === id) ?? null;
  const focusVehicleEditor = () => requestAnimationFrame(() => vehiclesList.querySelector(".garage-vehicle-editor__input")?.focus());
  const showSearch = () => { view.hidden = true; workspace.hidden = false; searchShell.hidden = false; searchTabs.hidden = false; };
  const showVehicle = async (id) => {
    const { payload } = await api(`/api/garage/vehicles/${encodeURIComponent(id)}`);
    if (!payload.vehicle.items.length) {
      if (!view.hidden) showSearch();
      if (selectedVehicle?.id === id) selectedVehicle = null;
      showToast(`В «${payload.vehicle.name}» пока нет товаров. Добавьте позицию из результатов поиска.`);
      return;
    }
    selectedVehicle = payload.vehicle;
    viewName.textContent = selectedVehicle.name;
    workspace.hidden = true;
    searchShell.hidden = true;
    searchTabs.hidden = true;
    view.hidden = false;
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
      item.addEventListener("drop", (event) => { event.preventDefault(); event.stopPropagation(); item.classList.remove("is-drop-target"); openAdd(event.dataTransfer?.getData("application/x-garage-offer"), vehicle.id); });
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
  const renderModalVehicles = () => {
    modalVehicles.replaceChildren();
    const term = modalSearch.value.trim().toLocaleLowerCase("ru-RU");
    for (const vehicle of vehicles.filter((candidate) => candidate.name.toLocaleLowerCase("ru-RU").includes(term))) {
      const button = element("button", vehicle.name, "btn btn-light garage-add-modal__vehicle");
      button.type = "button";
      if (vehicle.id === selectedAddVehicleId) button.classList.add("is-selected");
      button.addEventListener("click", () => { selectedAddVehicleId = vehicle.id; modalConfirm.disabled = false; modalVehicles.querySelectorAll("button").forEach((item) => item.classList.remove("is-selected")); button.classList.add("is-selected"); });
      modalVehicles.append(button);
    }
  };
  const garageSortValue = (item, key) => {
    if (key === "availability") return item.supplierQuantity ?? -1;
    if (key === "quantity") return item.requiredQuantity;
    if (key === "price") return item.regularPrice;
    if (key === "purchasePrice") return item.purchasePrice;
    if (key === "sum") return item.regularPrice * item.requiredQuantity;
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
  const renderItems = () => {
    itemsBody.replaceChildren();
    updateGarageSortHeaders();
    for (const item of [...selectedVehicle.items].sort(compareGarageItems)) {
      const row = element("tr", undefined, item.availabilityStatus === "available" || item.availabilityStatus === "unknown" ? "" : "garage-item--problem");
      const cells = [["supplier", item.supplier], ["brand", item.brand], ["article", item.article], ["title", item.title], ["availability", `${quantity(item.supplierQuantity)} (${item.availabilityStatus})`]];
      for (const [column, value] of cells) {
        const cell = element("td", value);
        cell.dataset.garageColumn = column;
        row.append(cell);
      }
      const required = document.createElement("input"); required.className = "garage-quantity-input"; required.type = "number"; required.min = "0.001"; required.step = "0.001"; required.value = String(item.requiredQuantity); required.setAttribute("aria-label", `Количество: ${item.title}`);
      const requiredCell = document.createElement("td"); requiredCell.dataset.garageColumn = "quantity"; requiredCell.append(required); row.append(requiredCell);
      const regularPriceCell = element("td", price(item.regularPrice)); regularPriceCell.dataset.garageColumn = "price"; row.append(regularPriceCell);
      const purchasePriceCell = element("td", price(item.purchasePrice));
      purchasePriceCell.dataset.garageColumn = "purchase-price";
      purchasePriceCell.hidden = !showPurchase;
      row.append(purchasePriceCell);
      const sumCell = element("td", price(item.regularPrice * item.requiredQuantity)); sumCell.dataset.garageColumn = "sum"; row.append(sumCell);
      const actions = document.createElement("td"); actions.className = "garage-actions-cell";
      const remove = document.createElement("button"); remove.type = "button"; remove.className = "garage-item-remove"; remove.title = "Удалить товар"; remove.setAttribute("aria-label", `Удалить «${item.title}»`);
      const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg"); icon.setAttribute("viewBox", "0 0 24 24"); icon.setAttribute("aria-hidden", "true");
      ["M4 7h16", "M10 11v6", "M14 11v6", "M6.5 7 7.5 20h9l1-13", "M9 7V4h6v3"].forEach((pathData) => { const path = document.createElementNS("http://www.w3.org/2000/svg", "path"); path.setAttribute("d", pathData); icon.append(path); });
      remove.append(icon);
      required.addEventListener("change", async () => {
        const requiredQuantity = Number(required.value);
        if (!Number.isFinite(requiredQuantity) || requiredQuantity <= 0) {
          required.value = String(item.requiredQuantity);
          showToast("Укажите количество больше нуля.", "error");
          return;
        }
        required.disabled = true;
        try {
          await api(`/api/garage/items/${item.id}`, { method: "PATCH", body: JSON.stringify({ revision: item.revision, requiredQuantity, comment: item.comment }) });
          await showVehicle(selectedVehicle.id);
        } catch (error) {
          setStatus(error.message);
          showToast(error.message, "error");
          required.disabled = false;
        }
      });
      remove.addEventListener("click", async () => {
        remove.disabled = true;
        try {
          await api(`/api/garage/items/${item.id}`, { method: "DELETE", body: JSON.stringify({ revision: item.revision }) });
          await showVehicle(selectedVehicle.id);
        } catch (error) {
          setStatus(error.message);
          showToast(error.message, "error");
          remove.disabled = false;
        }
      });
      actions.append(remove); row.append(actions); itemsBody.append(row);
    }
  };
  const openAdd = (offerId, vehicleId = null) => {
    if (!offerId) {
      showToast("Позиция устарела. Повторите поиск, чтобы добавить её в гараж.", "error");
      return;
    }
    if (!vehicles.length) {
      showToast("Сначала создайте автомобиль, затем добавьте в него товар.");
      return;
    }
    pendingOfferId = offerId; selectedAddVehicleId = vehicleId; modalConfirm.disabled = !vehicleId; modalConfirm.hidden = false; modalDuplicate.hidden = true; modal.hidden = false; modalSearch.value = ""; renderModalVehicles();
  };
  const closeModal = () => { modal.hidden = true; modalConfirm.hidden = false; modalDuplicate.hidden = true; pendingOfferId = null; selectedAddVehicleId = null; };
  toggle.addEventListener("click", () => setSidebarOpen(sidebar.hidden));
  sidebar.addEventListener("dragenter", (event) => { event.preventDefault(); sidebar.classList.add("is-drop-target"); });
  sidebar.addEventListener("dragover", (event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; });
  sidebar.addEventListener("dragleave", (event) => { if (!sidebar.contains(event.relatedTarget)) sidebar.classList.remove("is-drop-target"); });
  sidebar.addEventListener("drop", (event) => { event.preventDefault(); sidebar.classList.remove("is-drop-target"); openAdd(event.dataTransfer?.getData("application/x-garage-offer")); });
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
  searchForm.addEventListener("submit", (event) => event.preventDefault());
  search.addEventListener("input", () => loadVehicles().catch((error) => setStatus(error.message)));
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
  refresh.addEventListener("click", async () => { refresh.disabled = true; setStatus("Актуализируем предложения…"); try { const { payload } = await api(`/api/garage/vehicles/${selectedVehicle.id}/refresh`, { method: "POST", body: JSON.stringify({ revision: selectedVehicle.revision }) }); selectedVehicle = payload.vehicle; renderItems(); setStatus("Предложения актуализированы"); await loadVehicles(); } catch (error) { setStatus(error.message); } finally { refresh.disabled = false; } });
  priceToggle.addEventListener("click", () => setPurchasePricesVisible(!showPurchase));
  modal.querySelectorAll("[data-garage-close]").forEach((button) => button.addEventListener("click", closeModal));
  const addOfferToVehicle = async (duplicateStrategy) => {
    const vehicle = vehicles.find((item) => item.id === selectedAddVehicleId);
    if (!vehicle || !pendingOfferId) return;
    try {
      const result = await api(`/api/garage/vehicles/${vehicle.id}/items`, { method: "POST", body: JSON.stringify({ vehicleRevision: vehicle.revision, offerId: pendingOfferId, markupPercent: getMarkupPercent(), requiredQuantity: Number(modalQuantity.value), ...(duplicateStrategy ? { duplicateStrategy } : {}) }) });
      if (result.response.status === 409 && result.payload?.duplicate && !duplicateStrategy) {
        modalConfirm.hidden = true;
        modalDuplicate.hidden = false;
        modalDuplicateIncrement.focus();
        return;
      }
      closeModal();
      await loadVehicles();
      if (selectedVehicle?.id === vehicle.id) await showVehicle(vehicle.id);
      showToast(`Товар добавлен в «${vehicle.name}».`);
    } catch (error) {
      setStatus(error.message);
      showToast(error.message, "error");
    }
  };
  modalConfirm.addEventListener("click", () => addOfferToVehicle());
  modalDuplicateIncrement.addEventListener("click", () => addOfferToVehicle("increment"));
  modalDuplicateNew.addEventListener("click", () => addOfferToVehicle("new"));
  document.addEventListener("click", (event) => {
    if (!contextMenu.hidden && !contextMenu.contains(event.target)) hideContextMenu();
    const button = event.target.closest(".garage-offer-button");
    if (button) openAdd(button.dataset.garageOfferId);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !contextMenu.hidden) hideContextMenu(true);
  });
  window.addEventListener("resize", () => hideContextMenu(true));
  window.addEventListener("scroll", () => hideContextMenu(true), true);
  document.addEventListener("dragstart", (event) => { const button = event.target.closest(".garage-offer-button"); if (button?.dataset.garageOfferId) { event.dataTransfer.effectAllowed = "copy"; event.dataTransfer.setData("application/x-garage-offer", button.dataset.garageOfferId); setSidebarOpen(true); } });
  restoreSidebarWidth();
  loadVehicles().catch((error) => setStatus(error.message));
};
