import { splitRepairVehicleName } from "./repair-vehicle-presentation.js";
import { filterRepairCards } from "./repair-search.js";

export function bootstrapRepairs({ onActiveEmpty } = {}) {
  const views = [false, true].map((testPlatform) => {
    const prefix = testPlatform ? "test-repairs" : "repairs";
    const section = document.querySelector(`#${prefix}-function`);
    const rows = document.querySelector(`#${prefix}-rows`);
    const feedback = document.querySelector(`#${prefix}-feedback`);
    const count = document.querySelector(`#${prefix}-count`);
    const refreshButton = document.querySelector(`#${prefix}-refresh`);
    const tab = document.querySelector(`#${prefix}-function-tab`);
    const search = document.querySelector(`#${prefix}-search`);
    return { testPlatform, prefix, section, rows, feedback, count, refreshButton, tab, search, repairs: null, failed: false, unverified: new Set() };
  });
  let activeView;
  let loading = false;
  let loaded = false;
  let refreshTimer;
  let refreshRequested = false;
  let pendingLiveView;
  let liveController;
  let liveRequest;
  let liveGeneration = 0;
  const failureMessage = "Произошёл сбой обновления заказ-нарядов. Достоверность данных не подтверждена. Обратитесь в магазин.";
  const initialAuthState = window.aggregatorAuthState;
  let authReady = initialAuthState?.ready === true;
  let authUser = initialAuthState?.user ?? null;
  const verificationKey = (view) => `autoservice.repairs-unverified.${authUser?.id ?? "shared"}.${view.testPlatform}`;
  const rememberVerification = (view) => {
    try {
      if (view.unverified.size) sessionStorage.setItem(verificationKey(view), JSON.stringify([...view.unverified]));
      else if (view.failed && view.repairs === null) sessionStorage.setItem(verificationKey(view), "true");
      else sessionStorage.removeItem(verificationKey(view));
    } catch { /* SQLite also preserves requests that reached the server. */ }
  };
  const restoreVerification = (view, repairs) => {
    try {
      const stored = JSON.parse(sessionStorage.getItem(verificationKey(view)) ?? "[]");
      for (const id of stored === true ? repairs.map((card) => card.documentId) : Array.isArray(stored) ? stored : []) {
        if (typeof id === "string") view.unverified.add(id);
      }
    } catch { /* The server's verification state remains authoritative. */ }
  };

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
    cell.colSpan = 3;
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

  const validPayment = ({ paymentStatus: status, amountDue: due }) => {
    if (status !== undefined && !["paid", "payment_required", "partially_paid"].includes(status)) return false;
    if (due === undefined) return status !== "partially_paid";
    return status !== undefined && typeof due === "number" && Number.isFinite(due) && due >= 0
      && (status === "paid" ? due === 0 : due > 0);
  };
  const amountFormat = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const integerFormat = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
  const validPaymentOptions = (options) => {
    if (options === undefined) return true;
    const amount = (value, max = 9_999_999_999_999.99) => typeof value === "number" && Number.isFinite(value)
      && value >= 0 && value <= max && /^\d+(?:\.\d{1,2})?$/.test(String(value));
    return options && typeof options === "object" && !Array.isArray(options)
      && amount(options.cardAmountDue)
      && (options.cashAmountDue === null && options.cashDiscountPercent === null
        || amount(options.cashAmountDue) && amount(options.cashDiscountPercent, 100));
  };
  const paymentCell = ({ paymentStatus: status, paymentOptions: options }) => {
    const cell = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = "repairs-payment";
    badge.dataset.status = status ?? "unknown";
    badge.textContent = status === "partially_paid" ? "Частично оплачен" : status === "payment_required" ? "Не оплачен" : status === "paid" ? "Оплачен" : "Оплата ещё не проверена";
    cell.append(badge);
    const detail = document.createElement("div");
    detail.className = "repairs-payment-detail";
    const title = document.createElement("span");
    title.textContent = "Осталось оплатить:";
    const list = document.createElement("ul");
    const card = document.createElement("li");
    card.className = "repairs-payment-card";
    card.textContent = `Картой: ${options ? amountFormat.format(options.cardAmountDue) : "—"}`;
    const cash = document.createElement("li");
    cash.className = "repairs-payment-cash";
    cash.textContent = `Наличка: ${options ? options.cashAmountDue === null ? "Недоступно" : amountFormat.format(options.cashAmountDue) : "—"}`;
    if (options?.cashDiscountPercent != null) {
      const discount = document.createElement("strong");
      discount.className = "repairs-payment-discount";
      const discountMinor = Math.max(0, Math.round(options.cardAmountDue * 100) - Math.round(options.cashAmountDue * 100));
      const discountRubles = Math.floor((discountMinor + 50) / 100);
      discount.textContent = `скидка ${integerFormat.format(options.cashDiscountPercent)}%/${integerFormat.format(discountRubles)}руб`;
      cash.append(" (", discount, ")");
    }
    list.append(card, cash);
    detail.append(title, list);
    if (!options) {
      const note = document.createElement("span");
      note.className = "repairs-payment-note";
      note.textContent = "Суммы по способам оплаты ещё не получены из 1С";
      detail.append(note);
    }
    cell.append(detail);
    return cell;
  };

  const parseRepairs = (payload, fresh = false) => {
    if (!Array.isArray(payload?.repairs) || payload.repairs.some((card) => !card
      || ["documentId", "number", "date", "vehicleName", "status"].some((key) => typeof card[key] !== "string")
      || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(card.documentId)
      || (card.counterpartyName !== undefined && (typeof card.counterpartyName !== "string" || !card.counterpartyName.trim()))
      || !validReadiness(card.goodsReadiness) || fresh && !card.goodsReadiness
      || !validPayment(card) || !validPaymentOptions(card.paymentOptions)
      || (card.testPlatform !== undefined && typeof card.testPlatform !== "boolean")
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(card.date))) {
      throw new Error("Invalid repairs response");
    }
    return payload.repairs;
  };
  const readRepairs = async (response) => {
    if (!response.ok) throw new Error("Repairs request failed");
    const payload = await response.json();
    const repairs = parseRepairs(payload);
    if (payload.unverified !== undefined && (!Array.isArray(payload.unverified) || payload.unverified.some((item) => !item
      || typeof item.documentId !== "string" || typeof item.testPlatform !== "boolean"))) throw new Error("Invalid verification state");
    return { repairs, unverified: payload.unverified ?? [] };
  };

  const renderRows = (view) => {
    const { rows, count, testPlatform, search, repairs } = view;
    const visible = filterRepairCards(repairs, search.value);
    if (visible.some((card) => view.unverified.has(card.documentId))) { invalidateView(view, []); return; }
    view.failed = false;
    const fragment = document.createDocumentFragment();
    for (const card of visible) {
      const row = document.createElement("tr");
      const vehicleCell = document.createElement("td");
      const vehicle = document.createElement("span");
      vehicle.className = "repairs-vehicle-name";
      const { name, plate } = splitRepairVehicleName(card.vehicleName);
      vehicle.textContent = name || (card.counterpartyName ? "Договор не указан" : "—");
      vehicleCell.append(vehicle);
      if (plate) {
        const registration = document.createElement("span");
        registration.className = "repairs-vehicle-plate";
        registration.textContent = plate;
        vehicleCell.append(registration);
      }
      if (card.counterpartyName) {
        const counterparty = document.createElement("span");
        counterparty.className = "repairs-counterparty panel__meta";
        counterparty.textContent = card.counterpartyName;
        vehicleCell.append(counterparty);
      }
      row.append(vehicleCell, readinessCell(card.goodsReadiness), paymentCell(card));
      fragment.append(row);
    }
    rows.replaceChildren(fragment);
    if (!repairs.length) showMessage(rows, testPlatform ? "Тестовых заказ-нарядов в работе нет." : "Заказ-нарядов в работе нет.");
    else if (!visible.length) showMessage(rows, "По вашему запросу заказ-наряды не найдены.");
    count.textContent = search.value.trim() ? `${visible.length} из ${repairs.length}` : String(repairs.length);
    count.hidden = false;
  };

  const renderView = (view, repairs) => {
    const { feedback, tab } = view;
    view.repairs = repairs;
    renderRows(view);
    if (!view.failed) { feedback.textContent = ""; delete feedback.dataset.tone; }
    const singleForm = !authUser?.isAdmin && authUser?.permissions?.length === 1;
    tab.hidden = !view.failed && repairs.length === 0 && !singleForm;
  };

  const invalidateView = (view, ids = view.repairs?.map((card) => card.documentId) ?? []) => {
    for (const id of ids) view.unverified.add(id);
    view.failed = true;
    rememberVerification(view);
    view.count.hidden = true;
    view.feedback.dataset.tone = "error";
    view.feedback.textContent = failureMessage;
    showMessage(view.rows, "Актуальные данные недоступны.");
  };
  const paintBusy = (view, busy) => {
    view.section.classList.toggle("is-refreshing", busy);
    view.section.setAttribute("aria-busy", String(busy));
    view.refreshButton.disabled = busy;
    view.refreshButton.textContent = busy ? "Обновляем…" : "Обновить";
    view.search.disabled = busy;
  };
  const finishRefresh = () => {
    loading = false;
    if (pendingLiveView) {
      const view = pendingLiveView;
      pendingLiveView = undefined;
      refreshRequested = false;
      void refresh({ live: true, target: view });
    } else if (refreshRequested) { refreshRequested = false; void refresh({ background: true }); }
    else scheduleRefresh();
  };
  const refreshLive = async (view) => {
    // If the initial list failed, discover its permitted IDs before requesting fresh data.
    if (view.repairs === null) {
      loading = true;
      clearRefreshTimer();
      const generation = liveGeneration;
      paintBusy(view, true);
      try {
        const payload = await readRepairs(await fetch(`/api/repairs?testPlatform=${view.testPlatform}`, {
          cache: "no-store", signal: AbortSignal.timeout(15_000),
        }));
        if (generation !== liveGeneration) return;
        view.repairs = payload.repairs;
        restoreVerification(view, payload.repairs);
        for (const item of payload.unverified) if (item.testPlatform === view.testPlatform) view.unverified.add(item.documentId);
      } catch {
        if (generation === liveGeneration) { invalidateView(view); paintBusy(view, false); finishRefresh(); }
        return;
      }
      if (generation !== liveGeneration) return;
      loading = false;
      paintBusy(view, false);
    }
    // Freeze the visible subset. An order outside the current search is never requested.
    const visible = filterRepairCards(view.repairs ?? [], view.search.value);
    const ids = visible.map((card) => card.documentId);
    if (!ids.length) {
      view.feedback.textContent = view.failed ? failureMessage : "Нет показанных заказ-нарядов для обновления.";
      scheduleRefresh();
      return;
    }
    loading = true;
    clearRefreshTimer();
    const attempt = ++liveGeneration;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 65_000);
    liveController = controller;
    const current = () => attempt === liveGeneration;
    const route = `/api/repairs/refresh?testPlatform=${view.testPlatform}`;
    paintBusy(view, true);
    for (const id of ids) view.unverified.add(id);
    rememberVerification(view);
    view.count.hidden = true;
    view.feedback.dataset.tone = "loading";
    view.feedback.textContent = "Обновляем данные из 1С…";
    showMessage(view.rows, "Проверяем показанные заказ-наряды…");
    try {
      const created = await fetch(route, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentIds: ids }), signal: controller.signal });
      if (!created.ok) throw new Error("Refresh failed");
      let result = (await created.json()).refresh;
      const requestId = result?.id;
      if (typeof requestId !== "string" || !/^[a-f0-9-]{36}$/i.test(requestId)) throw new Error("Invalid refresh ID");
      const requestRoute = `/api/repairs/refresh/${requestId}?testPlatform=${view.testPlatform}`;
      if (!current()) { void fetch(requestRoute, { method: "DELETE", keepalive: true }).catch(() => {}); return; }
      liveRequest = requestRoute;
      const deadline = Math.min(Date.parse(result.expiresAt), Date.now() + 60_000);
      if (!Number.isFinite(deadline)) throw new Error("Invalid refresh deadline");
      while (result.status === "pending") {
        if (Date.now() >= deadline) throw new Error("Refresh timeout");
        await new Promise((resolve, reject) => {
          const stop = () => { clearTimeout(timer); reject(new Error("Cancelled")); };
          const timer = setTimeout(() => { controller.signal.removeEventListener("abort", stop); resolve(); }, 650);
          if (controller.signal.aborted) stop(); else controller.signal.addEventListener("abort", stop, { once: true });
        });
        const response = await fetch(requestRoute, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("Refresh poll failed");
        result = (await response.json()).refresh;
        if (!current()) return;
        if (result?.id !== requestId) throw new Error("Unrelated refresh");
      }
      if (result.status !== "completed" || !Array.isArray(result.removedDocumentIds)) throw new Error("Refresh not confirmed");
      const cards = parseRepairs(result, true);
      const covered = [...cards.map((card) => card.documentId), ...result.removedDocumentIds];
      if (covered.length !== ids.length || new Set(covered).size !== ids.length || covered.some((id) => !ids.includes(id))
        || cards.some((card) => (card.testPlatform === true) !== view.testPlatform || card.status !== "В работе")) throw new Error("Incomplete refresh");
      const fresh = new Map(cards.map((card) => [card.documentId, card]));
      const repairs = view.repairs.flatMap((card) => ids.includes(card.documentId) ? (fresh.has(card.documentId) ? [fresh.get(card.documentId)] : []) : [card]);
      liveRequest = undefined;
      for (const id of ids) view.unverified.delete(id);
      rememberVerification(view);
      renderView(view, repairs);
      if (!view.failed) {
        view.feedback.dataset.tone = "success";
        view.feedback.textContent = "Показанные заказ-наряды обновлены.";
      }
      if (activeView?.tab.hidden) onActiveEmpty?.();
    } catch {
      if (current()) invalidateView(view, ids);
    } finally {
      clearTimeout(timeout);
      if (current()) {
        if (liveRequest) void fetch(liveRequest, { method: "DELETE", keepalive: true }).catch(() => {});
        liveRequest = undefined;
        liveController = undefined;
        paintBusy(view, false);
        finishRefresh();
      }
    }
  };

  async function refresh({ background = false, live = false, target = activeView } = {}) {
    if (!authReady) return;
    if (loading) {
      if (live) pendingLiveView = target;
      else refreshRequested = true;
      return;
    }
    if (live && target) return refreshLive(target);
    loading = true;
    clearRefreshTimer();
    const generation = liveGeneration;
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
    if (view && !view.failed && (!background || !loaded)) {
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
      if (generation !== liveGeneration) return;
      for (const [index, currentView] of requestedViews.entries()) {
        // A cache read cannot repair a failed request to 1C or restore unconfirmed values.
        const payload = combined ? payloads[0] : payloads[index];
        const repairs = payload.repairs
          .filter((card) => (card.testPlatform === true) === currentView.testPlatform);
        restoreVerification(currentView, repairs);
        for (const item of payload.unverified) if (item.testPlatform === currentView.testPlatform) currentView.unverified.add(item.documentId);
        renderView(currentView, repairs);
      }
      loaded = true;
      if (activeView?.tab.hidden) onActiveEmpty?.();
    } catch {
      if (!view || generation !== liveGeneration) return;
      invalidateView(view);
    } finally {
      if (generation !== liveGeneration) return;
      for (const { refreshButton, section } of views) {
        refreshButton.disabled = false;
        section.setAttribute("aria-busy", "false");
      }
      finishRefresh();
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
    liveGeneration += 1;
    liveController?.abort();
    if (liveRequest) void fetch(liveRequest, { method: "DELETE", keepalive: true }).catch(() => {});
    liveRequest = undefined;
    liveController = undefined;
    pendingLiveView = undefined;
    loading = false;
    loaded = false;
    for (const view of views) {
      view.failed = false; view.repairs = null; view.unverified.clear(); view.rows.replaceChildren(); paintBusy(view, false);
    }
    authReady = true;
    authUser = event.detail ?? null;
    void refresh();
  });
  for (const view of views) {
    view.refreshButton.addEventListener("click", () => { void refresh({ live: true, target: view }); });
    view.search.addEventListener("input", () => {
      if (view.repairs !== null && view.section.getAttribute("aria-busy") !== "true") {
        renderRows(view);
        if (!view.failed && view.feedback.dataset.tone === "error") { view.feedback.textContent = ""; delete view.feedback.dataset.tone; }
      }
    });
  }
  return { setActive, start: resume };
}
