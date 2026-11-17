// The complete small navigation snapshot is received with the first stock page.
// Expanding and searching it never sends catalogue requests.
export function createNomenclatureNavigation(changed) {
  const selected = { category: null, group: null };
  let mode = "category";
  const sidebar = document.querySelector("#nomenclature-navigation");
  const toggle = document.querySelector("#nomenclature-navigation-toggle");
  const trees = ["category", "group"].map((kind) => ({ kind, items: [], expanded: new Set(),
    input: document.querySelector(`#nomenclature-${kind}-query`), list: document.querySelector(`#nomenclature-${kind}-tree`) }));
  const paint = (tree) => {
    const query = tree.input.value.trim().toLocaleLowerCase("ru-RU");
    const ids = new Map(tree.items.map((item) => [item.id, item]));
    const visible = new Set();
    if (query) for (const item of tree.items) {
      const name = item.name.toLocaleLowerCase("ru-RU");
      if (!query.split(/\s+/).every((term) => name.includes(term))) continue;
      let parent = item;
      while (parent && !visible.has(parent.id)) { visible.add(parent.id); parent = ids.get(parent.parentId); }
    }
    const children = new Map();
    for (const item of tree.items) {
      const parent = ids.has(item.parentId) ? item.parentId : null;
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(item);
    }
    const fragment = document.createDocumentFragment();
    const all = document.createElement("button"); all.type = "button"; all.className = "garage-vehicles__button nomenclature-tree-all";
    all.textContent = tree.kind === "category" ? "Все категории" : "Все группы";
    all.setAttribute("aria-pressed", String(!selected[tree.kind]));
    all.addEventListener("click", () => { if (!selected[tree.kind]) return; selected[tree.kind] = null; paint(tree); changed(); });
    const allRow = document.createElement("li"); allRow.append(all); fragment.append(allRow);
    const pending = [...(children.get(null) ?? [])].reverse().map((item) => ({ item, depth: 0 }));
    while (pending.length) {
        const { item, depth } = pending.pop();
        if (query && !visible.has(item.id)) continue;
        const row = document.createElement("li"); row.className = "garage-group-item nomenclature-tree-item";
        row.style.setProperty("--tree-depth", String(Math.min(depth, 12)));
        const hasChildren = children.has(item.id);
        const open = !!query || tree.expanded.has(item.id);
        const expand = document.createElement("button"); expand.type = "button"; expand.className = "nomenclature-tree-expand";
        expand.disabled = !hasChildren;
        expand.setAttribute("aria-label", `${open ? "Свернуть" : "Раскрыть"} ${item.name}`);
        if (hasChildren) expand.setAttribute("aria-expanded", String(open));
        const arrow = document.createElement("img"); arrow.src = "/nomenclature-expand.png"; arrow.alt = ""; expand.append(arrow);
        expand.addEventListener("click", () => { if (open) tree.expanded.delete(item.id); else tree.expanded.add(item.id); paint(tree); });
        const button = document.createElement("button"); button.type = "button"; button.className = "garage-vehicles__button garage-group-item__button";
        button.setAttribute("aria-pressed", String(selected[tree.kind] === item.id)); button.dataset.navigationId = item.id;
        const icon = document.createElement("img"); icon.src = "/nomenclature-folder.png"; icon.alt = ""; icon.className = "nomenclature-tree-folder";
        const label = document.createElement("span"); label.textContent = item.name;
        if (item.isFolder || tree.kind === "group") button.append(icon);
        button.append(label);
        button.addEventListener("click", () => {
          if (selected[tree.kind] === item.id) return;
          selected[tree.kind] = item.id;
          for (let parent = ids.get(item.parentId); parent; parent = ids.get(parent.parentId)) tree.expanded.add(parent.id);
          paint(tree); changed();
        });
        row.append(expand, button); fragment.append(row);
        if (hasChildren && open) for (const child of [...children.get(item.id)].reverse()) pending.push({ item: child, depth: depth + 1 });
    }
    if (query && !visible.size) { const empty = document.createElement("li"); empty.className = "panel__meta"; empty.textContent = "Ничего не найдено"; fragment.append(empty); }
    tree.list.replaceChildren(fragment);
  };
  for (const tree of trees) tree.input.addEventListener("input", () => paint(tree));
  for (const radio of document.querySelectorAll('[name="nomenclature-navigation-mode"]')) radio.addEventListener("change", () => {
    const previous = mode; mode = radio.value;
    for (const tree of trees) document.querySelector(`#nomenclature-${tree.kind}-panel`).hidden = tree.kind !== mode;
    if (selected[previous] || selected[mode]) changed();
  });
  toggle.addEventListener("click", () => { sidebar.hidden = !sidebar.hidden; toggle.setAttribute("aria-expanded", String(!sidebar.hidden)); });
  return {
    get selected() { return { category: mode === "category" ? selected.category : null, group: mode === "group" ? selected.group : null }; },
    update(value) {
      if (!value || !Array.isArray(value.categories) || !Array.isArray(value.groups) || !Array.isArray(value.oemBrands)) throw new Error("Не удалось загрузить категории из 1С.");
      for (const tree of trees) { tree.items = tree.kind === "category" ? value.categories : value.groups; paint(tree); }
    },
  };
}
