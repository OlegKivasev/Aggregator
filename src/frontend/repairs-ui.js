export function bootstrapRepairs({ onActiveEmpty } = {}) {
  const views = [false, true].map((testPlatform) => {
    const prefix = testPlatform ? "test-repairs" : "repairs";
    const section = document.querySelector(`#${prefix}-function`);
    const rows = document.querySelector(`#${prefix}-rows`);
    const feedback = document.querySelector(`#${prefix}-feedback`);
    const count = document.querySelector(`#${prefix}-count`);
    const refreshButton = document.querySelector(`#${prefix}-refresh`);
    const tab = document.querySelector(`#${prefix}-function-tab`);
    return { testPlatform, prefix, section, rows, feedback, count, refreshButton, tab };
  });
  let activeView;
  let loading = false;
  let loaded = false;
  let refreshTimer;
  let refreshRequested = false;
  let authReady = false;
  let authUser = null;

  const clearRefreshTimer = () => {
    window.clearTimeout(refreshTimer);
    refreshTimer = undefined;
  };

  const scheduleRefresh = () => {
    clearRefreshTimer();
    if (!document.hidden) {
      refreshTimer = window.setTimeout(() => { void refresh({ background: true }); }, 10_000);
    }
  };

  const showMessage = (rows, message) => {
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

  const readRepairs = async (response) => {
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
    return payload.repairs;
  };

  const renderView = (view, repairs) => {
    const { rows, count, feedback, tab, testPlatform } = view;
    const fragment = document.createDocumentFragment();
    for (const card of repairs) {
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
      fragment.append(row);
    }
    rows.replaceChildren(fragment);
    if (!repairs.length) showMessage(rows, testPlatform ? "Тестовых заказ-нарядов в работе нет." : "Заказ-нарядов в работе нет.");
    count.textContent = String(repairs.length);
    count.hidden = false;
    feedback.textContent = "";
    delete feedback.dataset.tone;
    tab.hidden = repairs.length === 0;
  };

  async function refresh({ background = false } = {}) {
    if (loading) {
      refreshRequested = true;
      return;
    }
    loading = true;
    clearRefreshTimer();
    const view = activeView;
    const requestedViews = !authReady || authUser?.isAdmin
      ? views
      : views.filter(({ testPlatform }) => authUser?.permissions?.includes(testPlatform ? "testRepairs" : "repairs"));
    if (!requestedViews.length) {
      loading = false;
      scheduleRefresh();
      return;
    }
    for (const { refreshButton, section } of views) {
      refreshButton.disabled = true;
      section.setAttribute("aria-busy", "true");
    }
    if (view && (!background || !loaded)) {
      const { feedback, count, rows } = view;
      feedback.textContent = "Загрузка…";
      delete feedback.dataset.tone;
      count.hidden = true;
      showMessage(rows, "Загрузка заказ-нарядов…");
    }
    try {
      const combined = !authReady || authUser?.isAdmin;
      const responses = combined
        ? [await fetch("/api/repairs", { cache: "no-store", signal: AbortSignal.timeout(15_000) })]
        : await Promise.all(requestedViews.map(({ testPlatform }) => fetch(`/api/repairs?testPlatform=${testPlatform}`, {
          cache: "no-store", signal: AbortSignal.timeout(15_000),
        })));
      const payloads = await Promise.all(responses.map(readRepairs));
      for (const [index, currentView] of requestedViews.entries()) {
        const repairs = (combined ? payloads[0] : payloads[index])
          .filter((card) => (card.testPlatform === true) === currentView.testPlatform);
        renderView(currentView, repairs);
      }
      loaded = true;
      if (activeView?.tab.hidden) onActiveEmpty?.();
    } catch {
      if (!view) return;
      const { feedback, rows } = view;
      feedback.dataset.tone = "error";
      if (background && loaded) {
        feedback.textContent = "Не удалось обновить заказ-наряды. Показаны ранее загруженные данные.";
      } else {
        feedback.textContent = "Не удалось загрузить заказ-наряды. Нажмите «Обновить».";
        showMessage(rows, "Список недоступен.");
        loaded = false;
      }
    } finally {
      loading = false;
      for (const { refreshButton, section } of views) {
        refreshButton.disabled = false;
        section.setAttribute("aria-busy", "false");
      }
      if (refreshRequested) {
        refreshRequested = false;
        void refresh();
      } else {
        scheduleRefresh();
      }
    }
  }

  const setActive = (value) => {
    activeView = views.find((view) => view.prefix === value);
    if (activeView && !document.hidden) void refresh({ background: true });
  };

  const resume = () => {
    clearRefreshTimer();
    if (!document.hidden) void refresh({ background: true });
  };

  document.addEventListener("visibilitychange", resume);
  window.addEventListener("focus", resume);
  document.addEventListener("aggregator-auth-ready", (event) => {
    authReady = true;
    authUser = event.detail ?? null;
    void refresh();
  });
  for (const { refreshButton } of views) refreshButton.addEventListener("click", () => { void refresh(); });
  return { setActive, start: resume };
}
