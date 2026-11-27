import { createCartToast } from "./cart-toast.js";
import { latestDeliveryDay, orderCalendarDay } from "./order-date-formatting.js";

const missingCounterparty = "Контрагент не выбран. Выберите контрагента в настройках поставщика.";
const loadingCounterparties = "Проверяем контрагента 1С…";
const listeners = new Set();
let stream;
let ids;
let streamIssue;

function watchCounterparties(listener) {
  if (!stream) {
    ids = {};
    streamIssue = loadingCounterparties;
    stream = new EventSource("/api/order-history/counterparties/events");
    stream.onmessage = ({ data }) => {
      ids = JSON.parse(data);
      streamIssue = "";
      for (const update of listeners) update();
    };
    stream.onerror = () => {
      ids = {};
      streamIssue = "Не удалось проверить сопоставление с 1С.";
      for (const update of listeners) update();
    };
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      stream.close();
      stream = undefined;
    }
  };
}

function orderCopyIssue(order, supplier) {
  if (order.itemsLimited) return "Выдача ограничена. Для переноса нужен полный состав заказа.";
  const invalidData = "Часть данных заказа выходит за допустимые пределы для импорта в 1С.";
  if (!order.number.trim() || order.number.length > 100 || !order.items.length || order.items.length > 500) return invalidData;
  const positionIds = supplier === "autopiter" ? new Set() : null;
  for (const item of order.items) {
    if (positionIds && item.positionId) {
      if (positionIds.has(item.positionId)) return "У нескольких позиций одинаковый идентификатор. Для переноса в 1С нужен подтверждённый состав счёта.";
      positionIds.add(item.positionId);
    }
    if (!item.article?.trim()) return "Для переноса в 1С нужны артикулы всех позиций заказа.";
    if (item.article.length > 128 || item.brand?.length > 128
      || item.title?.length > 4000 || !Number.isFinite(item.quantity) || item.quantity <= 0 || item.quantity > 1e6
      || item.price != null && (!Number.isFinite(item.price) || item.price < 0 || item.price >= 1e12 || item.price * item.quantity >= 1e12)
      || Math.abs(item.quantity * 1000 - Math.round(item.quantity * 1000)) > 0.0001) return invalidData;
  }
  return "";
}

async function orderImportText(order, supplier, counterpartyId) {
  const key = new TextEncoder().encode(JSON.stringify([supplier, order.number]));
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", key)).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const date = orderCalendarDay(order.date);
  return JSON.stringify({ format: "aggregator.supplier-order", version: 1, testOnly: true, id,
    number: `TEST-${hex.slice(0, 20).toUpperCase()}`, sourceOrderNumber: order.number, supplier, counterpartyId,
    createdAt: date ? `${date}T00:00:00.000Z` : null, currency: "RUB",
    items: order.items.map((item) => ({ article: item.article, brand: item.brand ?? "", title: item.title ?? "",
      quantity: item.quantity, price: item.price ?? null,
      deliveryDate: latestDeliveryDay(item.expectedDate, item.guaranteedDate),
      returnDays: Number.isInteger(item.returnDays) && item.returnDays >= 0 && item.returnDays <= 9999 ? item.returnDays : null })),
  });
}

export function createOrderCopyControls(dialog) {
  const controls = new Map();
  const toastContainer = dialog.querySelector(":scope > .cart-footer") ?? dialog;
  let stopWatching;
  let notify;
  let revision = 0;
  const update = (button, supplier, issue) => {
    const reason = issue || (!ids?.[supplier] ? streamIssue || missingCounterparty : "");
    button.setAttribute("aria-disabled", String(Boolean(reason)));
    button.classList.toggle("cart-copy-order-unavailable", Boolean(reason));
    button.title = reason || "Скопировать заказ в 1С";
    if (reason) button.setAttribute("aria-description", reason);
    else button.removeAttribute("aria-description");
  };
  dialog.addEventListener("close", () => {
    revision++;
    controls.clear();
    stopWatching?.();
    stopWatching = undefined;
    notify?.("");
  });
  return {
    clear() { controls.clear(); },
    add(order, supplier, { shownItemsOnly = false, issue = orderCopyIssue(order, supplier) } = {}) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "btn btn-light cart-copy-order";
      button.setAttribute("aria-label", `Скопировать заказ ${order.number} в 1С`);
      const icon = document.createElement("img");
      icon.src = "/onec-order.png";
      icon.alt = "";
      icon.width = icon.height = 22;
      button.append(icon);
      if (!issue) {
        stopWatching ??= watchCounterparties(() => {
          for (const [control, id] of controls) update(control, id, "");
        });
        controls.set(button, supplier);
      }
      update(button, supplier, issue);
      button.addEventListener("click", async () => {
        const counterpartyId = ids?.[supplier];
        if (issue || !counterpartyId || button.disabled) return;
        const currentRevision = revision;
        button.disabled = true;
        try {
          if (!navigator.clipboard || !crypto.subtle) throw new Error("Clipboard unavailable");
          const text = orderImportText(order, supplier, counterpartyId);
          if (typeof ClipboardItem === "function" && navigator.clipboard.write) {
            // Request clipboard access during the click, before the digest finishes.
            await navigator.clipboard.write([new ClipboardItem({ "text/plain": text.then((value) => new Blob([value], { type: "text/plain" })) })]);
          } else {
            await navigator.clipboard.writeText(await text);
          }
          if (currentRevision === revision && dialog.open) {
            notify ??= createCartToast(toastContainer);
            notify(shownItemsOnly ? "Показанные позиции скопированы в буфер обмена." : "Заказ скопирован в буфер обмена.");
          }
        } catch {
          if (currentRevision === revision && dialog.open) {
            notify ??= createCartToast(toastContainer);
            notify("Не удалось скопировать заказ. Проверьте доступ к буферу обмена.", true);
          }
        } finally { button.disabled = false; }
      });
      return button;
    },
  };
}
