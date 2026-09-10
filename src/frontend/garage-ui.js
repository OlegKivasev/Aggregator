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
  const resize = document.querySelector("#garage-resize");
  const modal = document.querySelector("#garage-add-modal");
  const modalSearch = document.querySelector("#garage-add-search");
  const modalVehicles = document.querySelector("#garage-add-vehicles");
  const modalQuantity = document.querySelector("#garage-add-quantity");
  const modalConfirm = document.querySelector("#garage-add-confirm");
  const modalDuplicate = document.querySelector("#garage-add-duplicate");
  const modalDuplicateIncrement = document.querySelector("#garage-add-duplicate-increment");
  const modalDuplicateNew = document.querySelector("#garage-add-duplicate-new");
  const searchShell = document.querySelector(".search-shell");
  const searchTabs = document.querySelector("#search-tabs");
  let vehicles = [];
  let selectedVehicle = null;
  let selectedAddVehicleId = null;
  let pendingOfferId = null;
  let showPurchase = false;
  let resizeStart = null;
  let editingVehicle = null;
  let deletingVehicleId = null;
  let contextVehicleId = null;
  let contextMenuAnchor = null;
  const widthStorageKey = "autoservice-garage-sidebar-width-v1";
  const closeThresholdRatio = 0.02;

  const setStatus = (message) => { status.textContent = message; };
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
  const showSearch = () => { view.hidden = true; searchShell.hidden = false; searchTabs.hidden = false; };
  const showVehicle = async (id) => {
    const { payload } = await api(`/api/garage/vehicles/${encodeURIComponent(id)}`);
    selectedVehicle = payload.vehicle;
    viewName.textContent = selectedVehicle.name;
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
      item.addEventListener("dragover", (event) => event.preventDefault());
      item.addEventListener("drop", (event) => { event.preventDefault(); openAdd(event.dataTransfer?.getData("application/x-garage-offer"), vehicle.id); });
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
    const save = element("button", "Сохранить", "btn btn-primary");
    save.type = "submit";
    const cancel = element("button", "Отмена", "btn btn-light");
    cancel.type = "button";
    cancel.addEventListener("click", () => {
      editingVehicle = null;
      renderVehicles();
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const name = input.value.trim();
      if (!name) {
        input.focus();
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
    form.append(input, save, cancel);
    item.append(form);
    return item;
  };
  const renderVehicleDelete = (vehicle) => {
    const item = element("li", undefined, "garage-vehicle-delete");
    item.append(element("span", `Удалить «${vehicle.name}» и все позиции?`));
    const actions = element("div", undefined, "garage-vehicle-delete__actions");
    const confirm = element("button", "Удалить", "btn garage-vehicle-delete__confirm");
    confirm.type = "button";
    const cancel = element("button", "Отмена", "btn btn-light");
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
      button.addEventListener("click", () => { selectedAddVehicleId = vehicle.id; modalConfirm.disabled = false; modalVehicles.querySelectorAll("button").forEach((item) => item.classList.remove("is-selected")); button.classList.add("is-selected"); });
      modalVehicles.append(button);
    }
  };
  const renderItems = () => {
    itemsBody.replaceChildren();
    for (const item of selectedVehicle.items) {
      const row = element("tr", undefined, item.availabilityStatus === "available" || item.availabilityStatus === "unknown" ? "" : "garage-item--problem");
      const cells = [item.supplier, item.brand, item.article, item.title, `${quantity(item.supplierQuantity)} (${item.availabilityStatus})`];
      for (const value of cells) row.append(element("td", value));
      const required = document.createElement("input"); required.type = "number"; required.min = "0.001"; required.step = "0.001"; required.value = String(item.requiredQuantity);
      const requiredCell = document.createElement("td"); requiredCell.append(required); row.append(requiredCell);
      const comment = document.createElement("input"); comment.value = item.comment; comment.maxLength = 1000;
      const commentCell = document.createElement("td"); commentCell.append(comment); row.append(commentCell);
      row.append(element("td", price(showPurchase ? item.purchasePrice : item.regularPrice)));
      row.append(element("td", price((showPurchase ? item.purchasePrice : item.regularPrice) * item.requiredQuantity)));
      const actions = document.createElement("td");
      const save = element("button", "Сохранить", "btn btn-light"); save.type = "button";
      save.addEventListener("click", async () => { await api(`/api/garage/items/${item.id}`, { method: "PATCH", body: JSON.stringify({ revision: item.revision, requiredQuantity: Number(required.value), comment: comment.value }) }); await showVehicle(selectedVehicle.id); });
      const remove = element("button", "Удалить", "btn btn-light"); remove.type = "button";
      const confirmRemove = element("button", "Удалить", "btn garage-item-remove__confirm"); confirmRemove.type = "button"; confirmRemove.hidden = true;
      const cancelRemove = element("button", "Отмена", "btn btn-light"); cancelRemove.type = "button"; cancelRemove.hidden = true;
      remove.addEventListener("click", () => {
        remove.hidden = true;
        confirmRemove.hidden = false;
        cancelRemove.hidden = false;
        confirmRemove.focus();
      });
      cancelRemove.addEventListener("click", () => {
        remove.hidden = false;
        confirmRemove.hidden = true;
        cancelRemove.hidden = true;
        remove.focus();
      });
      confirmRemove.addEventListener("click", async () => {
        confirmRemove.disabled = true;
        cancelRemove.disabled = true;
        try {
          await api(`/api/garage/items/${item.id}`, { method: "DELETE", body: JSON.stringify({ revision: item.revision }) });
          await showVehicle(selectedVehicle.id);
        } catch (error) {
          setStatus(error.message);
          confirmRemove.disabled = false;
          cancelRemove.disabled = false;
        }
      });
      actions.append(save, remove, confirmRemove, cancelRemove); row.append(actions); itemsBody.append(row);
    }
  };
  const openAdd = (offerId, vehicleId = null) => {
    if (!offerId) return;
    pendingOfferId = offerId; selectedAddVehicleId = vehicleId; modalConfirm.disabled = !vehicleId; modalConfirm.hidden = false; modalDuplicate.hidden = true; modal.hidden = false; modalSearch.value = ""; renderModalVehicles();
  };
  const closeModal = () => { modal.hidden = true; modalConfirm.hidden = false; modalDuplicate.hidden = true; pendingOfferId = null; selectedAddVehicleId = null; };
  toggle.addEventListener("click", () => setSidebarOpen(sidebar.hidden));
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
  refresh.addEventListener("click", async () => { refresh.disabled = true; setStatus("Актуализируем предложения…"); try { const { payload } = await api(`/api/garage/vehicles/${selectedVehicle.id}/refresh`, { method: "POST", body: JSON.stringify({ revision: selectedVehicle.revision }) }); selectedVehicle = payload.vehicle; renderItems(); setStatus("Предложения актуализированы"); await loadVehicles(); } catch (error) { setStatus(error.message); } finally { refresh.disabled = false; } });
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
    } catch (error) {
      setStatus(error.message);
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
  document.addEventListener("dragstart", (event) => { const row = event.target.closest(".main-result-row"); const button = row?.querySelector(".garage-offer-button"); if (button?.dataset.garageOfferId) event.dataTransfer?.setData("application/x-garage-offer", button.dataset.garageOfferId); });
  priceToggle.addEventListener("click", () => { showPurchase = !showPurchase; renderItems(); });
  restoreSidebarWidth();
  loadVehicles().catch((error) => setStatus(error.message));
};
