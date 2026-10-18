export function formatOrderStatus(value) {
  return typeof value === "string"
    ? value.replace(/(^\s*|[.;:]\s*)на складе(?:\s+филиала)?(?=$|[\s.,:;!?])/giu, "$1В пути")
    : value;
}

// Keep supplier states intact in transport; unify transit and split confirmed quantities for display.
export function historyItemRows(item) {
  item = { ...item, fulfillment: item.fulfillment === "ready" ? "in_transit" : item.fulfillment, status: formatOrderStatus(item.status) };
  if (!["partial", "partially_cancelled"].includes(item.fulfillment)) return [item];
  const delivered = item.fulfillmentQuantities?.delivered ?? item.deliveredQuantity ?? 0;
  const cancelled = item.fulfillmentQuantities?.cancelled ?? item.cancelledQuantity ?? 0;
  const rows = [];
  if (cancelled > 0) rows.push({ ...item, quantity: cancelled, fulfillment: "cancelled", status: `Отменено ${cancelled} шт.` });
  if (delivered > 0) rows.push({ ...item, quantity: delivered, fulfillment: "delivered", status: `Получено ${delivered} шт.` });
  const pending = item.quantity - delivered - cancelled;
  if (pending > 0) rows.push({ ...item, quantity: pending, fulfillment: "processing",
    status: rows.length ? `Ожидается ${pending} шт.` : item.status });
  return rows;
}
