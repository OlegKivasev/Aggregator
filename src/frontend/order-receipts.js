import { formatPrice } from "./result-formatting.js";
import { formatOrderDate } from "./order-date-formatting.js";
import { formatOrderStatus } from "./order-history-presentation.js";
import { armtekReturnSource, formatArmtekReturnDays, hasSupplierWeekendDelivery } from "./order-notices.js";

export const supplierNames = { armtek: "Armtek", "part-kom": "PartKOM", "forum-auto": "Forum Auto", rossko: "Rossko", autopiter: "Автопитер" };

const receiptClasses = { "part-kom": "cart-partkom-receipt", "forum-auto": "cart-forum-receipt",
  rossko: "cart-rossko-receipt", armtek: "cart-armtek-receipt", autopiter: "cart-autopiter-receipt" };

export const orderReceiptCard = (supplier, number, existingCard) => {
  if (existingCard) return existingCard;
  const card = document.createElement("section");
  card.className = receiptClasses[supplier];
  const heading = document.createElement("h4");
  heading.textContent = `${supplierNames[supplier]} · заказ № ${number}`;
  card.append(heading);
  return card;
};

export const partKomReceiptNode = (receipt, orderIds, acceptedQuantity, existingCard) => {
  if (!receipt || typeof receipt !== "object" || typeof receipt.orderNumber !== "string"
    || !receipt.orderNumber || receipt.orderNumber.length > 100 || !orderIds.includes(receipt.orderNumber)
    || !Number.isSafeInteger(receipt.quantity) || receipt.quantity < 1 || receipt.quantity > acceptedQuantity) return null;
  return appendPartKomReceipt(receipt, existingCard);
};

function appendPartKomReceipt(receipt, existingCard) {
  const card = orderReceiptCard("part-kom", receipt.orderNumber, existingCard);
  const details = document.createElement("dl");
  details.className = "cart-supplier-receipt__item";
  const add = (label, value, status = false, highlightDate = false) => {
    if (value === null || value === undefined || value === "") return;
    if (typeof value !== "string" && typeof value !== "number") return;
    if (typeof value === "number" && !Number.isFinite(value) || typeof value === "string" && value.length > 500) return;
    const term = document.createElement("dt");
    term.textContent = label;
    const description = document.createElement("dd");
    description.textContent = status ? formatOrderStatus(String(value)) : String(value);
    if (status) description.className = "cart-partkom-receipt__state";
    if (highlightDate) {
      const date = document.createElement("span");
      date.className = "delivery-date--warning";
      date.textContent = String(value);
      description.replaceChildren(date);
    }
    details.append(term, description);
  };
  add("Дата заказа", formatOrderDate(receipt.orderDate));
  add("Деталь", [receipt.detailNum, receipt.maker, receipt.description].filter((value) => typeof value === "string" && value).join(" · "));
  add("Заказано", `${receipt.quantity} шт.`);
  const price = Number.isFinite(receipt.price) && receipt.price > 0 && Number.isFinite(receipt.price * receipt.quantity) ? receipt.price : null;
  add("Цена", price === null ? null : formatPrice(price));
  add("Сумма", price === null ? null : formatPrice(price * receipt.quantity));
  const highlightDelivery = hasSupplierWeekendDelivery("part-kom", receipt.expectedDate);
  add("Ожидаемый срок", formatOrderDate(receipt.expectedDate), false, highlightDelivery);
  add("Гарантированный срок", formatOrderDate(receipt.guaranteedDate));
  add("Склад", receipt.placement);
  for (const [label, value] of [["Отказано", receipt.refusalCount], ["В пути", receipt.storeCount], ["Отгружено", receipt.releaseCount]]) {
    if (Number.isSafeInteger(value) && value >= 0 && value <= receipt.quantity) add(label, value);
  }
  add("Состояние", receipt.stateTxt, true);
  add("Комментарий", receipt.comment);
  card.append(details);
  return card;
}

export const forumAutoReceiptNode = (receipt, orderIds, acceptedQuantity, existingCard) => {
  if (!receipt || typeof receipt !== "object" || typeof receipt.orderId !== "string"
    || !receipt.orderId || receipt.orderId.length > 100 || !orderIds.includes(receipt.orderId)
    || !Number.isSafeInteger(receipt.orderedQuantity) || receipt.orderedQuantity !== acceptedQuantity) return null;
  return appendForumAutoReceipt(receipt, existingCard);
};

function appendForumAutoReceipt(receipt, existingCard) {
  const card = orderReceiptCard("forum-auto", receipt.orderId, existingCard);
  const details = document.createElement("dl");
  details.className = "cart-supplier-receipt__item";
  const add = (label, value, status = false, highlightDate = false) => {
    if (typeof value !== "string" && typeof value !== "number") return;
    if (typeof value === "string" && (!value || value.length > 500)
      || typeof value === "number" && !Number.isFinite(value)) return;
    const term = document.createElement("dt");
    term.textContent = label;
    const description = document.createElement("dd");
    description.textContent = status ? formatOrderStatus(String(value)) : String(value);
    if (highlightDate) {
      const date = document.createElement("span");
      date.className = "delivery-date--warning";
      date.textContent = String(value);
      description.replaceChildren(date);
    }
    if (status) description.className = "cart-forum-receipt__state";
    details.append(term, description);
  };
  add("Номер документа", receipt.documentNumber);
  add("Статус", receipt.status, true);
  add("Создан", formatOrderDate(receipt.createdAt));
  add("Доставка", formatOrderDate(receipt.deliveryAt), false, hasSupplierWeekendDelivery("forum-auto", receipt.deliveryAt));
  add("Товар", [receipt.article, receipt.brand, receipt.title].filter((value) => typeof value === "string" && value.length <= 500 && value).join(" · "));
  add("Заказано", `${receipt.orderedQuantity} шт.`);
  for (const [label, value] of [["Забронировано", receipt.reservedQuantity], ["Подтверждено", receipt.confirmedQuantity]]) {
    if (Number.isSafeInteger(value) && value >= 0 && value <= receipt.orderedQuantity) add(label, value);
  }
  if (Number.isFinite(receipt.price) && receipt.price >= 0) add("Цена", formatPrice(receipt.price));
  if (Number.isFinite(receipt.total) && receipt.total >= 0) add("Сумма", formatPrice(receipt.total));
  card.append(details);
  return card;
}

export const supplierOrderReceiptNode = (supplier, receipt, orderIds, acceptedQuantity, product, existingCard) => {
  if (!receipt || typeof receipt !== "object" || typeof receipt.orderId !== "string"
    || !receipt.orderId || receipt.orderId.length > 100 || !orderIds.includes(receipt.orderId)
    || !Number.isSafeInteger(receipt.quantity) || receipt.quantity < 1 || receipt.quantity > acceptedQuantity) return null;
  return appendSupplierOrderReceipt(supplier, receipt, product, existingCard);
};

function appendSupplierOrderReceipt(supplier, receipt, product, existingCard) {
  const card = orderReceiptCard(supplier, receipt.orderId, existingCard);
  let details = document.createElement("dl");
  const add = (label, value, status = false) => {
    if (typeof value !== "string" && typeof value !== "number") return;
    if (typeof value === "string" && (!value || value.length > 500)
      || typeof value === "number" && !Number.isFinite(value)) return;
    const term = document.createElement("dt");
    term.textContent = label;
    const description = document.createElement("dd");
    description.textContent = status ? formatOrderStatus(String(value)) : String(value);
    if (status) description.className = "cart-supplier-receipt__state";
    details.append(term, description);
  };
  if (!card.querySelector(".cart-supplier-receipt__order")) {
    details.className = "cart-supplier-receipt__order";
    add("Создан", formatOrderDate(receipt.createdAt));
    if (supplier === "armtek") add("Статус заказа", receipt.status, true);
    const orderTotal = supplier === "armtek" ? receipt.total : receipt.orderTotal;
    if (Number.isFinite(orderTotal) && orderTotal > 0) add("Сумма заказа", formatPrice(orderTotal));
    card.firstElementChild.after(details);
    details = document.createElement("dl");
  }
  details.className = "cart-supplier-receipt__item";
  add("Статус позиции", supplier === "armtek" ? receipt.itemStatus : receipt.status, true);
  add("Товар", [product.article, product.brand, product.title].filter((value) => typeof value === "string" && value.length <= 500).join(" · "));
  add("Заказано", `${receipt.quantity} шт.`);
  if (Number.isFinite(receipt.price) && receipt.price > 0) add("Цена", formatPrice(receipt.price));
  if (supplier === "rossko" && Number.isFinite(receipt.total) && receipt.total > 0) add("Сумма позиции", formatPrice(receipt.total));
  add("Срок доставки", formatOrderDate(receipt.deliveryAt ?? receipt.deliveryEnd ?? receipt.deliveryStart));
  add("Склад", receipt.warehouse);
  add("Доставка", receipt.deliveryType);
  add("Адрес доставки", receipt.deliveryAddress);
  add("Оплата", receipt.paymentType);
  if (supplier === "armtek") {
    add("Возврат", formatArmtekReturnDays(receipt.returnDays));
    details.lastElementChild.title = armtekReturnSource;
    if (Number.isInteger(receipt.returnDays) && receipt.returnDays >= 0 && receipt.returnDays <= 9999) {
      add("Источник срока", armtekReturnSource);
    }
  }
  card.append(details);
  return card;
}

export function renderHistoryReceipt(order, supplier, { shownItemsOnly = false } = {}) {
  const header = order.receipt ?? {};
  const sum = (item) => item.receipt?.total ?? (Number.isFinite(item.price) ? item.price * item.quantity : undefined);
  const subtotal = !shownItemsOnly && order.items.every((item) => Number.isFinite(sum(item)))
    ? order.items.reduce((total, item) => total + sum(item), 0) : undefined;
  const orderTotal = header.orderTotal ?? subtotal;
  let card;
  for (const item of order.items) {
    const details = item.receipt ?? {};
    if (supplier === "part-kom") {
      card = appendPartKomReceipt({ orderNumber: order.number, orderDate: order.date, quantity: item.quantity,
        detailNum: item.article, maker: item.brand, description: item.title, price: item.price,
        expectedDate: item.expectedDate, guaranteedDate: item.guaranteedDate, placement: item.warehouse,
        stateTxt: details.status ?? item.status, refusalCount: details.refusalCount ?? item.cancelledQuantity,
        storeCount: details.storeCount, releaseCount: details.releaseCount ?? item.deliveredQuantity, comment: details.comment,
      }, card);
    } else if (supplier === "forum-auto") {
      card = appendForumAutoReceipt({ orderId: order.number, documentNumber: order.documentNumber, createdAt: order.date,
        article: item.article, brand: item.brand, title: item.title, status: item.status ?? header.status,
        deliveryAt: item.expectedDate, orderedQuantity: item.quantity, price: item.price, total: sum(item),
        reservedQuantity: details.reservedQuantity, confirmedQuantity: details.confirmedQuantity,
      }, card);
    } else {
      card = appendSupplierOrderReceipt(supplier, { orderId: order.number, createdAt: order.date,
        quantity: item.quantity, price: item.price, orderTotal, total: supplier === "armtek" ? orderTotal : sum(item),
        status: supplier === "armtek" ? header.status : item.status, itemStatus: item.status,
        deliveryAt: item.expectedDate ?? item.guaranteedDate, warehouse: item.warehouse, returnDays: item.returnDays,
        deliveryType: header.deliveryType, deliveryAddress: header.deliveryAddress, paymentType: header.paymentType,
      }, item, card);
    }
  }
  return card;
}
