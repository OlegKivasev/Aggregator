import { renderStockGroups } from "./stock-details.js?v=product-card-1";

const quantity = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 3 });
const month = new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric", timeZone: "UTC" });
const date = new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short", timeZone: "UTC" });
const currencies = new Map();
const catalogueUrl = (id) => `/api/nomenclature/products/${encodeURIComponent(id)}`;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function button(text, action, className = "product-card-action") {
  const node = element("button", text, className);
  node.type = "button";
  node.addEventListener("click", action);
  return node;
}

function facts(entries) {
  const list = element("dl", undefined, "product-card-facts");
  for (const [label, value] of entries) {
    const row = element("div");
    row.append(element("dt", label), element("dd", value || "—"));
    list.append(row);
  }
  return list;
}

function section(title, ...content) {
  const node = element("section", undefined, "product-card-section");
  node.append(element("h3", title), ...content);
  return node;
}

function table(label, columns, rows) {
  if (!rows.length) return element("p", "Нет данных", "product-card-muted");
  const container = element("div", undefined, "product-card-table");
  container.tabIndex = 0;
  container.setAttribute("role", "region");
  container.setAttribute("aria-label", label);
  const node = element("table");
  const header = node.createTHead().insertRow();
  for (const [title] of columns) {
    const cell = element("th", title);
    cell.scope = "col";
    header.append(cell);
  }
  const body = node.createTBody();
  for (const row of rows) {
    const line = body.insertRow();
    for (const [, read] of columns) line.insertCell().append(read(row) || "—");
  }
  container.append(node);
  return container;
}

const amount = (row) => {
  if (!currencies.has(row.currency)) {
    currencies.set(row.currency, new Intl.NumberFormat("ru-RU", row.currency === "XXX"
      ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : { style: "currency", currency: row.currency }));
  }
  return currencies.get(row.currency).format(row.amount);
};

const priceColumns = [["Вид цены", (row) => row.name], ["Цена", amount], ["Единица", (row) => row.unit]];
const historyColumns = [["Дата", (row) => date.format(new Date(row.date + "Z"))],
  ["Операция", (row) => row.operation], ["Документ", (row) => row.document], ["Количество", (row) => quantity.format(row.quantity)]];

async function read(url, signal) {
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(35_000)]) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.message || "Не удалось открыть карточку товара.");
  return value;
}

let view;
function createView() {
  const dialog = element("dialog", undefined, "product-card");
  dialog.setAttribute("aria-labelledby", "product-card-title");
  const header = element("header", undefined, "product-card-header");
  const heading = element("h2");
  heading.id = "product-card-title";
  const close = button("Закрыть", () => dialog.close());
  close.autofocus = true;
  header.append(heading, close);
  const content = element("div", undefined, "product-card-content");
  dialog.append(header, content);
  document.body.append(dialog);
  let current;
  let openingTrigger;
  let backToCard;

  const status = (text, error = false) => {
    const node = element("p", text, error ? "product-card-error" : "product-card-muted");
    node.setAttribute("role", error ? "alert" : "status");
    return node;
  };
  const changeContent = (...nodes) => {
    content.replaceChildren(...nodes);
    dialog.scrollTop = 0;
  };
  const goBack = (page) => {
    page.historyRequest?.abort();
    changeContent(page.main);
    dialog.scrollTop = page.scroll;
    backToCard?.focus();
  };
  const subview = (page, title, trigger) => {
    page.scroll = dialog.scrollTop;
    backToCard = trigger;
    const back = button("К карточке товара", () => goBack(page));
    const body = element("div");
    changeContent(back, section(title, body));
    back.focus();
    return body;
  };

  function showHistory(page, trigger) {
    const body = subview(page, "История продаж и движений", trigger);
    const form = element("form", undefined, "product-card-period");
    const fields = ["from", "to"].map((key, index) => {
      const label = element("label", index ? "По" : "С");
      const input = element("input");
      input.type = "date"; input.required = true; input.value = page.period[key];
      label.append(input);
      form.append(label);
      return input;
    });
    const submit = element("button", "Показать", "product-card-action");
    form.append(submit);
    const results = element("div");
    body.append(form, results);
    async function load() {
      const [from, to] = fields.map((input) => input.value);
      page.historyRequest?.abort();
      if (!from || !to || from > to) {
        results.replaceChildren(status("Укажите обе даты. Дата «С» должна быть не позже даты «По».", true));
        return;
      }
      page.period = { from, to };
      const url = new URL(page.url, location.origin);
      url.searchParams.set("from", from);
      url.searchParams.set("to", to);
      const request = new AbortController();
      page.historyRequest = request;
      results.replaceChildren(status("Загружается история…"));
      try {
        const key = url.href;
        const history = page.history?.key === key ? page.history.value
          : await read(url, AbortSignal.any([page.controller.signal, request.signal]));
        if (request.signal.aborted || current !== page) return;
        page.history = { key, value: history };
        results.replaceChildren(history.rows.length ? table("История продаж", historyColumns, history.rows)
          : status("Продаж и движений за период нет."));
        if (history.hasMore) results.append(status("Показаны 500 последних строк. Сократите период, чтобы увидеть остальные."));
      } catch (error) {
        if (!request.signal.aborted && current === page) results.replaceChildren(status(error.message, true));
      }
    }
    form.addEventListener("submit", (event) => { event.preventDefault(); void load(); });
    void load();
  }

  function render(page, card) {
    heading.textContent = card.name || "Карточка товара";
    page.period = card.period;
    const offers = element("div", undefined, "product-card-column");
    const identity = facts([["Категория", card.category], ["Бренд", card.brand], ["Артикул", card.article]]);
    const stock = element("div", undefined, "stock-detail-groups");
    stock.id = "product-card-stock";
    renderStockGroups(stock, card, card.stockDetails);
    const unit = (count) => [quantity.format(count), card.unit].filter(Boolean).join(" ");
    const availability = section("Остатки", element("p", unit(card.stock), "product-card-stock-total"), stock);
    const incoming = Object.entries(card.incoming ?? {}).filter(([, value]) => value > 0);
    if (incoming.length) availability.append(facts(incoming.map(([side, value]) =>
      [side === "original" ? "К поступлению · оригинал" : "К поступлению · замены", unit(value)])));
    const sales = section("Продажи и закупка");
    if (card.monthlySales?.length) sales.append(facts(card.monthlySales.map((row) => {
      const title = month.format(new Date(row.month + "-01T00:00:00Z"));
      return [title.charAt(0).toLocaleUpperCase("ru-RU") + title.slice(1), unit(row.quantity)];
    })));
    if (card.average !== null || card.recommendation !== null) {
      sales.append(facts([
        ...(card.average === null ? [] : [["В среднем за месяц", unit(Math.sign(card.average) * Math.ceil(Math.abs(card.average)))]]),
        ...(card.recommendation === null ? [] : [["Рекомендованная закупка", unit(card.recommendation)]]),
      ]));
    }
    sales.append(button("История продаж", (event) => showHistory(page, event.currentTarget)));
    offers.append(identity, availability, sales);

    const catalog = element("div", undefined, "product-card-column");
    if (card.image) {
      const image = element("img", undefined, "product-card-image");
      image.alt = card.name;
      image.src = card.image;
      image.decoding = "async";
      image.addEventListener("error", () => image.remove(), { once: true });
      catalog.append(image);
    }
    const primaryPrices = card.prices.filter((row) => row.primary);
    const prices = section("Цены", table("Основные цены", priceColumns, primaryPrices));
    if (card.prices.length) {
      prices.append(button("Все цены", (event) => {
        const body = subview(page, "Все цены", event.currentTarget);
        body.append(table("Все цены", [...priceColumns, ["Характеристика", (row) => row.characteristic]], card.prices));
      }));
    }
    catalog.append(prices, section("OEM-артикулы", table("OEM-артикулы", [
      ["OEM-артикул", (row) => row.article], ["Марка автомобиля", (row) => row.make],
    ], card.oem)));
    const grid = element("div", undefined, "product-card-grid");
    grid.append(offers, catalog);
    const main = element("div");
    main.append(grid, section("Применяемость", table("Применяемость", [
      ["Марка", (row) => row.make], ["Модель", (row) => row.model], ["Год с", (row) => row.from], ["Год по", (row) => row.to],
      ["Тип кузова", (row) => row.body], ["Код кузова", (row) => row.bodyCode], ["Литраж двигателя", (row) => row.engine],
      ["Код двигателя", (row) => row.engineCode], ["Уточнение", (row) => row.note],
    ], card.applicability)), section("Взаимозаменяемые товары", table("Взаимозаменяемые товары", [
      ["Наименование", (row) => page.related ? productCardButton(row, page.related(row.id)) : row.name],
      ["Артикул", (row) => row.article], ["Бренд", (row) => row.brand],
    ], card.replacements)));
    page.main = main;
    changeContent(main);
  }

  async function load(page) {
    changeContent(status("Загружается карточка товара…"));
    try {
      const card = await read(page.url, page.controller.signal);
      if (current === page) render(page, card);
    } catch (error) {
      if (current === page && !page.controller.signal.aborted) {
        changeContent(status(error.name === "TimeoutError" ? "1С не ответила вовремя." : error.message, true),
          button("Повторить", () => void load(page)));
      }
    }
  }
  const stop = () => { current?.controller.abort(); };
  dialog.addEventListener("close", () => {
    if (dialog.open) return;
    stop();
    current = undefined;
    content.replaceChildren();
    openingTrigger?.focus({ preventScroll: true });
    openingTrigger = undefined;
    backToCard = undefined;
  });
  return {
    open(product, trigger, url, related) {
      stop();
      current = { url, related, controller: new AbortController() };
      heading.textContent = product.name;
      if (!dialog.open) { openingTrigger = trigger; dialog.showModal(); }
      close.focus();
      void load(current);
    },
  };
}

export function productCardButton(product, url = catalogueUrl(product.id)) {
  const node = button(product.name, () => {
    view ??= createView();
    view.open(product, node, url, url.startsWith("/api/nomenclature/") ? catalogueUrl : undefined);
  }, "product-card-link");
  node.setAttribute("aria-haspopup", "dialog");
  return node;
}
