export function setupUserListOrder({ list, save, onError }) {
  if (!list) return;
  const rows = () => [...list.querySelectorAll(":scope > .users-list__row")];
  let drag = null;
  let saving = false;

  const clearPreview = () => {
    list.querySelectorAll(".is-user-drop-before, .is-user-drop-after").forEach((row) => {
      row.classList.remove("is-user-drop-before", "is-user-drop-after");
    });
  };
  const persist = async (previous) => {
    const current = rows();
    if (current.every((row, index) => row === previous[index])) return;
    saving = true;
    list.setAttribute("aria-busy", "true");
    try {
      await save(current.map((row) => row.dataset.userId));
    } catch (error) {
      // Preserve cards added or removed while the save was in flight, along with unsaved edits.
      const remaining = rows();
      [...previous.filter((row) => row.parentElement === list), ...remaining.filter((row) => !previous.includes(row))]
        .forEach((row) => list.append(row));
      onError(error instanceof Error ? error.message : "Не удалось сохранить порядок пользователей.");
    } finally {
      saving = false;
      list.removeAttribute("aria-busy");
    }
  };
  const updateTarget = () => {
    clearPreview();
    const bounds = list.getBoundingClientRect();
    drag.valid = drag.x >= bounds.left && drag.x <= bounds.right && drag.y >= bounds.top - 24 && drag.y <= bounds.bottom + 24;
    if (!drag.valid) return;
    const others = rows().filter((row) => row !== drag.row);
    drag.before = others.find((row) => {
      const rect = row.getBoundingClientRect();
      return drag.y < rect.top + rect.height / 2;
    }) ?? null;
    if (drag.before) drag.before.classList.add("is-user-drop-before");
    else others.at(-1)?.classList.add("is-user-drop-after");
  };
  const scrollWhileDragging = () => {
    if (!drag?.active) return;
    const scroller = list.closest(".settings-drawer");
    if (drag.y < 64) scroller?.scrollBy(0, -12);
    else if (drag.y > innerHeight - 64) scroller?.scrollBy(0, 12);
    updateTarget();
    drag.frame = requestAnimationFrame(scrollWhileDragging);
  };
  const finish = (commit = false) => {
    if (!drag) return;
    const state = drag;
    drag = null;
    cancelAnimationFrame(state.frame);
    clearPreview();
    state.row.classList.remove("is-user-dragging");
    if (state.handle.hasPointerCapture(state.pointerId)) state.handle.releasePointerCapture(state.pointerId);
    if (commit && state.active && state.valid && state.row.parentElement === list) {
      const previous = rows();
      list.insertBefore(state.row, state.before);
      state.handle.focus({ preventScroll: true });
      void persist(previous);
    }
  };
  list.addEventListener("pointerdown", (event) => {
    const handle = event.target.closest(".users-list__handle");
    if (!handle || event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    event.stopPropagation();
    if (saving || drag) return;
    handle.focus({ preventScroll: true });
    handle.setPointerCapture(event.pointerId);
    drag = { handle, row: handle.closest(".users-list__row"), pointerId: event.pointerId,
      startY: event.clientY, x: event.clientX, y: event.clientY, active: false, valid: false, before: null, frame: null };
  });
  list.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag.x = event.clientX;
    drag.y = event.clientY;
    if (!drag.active && Math.abs(drag.y - drag.startY) >= 5) {
      drag.active = true;
      drag.row.classList.add("is-user-dragging");
      scrollWhileDragging();
    }
    if (drag.active) updateTarget();
  });
  list.addEventListener("pointerup", (event) => {
    if (event.pointerId === drag?.pointerId) finish(true);
  });
  list.addEventListener("pointercancel", () => finish());
  list.addEventListener("lostpointercapture", () => finish());
  window.addEventListener("blur", () => finish());
  list.addEventListener("click", (event) => {
    if (event.target.closest(".users-list__handle")) {
      event.preventDefault();
      event.stopPropagation();
    }
  });
  list.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && drag) {
      event.preventDefault();
      event.stopPropagation();
      finish();
      return;
    }
    const handle = event.target.closest(".users-list__handle");
    if (!handle || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (saving || drag) return;
    const previous = rows();
    const row = handle.closest(".users-list__row");
    const index = previous.indexOf(row);
    const target = previous[index + (event.key === "ArrowUp" ? -1 : 1)];
    if (!target) return;
    list.insertBefore(row, event.key === "ArrowUp" ? target : target.nextSibling);
    handle.focus({ preventScroll: true });
    void persist(previous);
  });
}
