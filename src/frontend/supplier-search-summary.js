const formatDuration = (durationMs) => `${(durationMs / 1000).toLocaleString("ru-RU", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
})} с`;

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
