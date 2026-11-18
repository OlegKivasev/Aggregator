import { createIncomingPopover } from "./nomenclature-incoming-popover.js?v=repair-order-1";

const number = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 3 });
const money = new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB" });
const date = new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeZone: "UTC" });
const missing = "—";

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

function discount({ discountPercent, discountAmount }) {
  return [discountPercent && `${number.format(discountPercent)}%`, discountAmount && money.format(discountAmount)]
    .filter(Boolean).join(" / ");
}

function lines(columns, rows, title) {
  if (!rows.length) return element("p", title === "Товары" ? "Товары не добавлены." : "Работы не добавлены.", "repair-order-empty");
  const table = element("table", undefined, "repair-order-table");
  table.setAttribute("role", "table");
  table.setAttribute("aria-label", title);
  const header = table.createTHead().insertRow();
  header.setAttribute("role", "row");
  for (const [label] of columns) {
    const heading = element("th", label);
    heading.scope = "col";
    heading.setAttribute("role", "columnheader");
    header.append(heading);
  }
  const body = table.createTBody();
  body.setAttribute("role", "rowgroup");
  for (const row of rows) {
    const tr = body.insertRow();
    tr.setAttribute("role", "row");
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
      <button type="button" class="repair-order-back">← К заказ-нарядам</button>
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
      </div>
    </div>
    <footer class="repair-order-footer" hidden><dl></dl></footer>`;
  document.body.append(dialog);
  const popover = createIncomingPopover(dialog, "repair-order-incoming");
  const back = dialog.querySelector(".repair-order-back");
  const status = dialog.querySelector("[role=status]");
  const retry = dialog.querySelector(".repair-order-retry");
  const details = dialog.querySelector(".repair-order-details");
  const footer = dialog.querySelector(".repair-order-footer");
  const summary = dialog.querySelector(".repair-order-facts");
  const tabs = [...dialog.querySelectorAll('[role="tab"]')];
  const panels = [...dialog.querySelectorAll('[role="tabpanel"]')];
  let current;

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
    if (!row.productId || !(row.original > 0 || row.replacement > 0)) return missing;
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

  const render = (card, data, supplySource) => {
    showHeading(card);
    facts(summary, [
      ["Покупатель", data.customer || card.counterpartyName || card.vehicleName || missing],
      ...(data.contract ? [["Договор", data.contract]] : []),
      ["Пробег", `${number.format(data.mileage)} км`],
      ...(data.vin ? [["VIN", data.vin]] : []),
      ...(card.contactPhone ? [["Телефон контрагента", card.contactPhone]] : []),
      ...(data.keySlot ? [["Ячейка для ключей", number.format(data.keySlot)]] : []),
      ["Ответственный", card.responsibleFio || missing],
      ["Оплата", data.cashPayment ? "Наличными" : "Картой"],
    ]);
    tabs[0].textContent = `Товары (${data.goods.length})`;
    tabs[1].textContent = `Работы (${data.work.length})`;
    panels[0].replaceChildren(lines([
      ["Наименование", (row) => row.name],
      ["Артикул", (row) => row.article],
      ["Остаток с заказами", (row) => row.stock === null ? missing : number.format(row.stock), "repair-order-numeric"],
      ["Цена", (row) => money.format(row.price), "repair-order-numeric"],
      ["Кол-во", (row) => number.format(row.quantity), "repair-order-numeric"],
      ["К поступлению", (row) => incoming(row, supplySource)],
      ...(data.goods.some((row) => row.returnDays !== null) ? [
        ["Дней до возврата", (row) => row.returnDays === null ? missing : number.format(row.returnDays), "repair-order-numeric"],
      ] : []),
      ...(data.goods.some((row) => row.discountPercent || row.discountAmount) ? [["Скидка", discount, "repair-order-numeric"]] : []),
      ["Сумма", (row) => money.format(row.total), "repair-order-line-total"],
      ["Продавец", (row) => row.seller],
    ], data.goods, "Товары"));
    panels[1].replaceChildren(lines([
      ["Наименование", (row) => row.name], ["Исполнитель", (row) => row.performer],
      ["Цена", (row) => money.format(row.price), "repair-order-numeric"],
      ["Норма времени / кратность", (row) => [row.hours && `${number.format(row.hours)} н·ч`,
        row.multiplier && (row.multiplier !== 1 || !row.hours) && `×${number.format(row.multiplier)}`].filter(Boolean).join(" / ")],
      ["Сумма", (row) => money.format(row.total), "repair-order-line-total"],
      ["Продавец", (row) => row.seller],
    ], data.work, "Работы"));
    const reduction = discount(data);
    facts(footer.querySelector("dl"), [
      ["Всего", money.format(data.total)],
      ["Наличными", data.cashTotal === null ? missing : money.format(data.cashTotal)],
      ...(reduction ? [["Ручная скидка", reduction]] : []),
      ...(card.paymentStatus === "partially_paid" ? [[data.cashPayment ? "Доплатить наличными" : "Доплатить картой", money.format(card.amountDue)]] : []),
    ]);
    showTab(0);
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
    view.controller.abort();
    cancel(view.route);
    popover.close();
    dialog.close();
    panels.forEach((panel) => panel.replaceChildren());
    summary.replaceChildren();
    footer.querySelector("dl").replaceChildren();
    view.trigger.focus({ preventScroll: true });
  };
  back.addEventListener("click", close);
  retry.addEventListener("click", () => { if (current) void load(current); });
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(); });
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
