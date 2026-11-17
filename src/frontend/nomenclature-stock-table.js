const numberFormat = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 3 });

// Keep three batches in the DOM. Measured spacers preserve access to earlier rows.
export function createStockTable(rows, before, after, selectionChanged = () => {}) {
  const selected = new Set();
  const productsById = new Map();
  let selectionAnchor;
  let showPrice = false;
  const currencyFormats = new Map();
  const priceText = (price) => {
    if (!price) return "—";
    if (!currencyFormats.has(price.currency)) currencyFormats.set(price.currency, new Intl.NumberFormat("ru-RU", { style: "currency", currency: price.currency }));
    return currencyFormats.get(price.currency).format(price.amount) + (price.unit ? ` / ${price.unit}` : "");
  };
  const paintSelection = () => {
    for (const row of rows.children) row.setAttribute("aria-selected", String(selected.has(row.dataset.productId)));
    selectionChanged(selected.size);
  };
  const select = (row, event) => {
    const id = row.dataset.productId;
    if (event.shiftKey && selectionAnchor && productsById.has(selectionAnchor)) {
      const ids = [...productsById.keys()]; const a = ids.indexOf(selectionAnchor); const b = ids.indexOf(id);
      if (!event.ctrlKey && !event.metaKey) selected.clear();
      for (let index = Math.min(a, b); index <= Math.max(a, b); index += 1) selected.add(ids[index]);
    } else {
      if (event.ctrlKey || event.metaKey || event.type === "keydown" && event.key === " ") {
        if (selected.has(id)) selected.delete(id); else selected.add(id);
      } else { selected.clear(); selected.add(id); }
      selectionAnchor = id;
    }
    paintSelection();
  };
  rows.addEventListener("click", (event) => { const row = event.target.closest("tr[data-product-id]"); if (row) select(row, event); });
  rows.addEventListener("keydown", (event) => {
    if (![" ", "Enter"].includes(event.key)) return;
    const row = event.target.closest("tr[data-product-id]");
    if (row) { event.preventDefault(); select(row, event); }
  });
  let chunks = [];
  let offsets = [0];
  let rendered = new Map();
  let range = "";
  let frame;
  let width = 0;
  const rebuildOffsets = () => {
    offsets = [0];
    for (const chunk of chunks) offsets.push(offsets.at(-1) + chunk.height);
  };
  const spacer = (element, height) => { element.style.height = `${Math.max(0, height)}px`; };
  const render = (force = false) => {
    if (!chunks.length || !rows.getClientRects().length) return;
    const origin = before.parentElement.getBoundingClientRect().top + window.scrollY;
    const target = Math.max(0, window.scrollY + window.innerHeight / 2 - origin);
    let low = 0; let high = chunks.length - 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (offsets[middle + 1] <= target) low = middle + 1; else high = middle;
    }
    let start = Math.max(0, Math.min(low - 1, chunks.length - 3));
    let end = Math.min(chunks.length, start + 3);
    if (!force && range === `${start}/${end}`) return;
    const anchor = [...rows.children].find((row) => row.getBoundingClientRect().bottom > 0);
    const anchorTop = anchor?.getBoundingClientRect().top;
    if (force && anchor) {
      start = Math.max(0, Math.min(Number(anchor.dataset.chunk) - 1, chunks.length - 3));
      end = Math.min(chunks.length, start + 3);
    }
    for (const key of rendered.keys()) if (key < start || key >= end) rendered.delete(key);
    const fragment = document.createDocumentFragment();
    for (let index = start; index < end; index += 1) {
      if (!rendered.has(index)) {
        rendered.set(index, chunks[index].products.map((product, position) => {
          const row = document.createElement("tr");
          row.dataset.chunk = String(index);
          row.dataset.productId = product.id;
          row.tabIndex = 0;
          row.setAttribute("aria-selected", String(selected.has(product.id)));
          row.setAttribute("aria-rowindex", String(index * 100 + position + 2));
          for (const text of [product.name, product.article || "—", numberFormat.format(product.quantity)]) {
            const cell = document.createElement("td"); cell.textContent = text; row.append(cell);
          }
          if (showPrice) { const cell = document.createElement("td"); cell.dataset.stockPrice = ""; cell.textContent = priceText(product.price); row.append(cell); }
          return row;
        }));
      }
      fragment.append(...rendered.get(index));
    }
    rows.replaceChildren(fragment);
    for (let index = start; index < end; index += 1) {
      const elements = rendered.get(index);
      chunks[index].height = elements.at(-1).getBoundingClientRect().bottom - elements[0].getBoundingClientRect().top;
    }
    rebuildOffsets();
    spacer(before, offsets[start]);
    spacer(after, offsets.at(-1) - offsets[end]);
    range = `${start}/${end}`;
    if (anchor?.isConnected && anchorTop !== undefined) {
      const difference = anchor.getBoundingClientRect().top - anchorTop;
      if (Math.abs(difference) > 0.5) window.scrollBy(0, difference);
    }
  };
  const schedule = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = undefined; render(); });
  };
  window.addEventListener("scroll", schedule, { passive: true });
  new ResizeObserver(([entry]) => {
    if (entry.contentRect.width <= 0 || entry.contentRect.width === width) return;
    width = entry.contentRect.width;
    for (const chunk of chunks) chunk.height = chunk.products.length * 44;
    rebuildOffsets(); render(true);
  }).observe(rows.closest("table"));
  return {
    reset(price = false) { showPrice = price; chunks = []; offsets = [0]; rendered.clear(); productsById.clear(); selected.clear(); selectionAnchor = undefined; range = ""; rows.replaceChildren(); spacer(before, 0); spacer(after, 0); selectionChanged(0); },
    append(products) {
      if (!products.length) return;
      for (const product of products) productsById.set(product.id, product);
      chunks.push({ products, height: products.length * 44 });
      rebuildOffsets(); render(true);
    },
  };
}
