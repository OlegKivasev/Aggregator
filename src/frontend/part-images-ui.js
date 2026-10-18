const text = (tag, className, value) => {
  const node = document.createElement(tag); node.className = className; node.textContent = value; return node;
};
const safeUrl = (value, allowHttp = false) => {
  if (typeof value !== "string" || value.length > 4096) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:") || url.username || url.password || url.port || !url.hostname.replace(/\.$/, "").includes(".")
      || /^[\d.]+$/.test(url.hostname) || url.hostname.includes(":") || /(?:^|\.)(?:localhost|local|internal|test|invalid)\.?$/.test(url.hostname)) return null;
    return url.href;
  } catch { return null; }
};
const validPage = (value) => value && Array.isArray(value.images) && value.images.length <= 500
  && (value.nextPage === null || Number.isInteger(value.nextPage) && value.nextPage > 0 && value.nextPage <= 9)
  && value.images.every((item) => item && [item.title, item.source].every((value) => typeof value === "string" && value.length <= 500)
    && [item.thumbnail, item.image].every((url) => safeUrl(url)) && safeUrl(item.link, true));

export function bootstrapPartImages() {
  const dialog = document.createElement("dialog");
  dialog.id = "part-images-dialog"; dialog.className = "part-images"; dialog.setAttribute("aria-labelledby", "part-images-title");
  dialog.innerHTML = `<header><div><h2 id="part-images-title">Изображения товара</h2><p>Google Картинки · поиск по бренду и артикулу</p></div><button type="button" data-images-close aria-label="Закрыть изображения">×</button></header>
    <div class="part-images__body">
      <form class="part-images__search"><label>Бренд<input id="part-images-brand" maxlength="200" required autocomplete="off"></label><label>Артикул<input id="part-images-article" maxlength="128" required autocomplete="off"></label><button type="submit" class="btn btn-primary">Найти</button></form>
      <div class="part-images__links"><a id="part-images-google" target="_blank" rel="noopener noreferrer">Открыть Google Картинки</a><button type="button" id="part-images-settings-toggle">Настройки поиска</button></div>
      <details id="part-images-settings"><summary>Подключение SerpApi</summary><p>Для галереи нужен ключ <a href="https://serpapi.com/manage-api-key" target="_blank" rel="noopener noreferrer">SerpApi</a>. Доступность и лимиты запросов зависят от тарифа сервиса.</p>
        <form class="part-images__key"><label>API-ключ SerpApi<input id="part-images-key" type="password" maxlength="512" autocomplete="off" placeholder="Введите API-ключ"></label><button type="submit" class="btn btn-primary">Сохранить ключ</button><button type="button" class="btn btn-light" id="part-images-disconnect">Удалить ключ</button></form><p id="part-images-key-state" role="status"></p>
      </details>
      <p id="part-images-feedback" role="status" aria-live="polite"></p>
      <section class="part-images__preview" hidden aria-label="Просмотр изображения"><button type="button" aria-label="Закрыть просмотр изображения">×</button><img referrerpolicy="no-referrer" alt=""><div><strong></strong><a target="_blank" rel="noopener noreferrer">Открыть источник</a></div><p role="status" hidden>Изображение недоступно на сайте источника.</p></section>
      <div id="part-images-grid" class="part-images__grid" aria-busy="false"></div>
      <footer><p>Поисковая выдача может содержать похожие детали.</p><button id="part-images-more" type="button" class="btn btn-light" hidden>Показать ещё</button></footer>
    </div>`;
  document.body.append(dialog);
  const brand = dialog.querySelector("#part-images-brand"); const article = dialog.querySelector("#part-images-article");
  const grid = dialog.querySelector("#part-images-grid"); const feedback = dialog.querySelector("#part-images-feedback");
  const settings = dialog.querySelector("#part-images-settings"); const keyInput = dialog.querySelector("#part-images-key");
  const keyState = dialog.querySelector("#part-images-key-state"); const disconnect = dialog.querySelector("#part-images-disconnect");
  const searchForm = dialog.querySelector(".part-images__search"); const keyForm = dialog.querySelector(".part-images__key");
  const more = dialog.querySelector("#part-images-more"); const preview = dialog.querySelector(".part-images__preview");
  const previewImage = preview.querySelector("img"); const google = dialog.querySelector("#part-images-google");
  let controller = null; let generation = 0; let nextPage = null; let anchor = null; let selectedImage = null; let configured = false;
  const images = new Set();

  const updateGoogle = () => {
    const url = new URL("https://www.google.com/search"); url.search = new URLSearchParams({ tbm: "isch", q: `${brand.value.trim()} ${article.value.trim()}` });
    google.href = url.href;
  };
  const busy = (value) => {
    grid.setAttribute("aria-busy", String(value));
    searchForm.querySelector("button").disabled = value; more.disabled = value;
  };
  const hidePreview = () => { preview.hidden = true; previewImage.onerror = null; previewImage.removeAttribute("src"); selectedImage = null; };
  const state = (value) => {
    if (!value || typeof value.configured !== "boolean" || typeof value.persistent !== "boolean") throw new Error("Не удалось прочитать настройки изображений.");
    configured = value.configured;
    keyState.textContent = value.configured ? value.persistent ? "Ключ сохранён на сервере в зашифрованном виде." : "Ключ подключён до перезапуска сервера. Для сохранения требуется серверное шифрование." : "Ключ ещё не подключён.";
    disconnect.disabled = !value.configured;
    return value;
  };
  const request = async (url, options, signal) => {
    let response; let value;
    try { response = await fetch(url, { ...options, signal }); }
    catch { signal.throwIfAborted(); throw new Error("Не удалось соединиться с поиском изображений. Повторите попытку."); }
    try { value = await response.json(); }
    catch { signal.throwIfAborted(); throw new Error("Поиск изображений вернул некорректный ответ. Повторите попытку."); }
    if (!response.ok) throw new Error(typeof value?.message === "string" && value.message.length <= 500 ? value.message : "Не удалось получить изображения.");
    return value;
  };
  const showPreview = (item, button) => {
    selectedImage = button; preview.hidden = false; preview.querySelector("p").hidden = true;
    previewImage.alt = item.title; previewImage.src = item.image;
    previewImage.onerror = () => {
      if (previewImage.src !== item.thumbnail) previewImage.src = item.thumbnail;
      else { previewImage.removeAttribute("src"); preview.querySelector("p").hidden = false; }
    };
    preview.querySelector("strong").textContent = item.title; preview.querySelector("a").href = item.link;
    preview.querySelector("button").focus(); preview.scrollIntoView({ block: "nearest" });
  };
  const render = (item) => {
    if (images.has(item.thumbnail)) return;
    images.add(item.thumbnail);
    const card = text("article", "part-images__card", "");
    const button = document.createElement("button"); button.type = "button"; button.setAttribute("aria-label", `Увеличить: ${item.title}`);
    const image = document.createElement("img"); image.src = item.thumbnail; image.alt = item.title; image.loading = "lazy"; image.referrerPolicy = "no-referrer";
    image.addEventListener("error", () => { button.classList.add("has-error"); button.append(text("span", "", "Изображение недоступно")); }, { once: true });
    button.append(image); button.addEventListener("click", () => showPreview(item, button));
    const source = text("a", "", item.source); source.href = item.link; source.target = "_blank"; source.rel = "noopener noreferrer";
    card.append(button, text("p", "", item.title), source); grid.append(card);
  };
  const search = async (page = 0) => {
    if (!searchForm.reportValidity()) return;
    controller?.abort(); controller = new AbortController(); const current = ++generation;
    updateGoogle();
    if (!page) { grid.replaceChildren(); images.clear(); nextPage = null; more.hidden = true; hidePreview(); }
    busy(true); feedback.textContent = "Ищем изображения…";
    const query = new URLSearchParams({ brand: brand.value.trim(), article: article.value.trim(), page: String(page) });
    try {
      const value = await request(`/api/part-images?${query}`, {}, controller.signal);
      if (current !== generation || !dialog.open) return;
      if (!validPage(value) || value.nextPage !== null && value.nextPage <= page) throw new Error("Сервис вернул некорректные изображения.");
      value.images.forEach(render); nextPage = value.nextPage; more.hidden = nextPage === null;
      feedback.textContent = images.size ? `Найдено изображений: ${images.size}` : "Изображения не найдены. Уточните бренд или артикул либо откройте Google Картинки.";
    } catch (error) {
      if (current === generation && dialog.open && !controller.signal.aborted) feedback.textContent = error instanceof Error ? error.message : "Не удалось получить изображения.";
    } finally { if (current === generation) busy(false); }
  };
  searchForm.addEventListener("submit", (event) => { event.preventDefault(); void search(); });
  const changeQuery = () => {
    controller?.abort(); generation++; busy(false); updateGoogle(); nextPage = null; more.hidden = true;
    grid.replaceChildren(); images.clear(); hidePreview(); feedback.textContent = "Нажмите «Найти», чтобы обновить изображения.";
  };
  brand.addEventListener("input", changeQuery); article.addEventListener("input", changeQuery);
  more.addEventListener("click", () => { if (nextPage !== null) void search(nextPage); });
  dialog.querySelector("#part-images-settings-toggle").addEventListener("click", () => { settings.open = !settings.open; if (settings.open) keyInput.focus(); });
  const changeKey = async (remove) => {
    keyForm.querySelectorAll("button").forEach((button) => { button.disabled = true; });
    controller?.abort(); controller = new AbortController(); const current = ++generation; busy(false);
    let searchAfter = false;
    try {
      const value = await request("/api/part-images/key", { method: remove ? "DELETE" : "PUT",
        ...(!remove ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ apiKey: keyInput.value.trim() }) } : {}) }, controller.signal);
      if (current !== generation || !dialog.open) return;
      state(value); keyInput.value = ""; grid.replaceChildren(); images.clear(); hidePreview(); nextPage = null; more.hidden = true;
      if (value.configured) { settings.open = false; searchAfter = true; } else { feedback.textContent = "Ключ удалён. Поиск в Google доступен по ссылке выше."; settings.open = true; }
    } catch (error) {
      if (current === generation && dialog.open && !controller.signal.aborted) keyState.textContent = error instanceof Error ? error.message : "Не удалось изменить настройки изображений.";
    } finally {
      if (current === generation) { keyForm.querySelector("button[type=submit]").disabled = false; disconnect.disabled = !configured; }
    }
    if (searchAfter && current === generation && dialog.open) void search();
  };
  keyForm.addEventListener("submit", (event) => { event.preventDefault(); void changeKey(false); });
  disconnect.addEventListener("click", () => void changeKey(true));
  dialog.querySelector("[data-images-close]").addEventListener("click", () => dialog.close());
  const closePreview = () => { const button = selectedImage; hidePreview(); button?.focus(); };
  preview.querySelector("button").addEventListener("click", closePreview);
  dialog.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Escape" && !preview.hidden) { event.preventDefault(); closePreview(); }
  });
  dialog.addEventListener("close", () => {
    controller?.abort(); generation++; keyInput.value = ""; hidePreview(); busy(false); if (anchor?.isConnected) anchor.focus({ preventScroll: true });
  });
  dialog.addEventListener("click", (event) => { if (event.target === dialog && (event.clientX < dialog.getBoundingClientRect().left || event.clientX > dialog.getBoundingClientRect().right || event.clientY < dialog.getBoundingClientRect().top || event.clientY > dialog.getBoundingClientRect().bottom)) dialog.close(); });
  return async (result, origin) => {
    controller?.abort(); controller = new AbortController(); const current = ++generation;
    anchor = origin; brand.value = typeof result.brand === "string" ? result.brand.slice(0, 200) : "";
    article.value = typeof result.article === "string" ? result.article.slice(0, 128) : "";
    keyInput.value = ""; keyState.textContent = ""; grid.replaceChildren(); images.clear(); hidePreview(); more.hidden = true; nextPage = null;
    keyForm.querySelector("button[type=submit]").disabled = false; disconnect.disabled = true;
    settings.open = false; feedback.textContent = "Проверяем подключение поиска…"; updateGoogle();
    if (!dialog.open) dialog.showModal();
    busy(true);
    try {
      const value = await request("/api/part-images/key", {}, controller.signal);
      if (current !== generation || !dialog.open) return;
      state(value);
      if (value.configured) await search();
      else { settings.open = true; feedback.textContent = "Подключите SerpApi для просмотра изображений внутри программы. Поиск в Google по ссылке выше работает без ключа."; }
    } catch (error) {
      if (current === generation && dialog.open && !controller.signal.aborted) feedback.textContent = error instanceof Error ? error.message : "Не удалось подключить поиск изображений.";
    } finally { if (current === generation) busy(false); }
  };
}
