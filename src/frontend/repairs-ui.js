export function bootstrapRepairs() {
  const section = document.querySelector("#repairs-function");
  const rows = document.querySelector("#repairs-rows");
  const feedback = document.querySelector("#repairs-feedback");
  const count = document.querySelector("#repairs-count");
  const refreshButton = document.querySelector("#repairs-refresh");
  let loading = false;

  const showMessage = (message) => {
    const row = document.createElement("tr");
    row.className = "results-table__empty";
    const cell = document.createElement("td");
    cell.colSpan = 4;
    cell.textContent = message;
    row.append(cell);
    rows.replaceChildren(row);
  };

  async function refresh() {
    if (loading) return;
    loading = true;
    refreshButton.disabled = true;
    section.setAttribute("aria-busy", "true");
    feedback.textContent = "Загрузка…";
    delete feedback.dataset.tone;
    count.hidden = true;
    showMessage("Загрузка заказ-нарядов…");
    try {
      const response = await fetch("/api/repairs", { cache: "no-store", signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error("Repairs request failed");
      const payload = await response.json();
      if (!Array.isArray(payload?.repairs) || payload.repairs.some((card) => !card
        || ["documentId", "number", "date", "vehicleName", "status"].some((key) => typeof card[key] !== "string")
        || (card.counterpartyName !== undefined && (typeof card.counterpartyName !== "string" || !card.counterpartyName.trim()))
        || (card.testPlatform !== undefined && typeof card.testPlatform !== "boolean")
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(card.date))) {
        throw new Error("Invalid repairs response");
      }
      const fragment = document.createDocumentFragment();
      for (const card of payload.repairs) {
        const row = document.createElement("tr");
        const date = `${card.date.slice(8, 10)}.${card.date.slice(5, 7)}.${card.date.slice(0, 4)} ${card.date.slice(11, 16)}`;
        for (const value of [card.number, date]) {
          const cell = document.createElement("td");
          cell.textContent = value;
          row.append(cell);
        }
        const vehicleCell = document.createElement("td");
        const vehicle = document.createElement("span");
        vehicle.className = "repairs-vehicle-name";
        vehicle.textContent = card.vehicleName || (card.counterpartyName ? "Договор не указан" : "—");
        vehicleCell.append(vehicle);
        if (card.counterpartyName) {
          const counterparty = document.createElement("span");
          counterparty.className = "repairs-counterparty panel__meta";
          counterparty.textContent = card.counterpartyName;
          vehicleCell.append(counterparty);
        }
        const statusCell = document.createElement("td");
        statusCell.textContent = card.status;
        row.append(vehicleCell, statusCell);
        if (card.testPlatform === true) {
          row.dataset.testPlatform = "true";
          const label = document.createElement("span");
          label.className = "results-count repairs-test-label";
          label.textContent = "Тест";
          label.title = "Тестовая платформа";
          row.firstElementChild.append(label);
        }
        fragment.append(row);
      }
      rows.replaceChildren(fragment);
      if (!payload.repairs.length) showMessage("Заказ-нарядов в работе нет.");
      count.textContent = String(payload.repairs.length);
      count.hidden = false;
      feedback.textContent = "";
    } catch {
      feedback.dataset.tone = "error";
      feedback.textContent = "Не удалось загрузить заказ-наряды. Нажмите «Обновить».";
      showMessage("Список недоступен.");
    } finally {
      loading = false;
      refreshButton.disabled = false;
      section.setAttribute("aria-busy", "false");
    }
  }

  refreshButton.addEventListener("click", refresh);
  return { refresh };
}
