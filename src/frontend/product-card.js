import { renderStockGroups } from "./stock-details.js?v=product-card-3";
import { openSearchStream } from "./search-stream.js";
import { createIncomingPopover } from "./nomenclature-incoming-popover.js?v=product-card-3";

const quantity = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 3 });
const month = new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric", timeZone: "UTC" });
const date = new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short", timeZone: "UTC" });
const currencies = new Map();
export const catalogueUrl = (product) => product.id ? `/api/nomenclature/products/${encodeURIComponent(product.id)}` : null;

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
    const detail = element("dd");
    detail.append(value || "—");
    row.append(element("dt", label), detail);
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
  if (row.amount == null) return "—";
  if (!currencies.has(row.currency)) {
    currencies.set(row.currency, new Intl.NumberFormat("ru-RU", row.currency === "XXX"
      ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : { style: "currency", currency: row.currency }));
  }
  return currencies.get(row.currency).format(row.amount);
};

const priceColumns = [["Вид цены", (row) => row.name], ["Цена", amount], ["Единица", (row) => row.unit]];
const historyColumns = [["Дата", (row) => date.format(new Date(row.date + "Z"))],
  ["Операция", (row) => row.operation], ["Документ", (row) => row.document], ["Количество", (row) => quantity.format(row.quantity)]];

function cardPriceSelection(card, url) {
  const priceId = (row) => row.typeId ?? row.name;
  const types = new Map((card.priceTypes ?? []).map(({ id, name }) => [id, name]));
  const primary = new Map();
  for (const row of card.prices) {
    const id = priceId(row);
    if (!types.has(id)) types.set(id, row.name);
    if (row.primary && !primary.has(id)) primary.set(id, row);
  }
  const defaults = [...new Set([...(card.defaultPriceTypes ?? []), ...primary.keys()])]
    .filter((id) => types.has(id)).slice(0, 3);
  const user = window.aggregatorAuthState?.user?.id ?? "local";
  const platform = new URL(url, location.origin).searchParams.get("testPlatform") === "true" ? "test" : "default";
  const storageKey = `autoservice-aggregator.product-card-prices.${user}.${platform}.v1`;
  let selected = defaults;
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    if (Array.isArray(saved) && saved.length === 3
      && saved.every((item) => item === null || typeof item?.id === "string" && typeof item.name === "string")) {
      selected = saved.map((item) => {
        if (!item) return "";
        if (types.has(item.id)) return item.id;
        const renamed = [...types].find(([, name]) => name === item.name);
        if (renamed) return renamed[0];
        // A version 11 worker only lists price types present on the open product.
        if (!card.priceTypes) { types.set(item.id, item.name); return item.id; }
        return "";
      });
    }
  } catch { /* Display the defaults if browser storage is unavailable. */ }
  return {
    types,
    get selected() { return selected; },
    rows: () => [...new Set(selected)].filter(Boolean).map((id) => primary.get(id) ?? { name: types.get(id) }),
    save(ids) {
      selected = ids;
      try { localStorage.setItem(storageKey, JSON.stringify(ids.map((id) => id ? { id, name: types.get(id) } : null))); }
      catch { /* Keep the current selection for this opened card. */ }
    },
  };
}

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
  const incomingPopover = createIncomingPopover(dialog, "product-card-incoming", productCardButton);
  document.body.append(dialog);
  let current;
  let openingTrigger;

  const status = (text, error = false) => {
    const node = element("p", text, error ? "product-card-error" : "product-card-muted");
    node.setAttribute("role", error ? "alert" : "status");
    return node;
  };
  const changeContent = (...nodes) => {
    content.replaceChildren(...nodes);
    dialog.scrollTop = 0;
  };
  const goBack = (page, trigger) => {
    page.historyRequest?.abort();
    changeContent(page.main);
    dialog.scrollTop = page.scroll;
    trigger.focus();
  };
  const subview = (page, title, trigger) => {
    page.scroll = dialog.scrollTop;
    const back = button("К карточке товара", () => goBack(page, trigger));
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

  function showPriceSettings(page, selection, refresh, trigger) {
    const body = subview(page, "Настройки цен карточки", trigger);
    const form = element("form", undefined, "product-card-price-form");
    const options = [...selection.types].sort((left, right) => left[1].localeCompare(right[1], "ru"));
    const fields = ["Первая цена", "Вторая цена", "Третья цена"].map((title, index) => {
      const label = element("label", title);
      const select = element("select");
      select.append(new Option("Не показывать", ""), ...options.map(([id, name]) => new Option(name, id)));
      select.value = selection.selected[index] ?? "";
      label.append(select);
      form.append(label);
      return select;
    });
    const error = status("Для каждой строки выберите свой вид цены.", true);
    error.hidden = true;
    form.append(error, element("button", "Сохранить", "product-card-action"));
    form.addEventListener("change", () => { error.hidden = true; });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const ids = fields.map((select) => select.value);
      const chosen = ids.filter(Boolean);
      if (new Set(chosen).size !== chosen.length) { error.hidden = false; return; }
      selection.save(ids);
      refresh();
      goBack(page, trigger);
    });
    body.append(form);
  }

  function render(page, card) {
    heading.textContent = card.name || "Карточка товара";
    page.period = card.period;
    const offers = element("div", undefined, "product-card-column");
    const identity = facts([["Категория", card.category], ["Бренд", card.brand], ["Артикул", card.article]]);
    const stock = element("div", undefined, "stock-detail-groups");
    stock.id = "product-card-stock";
    const renderProduct = (row) => {
      const url = row.currentProduct ? page.url : page.related(row);
      return url ? productCardButton(row, url) : row.name;
    };
    renderStockGroups(stock, { name: card.name, article: card.article, currentProduct: true }, card.stockDetails, renderProduct);
    const unit = (count) => [quantity.format(count), card.unit].filter(Boolean).join(" ");
    const availability = section("Остатки", element("p", unit(card.stock), "product-card-stock-total"), stock);
    const incomingContent = element("div");
    availability.append(incomingContent);
    const productUrl = new URL(page.url, location.origin);
    const product = { id: productUrl.pathname.split("/").at(-1), name: card.name };
    let incomingUrl;
    if (page.url.startsWith("/api/nomenclature/")) incomingUrl = "/api/nomenclature/incoming";
    else if (card.incomingProof) {
      productUrl.pathname = productUrl.pathname.replace(/\/products\/[^/]+$/, "/incoming");
      productUrl.searchParams.set("grant", card.incomingProof);
      incomingUrl = productUrl.pathname + productUrl.search;
    }
    const salesContent = element("div");
    const recommendationContent = element("div");
    const sales = section("Продажи и закупка", salesContent, recommendationContent,
      button("История продаж", (event) => showHistory(page, event.currentTarget)));
    offers.append(identity, availability, sales);

    const catalog = element("div", undefined, "product-card-column");
    const photo = element("div", undefined, "product-card-photo");
    const priceSelection = cardPriceSelection(card, page.url);
    const priceTable = element("div");
    const paintPrices = () => priceTable.replaceChildren(table("Основные цены", priceColumns, priceSelection.rows()));
    paintPrices();
    const priceActions = element("div", undefined, "product-card-price-actions");
    const prices = section("Цены", priceTable, priceActions);
    if (card.prices.length) {
      priceActions.append(button("Все цены", (event) => {
        const body = subview(page, "Все цены", event.currentTarget);
        body.append(table("Все цены", [...priceColumns, ["Характеристика", (row) => row.characteristic]], card.prices));
      }));
    }
    if (priceSelection.types.size) {
      const settings = button("⚙", (event) => showPriceSettings(page, priceSelection, paintPrices, event.currentTarget),
        "product-card-action product-card-price-settings");
      settings.setAttribute("aria-label", "Настройки цен");
      settings.title = "Настройки цен";
      priceActions.append(settings);
    }
    catalog.append(photo, prices);
    if (card.oem.length) catalog.append(section("OEM-артикулы", table("OEM-артикулы", [
      ["OEM-артикул", (row) => row.article], ["Марка автомобиля", (row) => row.make],
    ], card.oem)));
    const grid = element("div", undefined, "product-card-grid");
    grid.append(offers, catalog);
    const main = element("div");
    main.append(grid);
    if (card.applicability.length) main.append(section("Применяемость", table("Применяемость", [
      ["Марка", (row) => row.make], ["Модель", (row) => row.model], ["Год с", (row) => row.from], ["Год по", (row) => row.to],
      ["Тип кузова", (row) => row.body], ["Код кузова", (row) => row.bodyCode], ["Литраж двигателя", (row) => row.engine],
      ["Код двигателя", (row) => row.engineCode], ["Уточнение", (row) => row.note],
    ], card.applicability)));
    if (card.replacements.length) main.append(section("Взаимозаменяемые товары", table("Взаимозаменяемые товары", [
      ["Наименование", renderProduct],
      ["Артикул", (row) => row.article], ["Бренд", (row) => row.brand],
    ], card.replacements)));
    page.paintDetails = (details) => {
      incomingContent.replaceChildren();
      const incoming = Object.entries(details.incoming ?? {}).filter(([, value]) => value > 0);
      if (incoming.length) incomingContent.append(facts(incoming.map(([side, value]) => {
        const label = side === "original" ? "К поступлению · оригинал" : "К поступлению · замены";
        if (!incomingUrl) return [label, unit(value)];
        const trigger = button(unit(value), (event) =>
          incomingPopover.open(trigger, product, event, incomingUrl, (row) => row.id === product.id ? page.url : page.related(row)),
        "nomenclature-incoming-button");
        trigger.dataset.incomingSide = side;
        trigger.setAttribute("aria-label", `${label}, ${unit(value)}`);
        trigger.setAttribute("aria-haspopup", "dialog");
        trigger.setAttribute("aria-controls", incomingPopover.id);
        trigger.setAttribute("aria-expanded", "false");
        return [label, trigger];
      })));
      salesContent.replaceChildren();
      if (details.monthlySales?.length) salesContent.append(facts(details.monthlySales.map((row) => {
        const title = month.format(new Date(row.month + "-01T00:00:00Z"));
        return [title.charAt(0).toLocaleUpperCase("ru-RU") + title.slice(1), unit(row.quantity)];
      })));
      if (details.average !== null) salesContent.append(facts([
        ["В среднем за месяц", unit(Math.sign(details.average) * Math.ceil(Math.abs(details.average)))],
      ]));
      if (details.image) {
        const image = element("img", undefined, "product-card-image");
        image.alt = card.name;
        image.src = details.image;
        image.decoding = "async";
        image.addEventListener("error", () => image.remove(), { once: true });
        photo.replaceChildren(image);
      }
    };
    page.detailsStatus = salesContent;
    page.recommendationStatus = recommendationContent;
    page.paintRecommendation = (amount) => {
      recommendationContent.replaceChildren();
      if (amount > 0) {
        const row = facts([["Рекомендованная закупка", unit(amount)]]);
        row.classList.add("product-card-recommendation");
        recommendationContent.append(row);
      }
    };
    page.paintDetails(card);
    page.paintRecommendation(card.recommendation);
    page.main = main;
    changeContent(main);
  }

  async function loadDetails(page) {
    const url = new URL(page.url, location.origin);
    url.searchParams.set("details", "1");
    page.detailsStatus.replaceChildren(status("Загружаются показатели…"));
    try {
      const details = await read(url, page.controller.signal);
      if (current === page && !page.controller.signal.aborted) {
        page.paintDetails(details);
        page.paintRecommendation(details.recommendation);
      }
    } catch (error) {
      if (current === page && !page.controller.signal.aborted) {
        page.detailsStatus.replaceChildren(status("Не удалось загрузить показатели и фото.", true),
          button("Повторить загрузку", () => void loadDetails(page)));
      }
    }
  }

  function loadProgressiveDetails(page) {
    const url = new URL(page.url, location.origin);
    url.searchParams.set("details", "stream");
    page.detailsStatus.replaceChildren(status("Загружаются показатели…"));
    page.recommendationStatus.replaceChildren();
    const stream = openSearchStream(url);
    page.detailsStream = stream;
    let receivedDetails = false;
    const fail = () => {
      stream.close();
      if (current !== page || page.controller.signal.aborted) return;
      const target = receivedDetails ? page.recommendationStatus : page.detailsStatus;
      target.replaceChildren(status(receivedDetails ? "Не удалось завершить расчёт закупки." : "Не удалось загрузить показатели и фото.", true),
        button("Повторить загрузку", () => loadProgressiveDetails(page)));
    };
    stream.onerror = fail;
    stream.onmessage = ({ data }) => {
      if (current !== page || page.controller.signal.aborted) { stream.close(); return; }
      const event = JSON.parse(data);
      if (event.kind === "details") {
        page.paintDetails(event.data);
        receivedDetails = true;
        page.recommendationStatus.replaceChildren(status("Рассчитывается закупка…"));
      } else if (event.kind === "recommendation") {
        page.paintRecommendation(event.data.recommendation);
        stream.close();
      } else if (event.kind === "error") fail();
    };
  }

  async function load(page) {
    changeContent(status("Загружается карточка товара…"));
    try {
      const card = await read(page.url, page.controller.signal);
      if (current !== page || page.controller.signal.aborted) return;
      render(page, card);
      if (card.detailsPending) {
        if (card.progressiveDetails) loadProgressiveDetails(page);
        else void loadDetails(page);
      }
    } catch (error) {
      if (current === page && !page.controller.signal.aborted) {
        changeContent(status(error.name === "TimeoutError" ? "1С не ответила вовремя." : error.message, true),
          button("Повторить", () => void load(page)));
      }
    }
  }
  const stop = () => { incomingPopover.close(); current?.detailsStream?.close(); current?.controller.abort(); };
  dialog.addEventListener("close", () => {
    if (dialog.open) return;
    stop();
    current = undefined;
    content.replaceChildren();
    openingTrigger?.focus({ preventScroll: true });
    openingTrigger = undefined;
  });
  return {
    open(product, trigger, url) {
      if (dialog.open && current?.url === url) { dialog.scrollTop = 0; close.focus(); return; }
      stop();
      const related = url.startsWith("/api/nomenclature/") ? catalogueUrl : (row) => {
        if (!row.id || !row.cardProof) return null;
        const link = new URL(url, location.origin);
        link.pathname = link.pathname.replace(/[^/]+$/, encodeURIComponent(row.id));
        link.searchParams.set("grant", row.cardProof);
        return link.pathname + link.search;
      };
      current = { url, related, controller: new AbortController() };
      heading.textContent = product.name;
      if (!dialog.open) { openingTrigger = trigger; dialog.showModal(); }
      close.focus();
      void load(current);
    },
  };
}

export function productCardButton(product, url = catalogueUrl(product), beforeOpen) {
  const node = button(product.name, () => {
    view ??= createView();
    view.open(product, beforeOpen?.() ?? node, url);
  }, "product-card-link");
  node.setAttribute("aria-haspopup", "dialog");
  return node;
}
