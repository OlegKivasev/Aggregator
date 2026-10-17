// Keep transport states intact; present confirmed quantities as separate rows.
export function historyItemRows(item) {
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
