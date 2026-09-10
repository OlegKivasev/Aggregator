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
  const search = document.querySelector("#garage-search");
  const create = document.querySelector("#garage-create");
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
  const searchShell = document.querySelector(".search-shell");
  const searchTabs = document.querySelector("#search-tabs");
  let vehicles = [];
  let selectedVehicle = null;
  let selectedAddVehicleId = null;
  let pendingOfferId = null;
  let showPurchase = false;
  let resizeStart = null;
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
    for (const vehicle of vehicles) {
      const item = element("li", vehicle.name, "garage-vehicles__item");
      item.tabIndex = 0;
      item.dataset.vehicleId = vehicle.id;
      item.addEventListener("click", () => showVehicle(vehicle.id).catch((error) => setStatus(error.message)));
      item.addEventListener("keydown", (event) => { if (event.key === "Enter") showVehicle(vehicle.id).catch((error) => setStatus(error.message)); });
      item.addEventListener("contextmenu", async (event) => {
        event.preventDefault();
        const action = window.prompt("Введите «переименовать» или «удалить»", "переименовать");
        if (action === "переименовать") {
          const name = window.prompt("Название автомобиля", vehicle.name);
          if (name) { await api(`/api/garage/vehicles/${vehicle.id}`, { method: "PATCH", body: JSON.stringify({ revision: vehicle.revision, name }) }); await loadVehicles(); }
        }
        if (action === "удалить" && window.confirm(`Удалить «${vehicle.name}» и все позиции безвозвратно?`)) {
          await api(`/api/garage/vehicles/${vehicle.id}`, { method: "DELETE", body: JSON.stringify({ revision: vehicle.revision }) });
          if (selectedVehicle?.id === vehicle.id) showSearch();
          await loadVehicles();
        }
      });
      item.addEventListener("dragover", (event) => event.preventDefault());
      item.addEventListener("drop", (event) => { event.preventDefault(); openAdd(event.dataTransfer?.getData("application/x-garage-offer"), vehicle.id); });
      vehiclesList.append(item);
    }
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
      const remove = element("button", "🗑", "btn btn-light"); remove.type = "button";
      remove.addEventListener("click", async () => { if (window.confirm("Удалить позицию?")) { await api(`/api/garage/items/${item.id}`, { method: "DELETE", body: JSON.stringify({ revision: item.revision }) }); await showVehicle(selectedVehicle.id); } });
      actions.append(save, remove); row.append(actions); itemsBody.append(row);
    }
  };
  const openAdd = (offerId, vehicleId = null) => {
    if (!offerId) return;
    pendingOfferId = offerId; selectedAddVehicleId = vehicleId; modalConfirm.disabled = !vehicleId; modal.hidden = false; modalSearch.value = ""; renderModalVehicles();
  };
  const closeModal = () => { modal.hidden = true; pendingOfferId = null; selectedAddVehicleId = null; };
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
  search.addEventListener("input", () => loadVehicles().catch((error) => setStatus(error.message)));
  modalSearch.addEventListener("input", renderModalVehicles);
  create.addEventListener("click", async () => { const name = window.prompt("Название автомобиля"); if (name) { await api("/api/garage/vehicles", { method: "POST", body: JSON.stringify({ name }) }); await loadVehicles(); } });
  back.addEventListener("click", showSearch);
  refresh.addEventListener("click", async () => { refresh.disabled = true; setStatus("Актуализируем предложения…"); try { const { payload } = await api(`/api/garage/vehicles/${selectedVehicle.id}/refresh`, { method: "POST", body: JSON.stringify({ revision: selectedVehicle.revision }) }); selectedVehicle = payload.vehicle; renderItems(); setStatus("Предложения актуализированы"); await loadVehicles(); } catch (error) { setStatus(error.message); } finally { refresh.disabled = false; } });
  modal.querySelectorAll("[data-garage-close]").forEach((button) => button.addEventListener("click", closeModal));
  modalConfirm.addEventListener("click", async () => {
    const vehicle = vehicles.find((item) => item.id === selectedAddVehicleId);
    if (!vehicle || !pendingOfferId) return;
    const request = (duplicateStrategy) => api(`/api/garage/vehicles/${vehicle.id}/items`, { method: "POST", body: JSON.stringify({ vehicleRevision: vehicle.revision, offerId: pendingOfferId, markupPercent: getMarkupPercent(), requiredQuantity: Number(modalQuantity.value), ...(duplicateStrategy ? { duplicateStrategy } : {}) }) });
    try { let result = await request(); if (result.response.status === 409 && result.payload?.duplicate) { result = await request(window.confirm("Такая позиция уже есть. Добавить количество к ней?") ? "increment" : "new"); } closeModal(); await loadVehicles(); if (selectedVehicle?.id === vehicle.id) await showVehicle(vehicle.id); } catch (error) { setStatus(error.message); }
  });
  document.addEventListener("click", (event) => { const button = event.target.closest(".garage-offer-button"); if (button) openAdd(button.dataset.garageOfferId); });
  document.addEventListener("dragstart", (event) => { const row = event.target.closest(".main-result-row"); const button = row?.querySelector(".garage-offer-button"); if (button?.dataset.garageOfferId) event.dataTransfer?.setData("application/x-garage-offer", button.dataset.garageOfferId); });
  priceToggle.addEventListener("click", () => { showPurchase = !showPurchase; renderItems(); });
  restoreSidebarWidth();
  loadVehicles().catch((error) => setStatus(error.message));
};
