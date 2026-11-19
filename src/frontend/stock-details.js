const quantity = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 3 });
let dialog;

function openStockDetails(product, total, details) {
  if (!dialog) {
    dialog = document.createElement("dialog");
    dialog.className = "stock-details";
    dialog.id = "stock-details";
    dialog.setAttribute("aria-labelledby", "stock-details-title");
    dialog.innerHTML = `
      <h2 id="stock-details-title">Остаток с учётом заказов</h2>
      <p class="stock-details-total"></p>
      <section aria-labelledby="stock-details-original"><h3 id="stock-details-original">Оригинал</h3><dl></dl></section>
      <section aria-labelledby="stock-details-replacements"><h3 id="stock-details-replacements">Замена</h3>
        <dl></dl><p hidden>Нет взаимозаменяемых товаров</p>
      </section>
      <form method="dialog"><button class="btn btn-light" autofocus>Закрыть</button></form>`;
    document.body.append(dialog);
    dialog.addEventListener("close", () => {
      if (dialog.open) return;
      dialog.querySelector(".stock-details-total").textContent = "";
      for (const list of dialog.querySelectorAll("dl")) list.replaceChildren();
    });
    document.addEventListener("aggregator-auth-ready", () => {
      if (dialog.open) dialog.close();
    });
  }
  dialog.querySelector(".stock-details-total").textContent = `Всего ${quantity.format(total)}`;
  const groups = dialog.querySelectorAll("dl");
  function fill(list, lines) {
    const fragment = document.createDocumentFragment();
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
      fragment.append(row);
    }
    list.replaceChildren(fragment);
  }
  fill(groups[0], [{ name: product.name, article: product.article, quantity: details.original }]);
  fill(groups[1], details.replacements);
  groups[1].hidden = !details.replacements.length;
  groups[1].nextElementSibling.hidden = details.replacements.length > 0;
  dialog.showModal();
  dialog.scrollTop = 0;
}

export function stockQuantity(product, total) {
  if (total == null) return "—";
  const text = quantity.format(total);
  if (!product.stockDetails) return text;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "stock-details-trigger";
  button.textContent = text;
  button.setAttribute("aria-label", `Остаток ${text}. ${product.name}`);
  button.setAttribute("aria-haspopup", "dialog");
  button.addEventListener("click", () => openStockDetails(product, total, product.stockDetails));
  return button;
}
