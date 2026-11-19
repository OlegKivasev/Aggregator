const quantity = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 3 });

export function renderStockGroups(container, product, details) {
  const groups = [];
  if (details.original > 0) {
    groups.push(["original", "Оригинал", [{ name: product.name, article: product.article, quantity: details.original }]]);
  }
  if (details.replacements.length) groups.push(["replacements", "Замена", details.replacements]);
  if (!groups.length) {
    const empty = document.createElement("p");
    empty.textContent = "Свободного остатка нет";
    container.replaceChildren(empty);
    return;
  }
  container.replaceChildren(...groups.map(([key, title, lines]) => {
    const section = document.createElement("section");
    const heading = document.createElement("p");
    heading.className = "stock-detail-group-title";
    heading.id = container.id + "-" + key;
    heading.textContent = title;
    section.setAttribute("aria-labelledby", heading.id);
    section.append(heading);
    const list = document.createElement("dl");
    for (const line of lines) {
      const row = document.createElement("div");
      const name = document.createElement("dt");
      const count = document.createElement("dd");
      name.textContent = line.name;
      if (line.article) {
        const article = document.createElement("small");
        article.textContent = line.article;
        name.append(article);
      }
      count.textContent = quantity.format(line.quantity);
      row.append(name, count);
      list.append(row);
    }
    section.append(list);
    return section;
  }));
}

export function stockQuantity(product, total, popover) {
  if (total == null) return "—";
  const text = quantity.format(total);
  if (!product.stockDetails) return text;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "stock-details-trigger";
  button.textContent = text;
  button.setAttribute("aria-label", `Остаток ${text}. ${product.name}`);
  button.setAttribute("aria-haspopup", "dialog");
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-controls", popover.id);
  button.addEventListener("click", (event) => popover.openStock(button, product, total, event));
  return button;
}
