import { createIncomingPopover } from "./nomenclature-incoming-popover.js?v=repair-order-1";

const number = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 3 });
const money = new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB" });
const tableMoney = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const date = new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeZone: "UTC" });
const missing = "—";
const urgentReturn = (row) => row.returnDays != null && row.returnDays <= 5;
const hasIncoming = (row) => row.original > 0 || row.replacement > 0;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function facts(container, entries) {
  container.replaceChildren(...entries.map(([label, value]) => {
    const item = element("div");
    item.append(element("dt", label), element("dd", value));
    return item;
  }));
}

function discount({ discountPercent, discountAmount }, formatter = money) {
  return [discountPercent && `${number.format(discountPercent)}%`, discountAmount && formatter.format(discountAmount)]
    .filter(Boolean).join(" / ");
}

function paymentAmounts(card, data) {
  const selected = data.cashPayment ? "cash" : "card";
  const paid = data.paidAmount ?? (card.amountDue > 0 ? data.total - card.amountDue : undefined);
  // Older replies can only recover the card total when its remaining balance is known and positive.
  const oldCardDue = card.paymentOptions?.cardAmountDue;
  const oldCardTotal = paid !== undefined && oldCardDue > 0 ? paid + oldCardDue : null;
  const totals = { cash: data.cashTotal, card: data.cardTotal === undefined ? oldCardTotal : data.cardTotal, [selected]: data.total };
  const balance = (mode) => {
    if (mode === selected && card.amountDue !== undefined) return card.amountDue;
    if (paid !== undefined && totals[mode] != null) return Math.max(0, Math.round(totals[mode] * 100) - Math.round(paid * 100)) / 100;
    return card.paymentOptions?.[`${mode}AmountDue`];
  };
  return { selected, totals, paid, balance };
}

function lines(columns, rows, title, warn = () => false) {
  const table = element("table", undefined, "repair-order-table");
  table.setAttribute("role", "table");
  table.setAttribute("aria-label", title);
  const header = table.createTHead().insertRow();
  header.setAttribute("role", "row");
  for (const [label, , className] of columns) {
    const heading = element("th", label, className);
    heading.scope = "col";
    heading.setAttribute("role", "columnheader");
    header.append(heading);
  }
  const body = table.createTBody();
  body.setAttribute("role", "rowgroup");
  for (const row of rows) {
    const tr = body.insertRow();
    tr.setAttribute("role", "row");
    if (warn(row)) tr.className = "repair-order-return-urgent";
    for (const [index, [label, value, className]] of columns.entries()) {
      const cell = element(index ? "td" : "th", undefined, className);
      cell.setAttribute("role", index ? "cell" : "rowheader");
      if (index) {
        const mobile = element("span", label, "repair-order-cell-label");
        mobile.setAttribute("aria-hidden", "true");
        cell.append(mobile);
      } else {
        cell.scope = "row";
        cell.classList.add("repair-order-line-name");
      }
      cell.append(value(row) || missing);
      tr.append(cell);
    }
  }
  return table;
}

export function createRepairOrderView() {
  const dialog = element("dialog", undefined, "repair-order");
  dialog.setAttribute("aria-labelledby", "repair-order-title");
  dialog.innerHTML = `
    <header class="repair-order-heading">
      <div class="repair-order-heading-actions">
        <button type="button" class="repair-order-back"><span aria-hidden="true">←</span> К заказ-нарядам</button>
        <button type="button" class="repair-order-close" aria-label="Закрыть заказ-наряд">×</button>
      </div>
      <h2 id="repair-order-title"></h2>
      <div class="repair-order-number"></div>
    </header>
    <div class="repair-order-scroll">
      <p class="repair-order-status" role="status"></p>
      <button type="button" class="btn btn-light repair-order-retry" hidden>Повторить</button>
      <div class="repair-order-details" hidden>
        <dl class="repair-order-facts"></dl>
        <div class="repair-order-tabs" role="tablist" aria-label="Позиции заказ-наряда">
          <button type="button" role="tab" id="repair-order-goods-tab" aria-controls="repair-order-goods"></button>
          <button type="button" role="tab" id="repair-order-work-tab" aria-controls="repair-order-work"></button>
        </div>
        <div id="repair-order-goods" role="tabpanel" aria-labelledby="repair-order-goods-tab"></div>
        <div id="repair-order-work" role="tabpanel" aria-labelledby="repair-order-work-tab" hidden></div>
        <p class="repair-order-empty" hidden>В заказ-наряде нет товаров и работ.</p>
      </div>
    </div>
    <footer class="repair-order-footer" hidden>
      <div class="repair-order-payment" role="group" aria-label="Способ оплаты">
        <button type="button" data-payment="cash">Наличными</button>
        <button type="button" data-payment="card">Картой</button>
        <p class="repair-order-payment-note" hidden>1С не передала расчёт для второго способа.</p>
      </div>
      <dl aria-live="polite" aria-atomic="true"></dl>
    </footer>`;
  document.body.append(dialog);
  const popover = createIncomingPopover(dialog, "repair-order-incoming");
  const back = dialog.querySelector(".repair-order-back");
  const status = dialog.querySelector("[role=status]");
  const retry = dialog.querySelector(".repair-order-retry");
  const details = dialog.querySelector(".repair-order-details");
  const footer = dialog.querySelector(".repair-order-footer");
  const summary = dialog.querySelector(".repair-order-facts");
  const tabList = dialog.querySelector('[role="tablist"]');
  const tabs = [...dialog.querySelectorAll('[role="tab"]')];
  const panels = [...dialog.querySelectorAll('[role="tabpanel"]')];
  const empty = dialog.querySelector(".repair-order-empty");
  const paymentButtons = [...footer.querySelectorAll("[data-payment]")];
  const paymentNote = footer.querySelector(".repair-order-payment-note");
  const totals = footer.querySelector("dl");
  let current;
  let previewPayment;

  const showTab = (active) => {
    popover.close();
    tabs.forEach((tab, index) => {
      tab.setAttribute("aria-selected", String(index === active));
      tab.tabIndex = index === active ? 0 : -1;
      panels[index].hidden = index !== active;
    });
  };
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => showTab(index));
    tab.addEventListener("keydown", (event) => {
      if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? 1 : 1 - index;
      showTab(next);
      tabs[next].focus();
    });
  });

  const showHeading = ({ date: documentDate, number: fullNumber }) => {
    const shortNumber = fullNumber.match(/[\d\s]+$/)?.[0].replace(/\s/g, "").replace(/^0+(?=\d)/, "") || fullNumber;
    dialog.querySelector("h2").textContent = `Заказ-наряд ${shortNumber} от ${date.format(new Date(`${documentDate}Z`))}`;
    dialog.querySelector(".repair-order-number").textContent = `№ ${fullNumber}`;
  };

  const incoming = (row, source) => {
    if (!row.productId || !hasIncoming(row)) return missing;
    const group = element("span", undefined, "repair-order-incoming");
    for (const [side, count, letter, label] of [
      ["original", row.original, "О", "Поставки оригинала"], ["replacement", row.replacement, "З", "Поставки замен"],
    ]) {
      if (count <= 0) continue;
      const button = element("button", `${letter} ${number.format(count)}`, "nomenclature-incoming-button");
      button.type = "button";
      button.dataset.incomingSide = side;
      button.title = label;
      button.setAttribute("aria-label", `${label}, ${number.format(count)}`);
      button.setAttribute("aria-haspopup", "dialog");
      button.setAttribute("aria-expanded", "false");
      button.setAttribute("aria-controls", "repair-order-incoming");
      button.addEventListener("click", (event) => popover.open(button, { id: row.productId, name: row.name }, event, source));
      group.append(button);
    }
    return group;
  };

  const renderPayment = (card, data) => {
    const amounts = paymentAmounts(card, data);
    const reduction = discount(data);
    paymentNote.hidden = amounts.totals.cash != null && amounts.totals.card != null;
    previewPayment = (mode) => {
      for (const button of paymentButtons) {
        button.disabled = amounts.totals[button.dataset.payment] == null;
        button.setAttribute("aria-pressed", String(button.dataset.payment === mode));
      }
      const due = amounts.balance(mode);
      const showDue = due != null && (card.paymentStatus === "partially_paid" || amounts.paid > 0 && due > 0);
      facts(totals, [
        ["Всего", money.format(amounts.totals[mode])],
        ...(reduction ? [["Ручная скидка", reduction]] : []),
        ...(showDue ? [[mode === "cash" ? "Доплатить наличными" : "Доплатить картой", money.format(due)]] : []),
      ]);
    };
    previewPayment(amounts.selected);
  };
  for (const button of paymentButtons) button.addEventListener("click", () => previewPayment?.(button.dataset.payment));

  const render = (card, data, supplySource) => {
    showHeading(card);
    facts(summary, [
      ["Покупатель", data.customer || card.counterpartyName || card.vehicleName || missing],
      ...(data.contract ? [["Договор", data.contract]] : []),
      ...(data.mileage ? [["Пробег", `${number.format(data.mileage)} км`]] : []),
      ...(data.vin ? [["VIN", data.vin]] : []),
      ...(card.contactPhone ? [["Телефон контрагента", card.contactPhone]] : []),
      ...(data.keySlot ? [["Ячейка для ключей", number.format(data.keySlot)]] : []),
      ["Ответственный", card.responsibleFio || missing],
    ]);
    const goods = data.goods.length;
    const work = data.work.length;
    tabs[0].textContent = `Товары (${goods})`;
    tabs[1].textContent = `Работы (${work})`;
    const useTabs = goods > 0 && work > 0;
    tabList.hidden = !useTabs;
    empty.hidden = goods > 0 || work > 0;
    for (const [index, panel] of panels.entries()) {
      panel.setAttribute("role", useTabs ? "tabpanel" : "region");
      if (useTabs) {
        panel.setAttribute("aria-labelledby", tabs[index].id);
        panel.removeAttribute("aria-label");
      } else {
        panel.removeAttribute("aria-labelledby");
        panel.setAttribute("aria-label", index === 0 ? "Товары" : "Работы");
      }
    }
    if (goods) panels[0].replaceChildren(lines([
      ["Наименование", (row) => row.name],
      ["Артикул", (row) => row.article],
      ["Остаток", (row) => row.stock === null ? missing : number.format(row.stock), "repair-order-numeric"],
      ["Цена", (row) => tableMoney.format(row.price), "repair-order-numeric"],
      ["Кол-во", (row) => number.format(row.quantity), "repair-order-numeric"],
      ...(data.goods.some(hasIncoming) ? [["К поступлению", (row) => incoming(row, supplySource)]] : []),
      ...(data.goods.some((row) => row.returnDays !== null) ? [
        ["Возврат, дн.", (row) => {
          if (row.returnDays === null) return missing;
          const days = number.format(row.returnDays);
          return urgentReturn(row) ? element("span", days, "repair-order-return-days") : days;
        }, "repair-order-numeric"],
      ] : []),
      ...(data.goods.some((row) => row.discountPercent || row.discountAmount) ? [["Скидка", (row) => discount(row, tableMoney), "repair-order-numeric"]] : []),
      ["Сумма", (row) => tableMoney.format(row.total), "repair-order-line-total"],
      ["Продавец", (row) => row.seller],
    ], data.goods, "Товары", urgentReturn));
    if (work) panels[1].replaceChildren(lines([
      ["Наименование", (row) => row.name], ["Исполнитель", (row) => row.performer],
      ["Цена", (row) => tableMoney.format(row.price), "repair-order-numeric"],
      ...(data.work.some((row) => row.hours !== 1) ? [["Норма времени", (row) => number.format(row.hours), "repair-order-numeric"]] : []),
      ...(data.work.some((row) => row.multiplier !== 1) ? [["Кратность", (row) => number.format(row.multiplier), "repair-order-numeric"]] : []),
      ["Сумма", (row) => tableMoney.format(row.total), "repair-order-line-total"],
      ["Продавец", (row) => row.seller],
    ], data.work, "Работы"));
    showTab(goods ? 0 : work ? 1 : -1);
    renderPayment(card, data);
    details.hidden = footer.hidden = false;
    status.hidden = true;
  };

  const cancel = (route) => {
    if (route) void fetch(route, { method: "DELETE", keepalive: true }).catch(() => {});
  };
  const load = async (view) => {
    const signal = AbortSignal.any([view.controller.signal, AbortSignal.timeout(63_000)]);
    const query = `testPlatform=${view.testPlatform}`;
    retry.hidden = true;
    status.hidden = false;
    status.textContent = "Загружается заказ-наряд из 1С…";
    dialog.setAttribute("aria-busy", "true");
    try {
      const response = await fetch(`/api/repairs/refresh?${query}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({ documentIds: [view.card.documentId], includeDetails: true }),
      });
      if (response.status === 404) throw new Error("Заказ-наряд больше недоступен.");
      if (!response.ok) throw new Error((await response.json()).message);
      let { refresh } = await response.json();
      if (!/^[a-f0-9-]{36}$/i.test(refresh?.id ?? "")) throw new TypeError("Invalid refresh ID");
      const requestId = refresh.id;
      const route = `/api/repairs/refresh/${requestId}?${query}`;
      if (current !== view) { cancel(route); return; }
      view.route = route;
      while (refresh.status === "pending") {
        if (Date.now() >= Date.parse(refresh.expiresAt)) throw new Error("1С не ответила вовремя.");
        const response = await fetch(`${route}&waitSeconds=20`, { signal, cache: "no-store" });
        if (!response.ok) throw new TypeError("Invalid refresh reply");
        ({ refresh } = await response.json());
        if (refresh?.id !== requestId) throw new TypeError("Unrelated refresh reply");
      }
      if (current !== view) return;
      if (refresh.status !== "completed") throw new TypeError("Incomplete refresh");
      view.route = undefined;
      const card = refresh.repairs?.find((repair) => repair.documentId === view.card.documentId
        && (repair.testPlatform === true) === view.testPlatform);
      if (!card) throw new Error("Заказ-наряд больше недоступен.");
      if (!refresh.details) throw new Error("Для открытия формы требуется обновить расширение 1С.");
      render(card, refresh.details, `/api/repairs/refresh/${requestId}/incoming?${query}`);
    } catch (error) {
      if (current !== view) return;
      cancel(view.route);
      view.route = undefined;
      status.textContent = error.name === "TimeoutError" ? "1С не ответила вовремя." :
        error instanceof TypeError || error instanceof SyntaxError ? "Не удалось загрузить заказ-наряд." : error.message;
      retry.hidden = false;
    } finally {
      if (current === view) dialog.removeAttribute("aria-busy");
    }
  };

  const close = () => {
    if (!current) return;
    const view = current;
    current = undefined;
    previewPayment = undefined;
    view.controller.abort();
    cancel(view.route);
    popover.close();
    dialog.close();
    panels.forEach((panel) => panel.replaceChildren());
    summary.replaceChildren();
    totals.replaceChildren();
    view.trigger.focus({ preventScroll: true });
  };
  back.addEventListener("click", close);
  dialog.querySelector(".repair-order-close").addEventListener("click", close);
  retry.addEventListener("click", () => { if (current) void load(current); });
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(); });
  const onBackdrop = (event) => {
    if (event.target !== dialog) return false;
    const rect = dialog.getBoundingClientRect();
    return event.clientX < rect.left || event.clientX >= rect.right || event.clientY < rect.top || event.clientY >= rect.bottom;
  };
  let backdropPress = false;
  dialog.addEventListener("pointerdown", (event) => { backdropPress = onBackdrop(event); });
  dialog.addEventListener("click", (event) => { if (backdropPress && onBackdrop(event)) close(); });
  return {
    open(card, testPlatform, trigger) {
      close();
      current = { card, testPlatform, trigger, controller: new AbortController() };
      showHeading(card);
      details.hidden = footer.hidden = true;
      dialog.showModal();
      dialog.querySelector(".repair-order-scroll").scrollTop = 0;
      back.focus({ preventScroll: true });
      void load(current);
    },
    close,
  };
}
