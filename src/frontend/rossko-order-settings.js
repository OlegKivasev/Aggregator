const endpoint = "/api/suppliers/rossko/order-settings";
const validText = (value, limit) => typeof value === "string" && value.length > 0 && value.length <= limit;

const validateState = (state) => {
  const choices = state?.choices;
  if (!state || typeof state.persistent !== "boolean" || !choices
    || ["companies", "deliveries", "payments"].some((key) => !Array.isArray(choices[key]) || choices[key].length > 1000
      || choices[key].some((item) => !item || !validText(item.id, 200) || !validText(item.label, 1000)))
    || choices.deliveries.some((item) => !validText(item.addressId, 200))
    || state.settings !== null && (!state.settings || ["companyId", "deliveryId", "addressId", "paymentId", "contactName", "contactPhone"]
      .some((key) => !validText(state.settings[key], key === "contactName" ? 100 : key === "contactPhone" ? 40 : 200)))) {
    throw new Error("Не удалось проверить настройки заказа Rossko.");
  }
  return state;
};

export function bootstrapRosskoOrderSettings() {
  const section = document.querySelector("#rossko-order-settings");
  const form = section.querySelector("form");
  const fields = form.elements;
  const status = section.querySelector("[role=status]");
  const reload = section.querySelector("#rossko-order-reload");
  const fieldset = form.querySelector("fieldset");
  let authorized = false;
  let request = null;
  let state = null;
  let saving = false;

  const fillSelect = (select, options, selected) => {
    select.replaceChildren(new Option("Выберите…", ""), ...options.map((item) => new Option(item.label, item.id)));
    select.value = selected === undefined && options.length === 1 ? options[0].id : selected ?? "";
    if (select.selectedIndex < 0) select.value = "";
  };
  const paint = (next) => {
    state = next;
    const saved = next.settings;
    fillSelect(fields.companyId, next.choices.companies, saved?.companyId);
    fillSelect(fields.paymentId, next.choices.payments, saved?.paymentId);
    const deliveries = next.choices.deliveries.map((item, index) => ({ id: String(index), label: item.label }));
    const index = saved ? next.choices.deliveries.findIndex((item) => item.id === saved.deliveryId && item.addressId === saved.addressId) : -1;
    fillSelect(fields.delivery, deliveries, saved ? index < 0 ? "" : String(index) : undefined);
    fields.contactName.value = saved?.contactName ?? "";
    fields.contactPhone.value = saved?.contactPhone ?? "";
  };
  const setBusy = (busy) => { fieldset.disabled = busy || !state; reload.disabled = busy; };
  const exchange = async (settings) => {
    request?.abort();
    const controller = new AbortController();
    request = controller;
    setBusy(true);
    status.dataset.state = "loading";
    status.textContent = settings ? "Сохраняем настройки…" : "Загружаем данные Rossko…";
    try {
      const response = await fetch(endpoint, { method: settings ? "PUT" : "GET", signal: controller.signal,
        ...(settings ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(settings) } : {}) });
      const payload = await response.json();
      if (controller.signal.aborted || !authorized || request !== controller) return;
      if (!response.ok) throw new Error(typeof payload.message === "string" ? payload.message : "Не удалось загрузить настройки Rossko.");
      const next = validateState(payload);
      paint(next);
      const stale = next.settings && (!fields.companyId.value || !fields.delivery.value || !fields.paymentId.value);
      status.dataset.state = stale ? "error" : next.settings ? "success" : "info";
      status.textContent = stale ? "Сохранённые параметры больше недоступны. Выберите актуальные данные Rossko и сохраните настройки."
        : next.settings ? next.persistent ? "Настройки заказа сохранены." : "Настройки сохранены до перезапуска сервера."
          : "Выберите параметры заказа и укажите контактное лицо и телефон.";
    } catch (error) {
      if (!controller.signal.aborted && authorized && request === controller) {
        status.dataset.state = "error";
        status.textContent = error.message;
      }
    } finally {
      if (request === controller) { request = null; saving = false; setBusy(false); }
    }
  };
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!authorized || request || !state || !form.reportValidity()) return;
    const delivery = state.choices.deliveries[Number(fields.delivery.value)];
    if (!delivery) return;
    saving = true;
    void exchange({ companyId: fields.companyId.value, paymentId: fields.paymentId.value,
      deliveryId: delivery.id, addressId: delivery.addressId, contactName: fields.contactName.value.trim(), contactPhone: fields.contactPhone.value.trim() });
  });
  reload.addEventListener("click", () => { if (authorized && !saving) void exchange(); });
  return {
    setAuthorized(value) {
      if (authorized === value) return;
      authorized = value;
      section.hidden = !value;
      request?.abort(); request = null; saving = false; state = null; form.reset(); setBusy(false); status.textContent = "";
      if (value) void exchange();
    },
    refresh() { if (authorized && !request) void exchange(); },
  };
}
