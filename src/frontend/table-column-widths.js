const storageKey = "autoservice.tableColumnWidths.v1";
const alignmentStorageKey = "autoservice.tableColumnAlignments.v1";
export const minimumColumnWidth = 24;
export const maximumColumnWidth = 800;

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const normalizeWidth = (value) => {
  const width = Number(value);
  return Number.isInteger(width) && width >= minimumColumnWidth && width <= maximumColumnWidth ? width : null;
};

const readStoredWidths = () => {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey));
    return isRecord(value) ? value : {};
  } catch {
    localStorage.removeItem(storageKey);
    return {};
  }
};

const writeStoredWidths = (widths) => {
  try {
    localStorage.setItem(storageKey, JSON.stringify(widths));
  } catch {
    // Column widths are optional; unavailable storage must not affect the tables.
  }
};

export const applySavedColumnWidths = (defaults, savedWidths) => {
  if (!isRecord(savedWidths)) return { ...defaults };

  return Object.fromEntries(Object.entries(defaults).map(([column, defaultWidth]) => [
    column,
    normalizeWidth(savedWidths[column]) ?? defaultWidth,
  ]));
};

const commonOfferPreferences = (saved) => ({ ...saved.analogs, ...saved.main });
export const restoreLocalColumnWidths = (table, defaults) => {
  const saved = readStoredWidths();
  return applySavedColumnWidths(defaults, table === "main" || table === "analogs" ? commonOfferPreferences(saved) : saved[table]);
};

export const fitOfferColumnWidths = (widths, visibleColumns, availableWidth, actionWidth) => {
  const fittedWidths = Object.fromEntries(visibleColumns.map((column) => [column, widths[column]]));
  const configuredWidth = visibleColumns.reduce((total, column) => total + widths[column], actionWidth);
  const expandingColumn = visibleColumns.includes("title") ? "title" : visibleColumns.reduce(
    (widest, column) => widest === null || widths[column] > widths[widest] ? column : widest, null,
  );
  const extraWidth = expandingColumn === null ? 0 : Math.max(0, availableWidth - configuredWidth);
  if (expandingColumn !== null) fittedWidths[expandingColumn] += extraWidth;
  return { widths: fittedWidths, totalWidth: configuredWidth + extraWidth };
};

const readStoredAlignments = () => {
  try { const value = JSON.parse(localStorage.getItem(alignmentStorageKey)); return isRecord(value) ? value : {}; }
  catch { return {}; } // Corrupted optional preferences fall back to each table's defaults.
};
const writeStoredAlignments = (alignments) => {
  try { localStorage.setItem(alignmentStorageKey, JSON.stringify(alignments)); }
  catch { /* Optional local preferences must not block the tables. */ }
};
export const applySavedColumnAlignments = (defaults, saved) => Object.fromEntries(Object.entries(defaults).map(([column, alignment]) => [
  column, isRecord(saved) && ["left", "center", "right"].includes(saved[column]) ? saved[column] : alignment,
]));
export const restoreLocalColumnAlignments = (table, defaults) => {
  const saved = readStoredAlignments();
  return applySavedColumnAlignments(defaults, table === "main" || table === "analogs" ? commonOfferPreferences(saved) : saved[table]);
};
export const applyColumnAlignment = (cell, alignment) => {
  cell.style.textAlign = alignment;
  const justify = alignment === "left" ? "flex-start" : alignment === "right" ? "flex-end" : "center";
  cell.querySelectorAll(".table-sort, .analogs-sort, .price-heading, .delivery-warehouse, .result-title-cell").forEach((node) => { node.style.justifyContent = justify; });
};

export const saveColumnWidths = (table, widths, alignments) => {
  const storedWidths = readStoredWidths();
  storedWidths[table] = widths;
  if (table === "main" || table === "analogs") storedWidths.main = storedWidths.analogs = widths;
  writeStoredWidths(storedWidths);
  const storedAlignments = readStoredAlignments();
  if (alignments) {
    storedAlignments[table] = alignments;
    if (table === "main" || table === "analogs") storedAlignments.main = storedAlignments.analogs = alignments;
    writeStoredAlignments(storedAlignments);
  }

  void fetch("/api/ui-preferences/table-column-widths", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ widths: storedWidths, alignments: storedAlignments }),
  }).catch(() => {
    // A temporary network failure leaves the latest local preference intact.
  });
};

export const loadSharedColumnWidths = async () => {
  const response = await fetch("/api/ui-preferences/table-column-widths");
  if (!response.ok) throw new Error("Could not load table preferences");
  const payload = await response.json();
  if (!isRecord(payload) || !isRecord(payload.widths)) return {};
  writeStoredWidths(payload.widths);
  writeStoredAlignments(isRecord(payload.alignments) ? payload.alignments : {});
  return payload.widths;
};
