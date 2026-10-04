const storageKey = "autoservice.tableColumnWidths.v1";
const minimumColumnWidth = 80;
const maximumColumnWidth = 800;

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

export const restoreLocalColumnWidths = (table, defaults) => applySavedColumnWidths(defaults, readStoredWidths()[table]);

export const saveColumnWidths = (table, widths) => {
  const storedWidths = readStoredWidths();
  storedWidths[table] = widths;
  writeStoredWidths(storedWidths);

  void fetch("/api/ui-preferences/table-column-widths", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ widths: storedWidths }),
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
  return payload.widths;
};

export const setupColumnResizing = ({ table, columnAttribute, widths, apply, save }) => {
  let resize = null;

  const updateHandle = (handle, column) => {
    handle.setAttribute("aria-valuenow", String(widths[column]));
  };
  const setWidth = (column, value) => {
    const width = Math.min(maximumColumnWidth, Math.max(minimumColumnWidth, Math.round(value)));
    widths[column] = width;
    apply();
    table.querySelectorAll(`.table-column-resize[data-resize-column="${column}"]`).forEach((handle) => updateHandle(handle, column));
  };

  table.querySelectorAll(`th[${columnAttribute}]`).forEach((header) => {
    const column = header.getAttribute(columnAttribute);
    if (!column || !(column in widths)) return;

    const handle = document.createElement("span");
    handle.className = "table-column-resize";
    handle.dataset.resizeColumn = column;
    handle.tabIndex = 0;
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-label", `Изменить ширину столбца ${header.textContent.trim()}`);
    handle.setAttribute("aria-valuemin", String(minimumColumnWidth));
    handle.setAttribute("aria-valuemax", String(maximumColumnWidth));
    updateHandle(handle, column);
    header.append(handle);

    handle.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      resize = { column, pointerId: event.pointerId, startX: event.clientX, startWidth: widths[column] };
      handle.setPointerCapture(event.pointerId);
      document.body.classList.add("is-resizing-table-column");
    });
    handle.addEventListener("pointermove", (event) => {
      if (!resize || resize.pointerId !== event.pointerId) return;
      setWidth(resize.column, resize.startWidth + event.clientX - resize.startX);
    });
    const finishResize = (event) => {
      if (!resize || resize.pointerId !== event.pointerId) return;
      resize = null;
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      document.body.classList.remove("is-resizing-table-column");
      save();
    };
    handle.addEventListener("pointerup", finishResize);
    handle.addEventListener("pointercancel", finishResize);
    handle.addEventListener("click", (event) => event.stopPropagation());
    handle.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      event.stopPropagation();
      setWidth(column, widths[column] + (event.key === "ArrowRight" ? 1 : -1) * (event.shiftKey ? 25 : 10));
      save();
    });
  });
};
