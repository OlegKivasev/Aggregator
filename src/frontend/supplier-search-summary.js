const formatDuration = (durationMs) => `${(durationMs / 1000).toLocaleString("ru-RU", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
})} с`;

const formatCalendarDate = (date, today) => {
  const deliveryDay = new Date(date);
  deliveryDay.setHours(0, 0, 0, 0);

  if (deliveryDay.getTime() === today.getTime()) {
    return "Сегодня";
  }

  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (deliveryDay.getTime() === tomorrow.getTime()) {
    return "Завтра";
  }

  tomorrow.setDate(tomorrow.getDate() + 1);
  if (deliveryDay.getTime() === tomorrow.getTime()) {
    return "Послезавтра";
  }

  return date.toLocaleDateString("ru-RU");
};

export const formatDeliveryDate = (value, approximate = false, valueTo = null) => {
  if (!value) {
    return "Не указана";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return `${approximate ? "~" : ""}${value}`;
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const formattedFrom = parsed.toLocaleDateString("ru-RU");
  const parsedTo = valueTo ? new Date(valueTo) : null;
  const formattedToDate = parsedTo && !Number.isNaN(parsedTo.getTime()) ? parsedTo.toLocaleDateString("ru-RU") : "";
  const formattedTo = formattedToDate && formattedToDate !== formattedFrom
    ? ` - ${formattedToDate}`
    : "";
  const formattedDate = formattedTo ? formattedFrom : formatCalendarDate(parsed, today);

  return `${approximate && !formattedTo ? "~" : ""}${formattedDate}${formattedTo}`;
};

export const buildSupplierResultTooltip = (suppliers, results, durations, supplierNames) => {
  const resultCounts = results.reduce((counts, result) => {
    if (result && suppliers.includes(result.supplier)) {
      counts[result.supplier] = (counts[result.supplier] ?? 0) + 1;
    }
    return counts;
  }, {});

  return suppliers.map((supplier) => {
    const count = resultCounts[supplier] ?? 0;
    const duration = durations[supplier];
    const durationText = Number.isFinite(duration) ? ` (${formatDuration(duration)})` : "";
    return `${supplierNames[supplier] ?? supplier}: ${count} позиций${durationText}`;
  }).join("\n");
};

export const buildIncompleteSearchWarnings = (suppliers, statuses, supplierNames) => suppliers.flatMap((supplier) => {
  const name = supplierNames[supplier] ?? supplier;
  const status = statuses[supplier];

  if (status === "timeout") {
    return [`${name}: время ожидания истекло`];
  }
  if (status === "auth_error") {
    return [`${name}: требуется авторизация`];
  }
  if (status === "error") {
    return [`${name}: поиск не выполнен`];
  }
  if (status !== "completed") {
    return [`${name}: нет итогового ответа`];
  }
  return [];
});
