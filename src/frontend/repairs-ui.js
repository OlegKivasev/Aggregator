export function bootstrapRepairs({ testPlatform = false } = {}) {
  const prefix = testPlatform ? "test-repairs" : "repairs";
  const section = document.querySelector(`#${prefix}-function`);
  const rows = document.querySelector(`#${prefix}-rows`);
  const feedback = document.querySelector(`#${prefix}-feedback`);
  const count = document.querySelector(`#${prefix}-count`);
  const refreshButton = document.querySelector(`#${prefix}-refresh`);
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
        || (card.testPlatform !== undefined && typeof card.testPlatform !== "boolean")
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(card.date))) {
        throw new Error("Invalid repairs response");
      }
      const repairs = payload.repairs.filter((card) => (card.testPlatform === true) === testPlatform);
      const fragment = document.createDocumentFragment();
      for (const card of repairs) {
        const row = document.createElement("tr");
        const date = `${card.date.slice(8, 10)}.${card.date.slice(5, 7)}.${card.date.slice(0, 4)} ${card.date.slice(11, 16)}`;
        for (const value of [card.number, date, card.vehicleName, card.status]) {
          const cell = document.createElement("td");
          cell.textContent = value;
          row.append(cell);
        }
        fragment.append(row);
      }
      rows.replaceChildren(fragment);
      if (!repairs.length) showMessage(testPlatform
        ? "Тестовых заказ-нарядов пока нет. Они появятся после передачи из 1С в тестовом режиме."
        : "Заказ-нарядов пока нет. Они появятся после передачи из 1С.");
      count.textContent = String(repairs.length);
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
