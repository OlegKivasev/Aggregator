const quantity = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 3 });
let dialog;

export function renderStockGroups(container, product, details) {
  const groups = [
    ["original", "Оригинал", [{ name: product.name, article: product.article, quantity: details.original }]],
    ["replacements", "Замена", details.replacements],
  ];
  container.replaceChildren(...groups.map(([key, title, lines]) => {
    const section = document.createElement("section");
    const heading = document.createElement("p");
    heading.className = "stock-detail-group-title";
    heading.id = container.id + "-" + key;
    heading.textContent = title;
    section.setAttribute("aria-labelledby", heading.id);
    section.append(heading);
    if (!lines.length) {
      const empty = document.createElement("p");
      empty.textContent = "Нет взаимозаменяемых товаров";
      section.append(empty);
      return section;
    }
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

function openStockDetails(product, total, details) {
  if (!dialog) {
    dialog = document.createElement("dialog");
    dialog.className = "stock-details";
    dialog.id = "stock-details";
    dialog.setAttribute("aria-labelledby", "stock-details-title");
    dialog.innerHTML = `
      <h2 id="stock-details-title">Остаток с учётом заказов</h2>
      <p class="stock-details-total"></p>
      <div class="stock-detail-groups" id="stock-detail-groups"></div>
      <form method="dialog"><button class="btn btn-light" autofocus>Закрыть</button></form>`;
    document.body.append(dialog);
    dialog.addEventListener("close", () => {
      if (dialog.open) return;
      dialog.querySelector(".stock-details-total").textContent = "";
      dialog.querySelector(".stock-detail-groups").replaceChildren();
    });
    document.addEventListener("aggregator-auth-ready", () => {
      if (dialog.open) dialog.close();
    });
  }
  dialog.querySelector(".stock-details-total").textContent = `Всего ${quantity.format(total)}`;
  renderStockGroups(dialog.querySelector(".stock-detail-groups"), product, details);
  dialog.showModal();
  dialog.scrollTop = 0;
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
  if (popover) {
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-controls", popover.id);
    button.addEventListener("click", (event) => popover.openStock(button, product, total, event));
  } else {
    button.addEventListener("click", () => openStockDetails(product, total, product.stockDetails));
  }
  return button;
}
