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
    cell.colSpan = 2;
    cell.textContent = message;
    row.append(cell);
    rows.replaceChildren(row);
  };

  const validReadiness = (value) => value === undefined || (value && typeof value === "object" && !Array.isArray(value)
    && Number.isSafeInteger(value.totalPositions) && value.totalPositions >= 0 && value.totalPositions <= 100_000
    && Number.isSafeInteger(value.availablePositions) && value.availablePositions >= 0 && value.availablePositions <= value.totalPositions);

  const readinessCell = (readiness) => {
    const cell = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = "repairs-readiness";
    let tone = "unknown";
    let label = "Наличие ещё не проверено";
    if (readiness) {
      const { totalPositions: total, availablePositions: available } = readiness;
      tone = total === 0 ? "empty" : available === total ? "ready" : "waiting";
      label = total === 0 ? "Не найдено товаров" : available === total ? "Все товары в наличии" : "Есть товары к получению";
      if (total > 0) {
        const detail = document.createElement("span");
        detail.className = "repairs-readiness-detail panel__meta";
        detail.textContent = `В наличии ${available} из ${total} позиций`;
        cell.append(detail);
      }
    }
    badge.dataset.tone = tone;
    badge.textContent = label;
    cell.prepend(badge);
    return cell;
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
        || !validReadiness(card.goodsReadiness)
        || (card.testPlatform !== undefined && typeof card.testPlatform !== "boolean")
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(card.date))) {
        throw new Error("Invalid repairs response");
      }
      const fragment = document.createDocumentFragment();
      for (const card of payload.repairs) {
        const row = document.createElement("tr");
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
        row.append(vehicleCell, readinessCell(card.goodsReadiness));
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
