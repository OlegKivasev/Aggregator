import { isIP } from "node:net";
import { createBoundedAbortSignal } from "../abort.ts";
import { SupplierTimeoutError } from "../errors.ts";
import { readBoundedJsonResponse } from "../suppliers/fetch-json.ts";
import { ImageSearchKey, validImageSearchKey } from "./image-search-key.ts";

export class PartImageError extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}
export interface PartImage { title: string; thumbnail: string; image: string; source: string; link: string }
interface ImagePage { images: PartImage[]; nextPage: number | null }
export interface PartImageQuery { article: string; brand: string; page: number }

const field = (value: unknown, maximum: number): value is string => typeof value === "string" && value.trim().length > 0
  && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);

export function partImageQuery(article: unknown, brand: unknown, page: unknown): PartImageQuery {
  if (!field(article, 128) || !field(brand, 200) || typeof page !== "number" || !Number.isInteger(page) || page < 0 || page > 9) {
    throw new PartImageError("Укажите корректные бренд и артикул.", 400);
  }
  return { article: article.trim(), brand: brand.trim(), page };
}

function publicUrl(value: unknown, allowHttp = false): string | null {
  if (typeof value !== "string" || value.length > 4096) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/\.$/, "");
    if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:") || url.username || url.password || url.port || isIP(host) || host.includes(":")
      || !host.includes(".") || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host)) return null;
    return url.href;
  } catch { return null; }
}

export function parsePartImages(payload: unknown, page: number): ImagePage {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new PartImageError("Сервис изображений вернул некорректный ответ.", 502);
  const data = payload as Record<string, unknown>;
  if (data.error !== undefined) throw new PartImageError("Сервис изображений не выполнил поиск. Проверьте ключ и доступный лимит.", 502);
  if (!Array.isArray(data.images_results) || data.images_results.length > 500) {
    throw new PartImageError("Сервис изображений вернул некорректный ответ.", 502);
  }
  const images: PartImage[] = [];
  const seen = new Set<string>();
  for (const value of data.images_results) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    const thumbnail = publicUrl(row.thumbnail); const link = publicUrl(row.link, true);
    if (!thumbnail || !link || !field(row.title, 500) || seen.has(thumbnail)) continue;
    const source = field(row.source, 200) ? row.source.trim() : new URL(link).hostname;
    seen.add(thumbnail);
    images.push({ title: row.title.trim(), thumbnail, image: publicUrl(row.original) ?? thumbnail, source, link });
  }
  if (data.images_results.length && !images.length) throw new PartImageError("Сервис не вернул доступных изображений. Попробуйте открыть Google Картинки.", 502);
  const pagination = data.serpapi_pagination;
  const hasNext = pagination && typeof pagination === "object" && !Array.isArray(pagination)
    && typeof (pagination as Record<string, unknown>).next === "string";
  return { images, nextPage: images.length && hasNext && page < 9 ? page + 1 : null };
}

export class PartImageSearch {
  private readonly key: ImageSearchKey;
  private readonly request: typeof fetch;
  private readonly cache = new Map<string, { expires: number; value: ImagePage }>();
  private settingsController = new AbortController();
  private active = 0;
  constructor(key: ImageSearchKey, request: typeof fetch = globalThis.fetch) { this.key = key; this.request = request; }
  state() { return this.key.state(); }
  configure(value: unknown) {
    if (!validImageSearchKey(value)) throw new PartImageError("Введите корректный API-ключ SerpApi.", 400);
    this.key.set(value); this.reset(); return this.state();
  }
  disconnect() { this.key.delete(); this.reset(); return this.state(); }
  private reset(): void { this.settingsController.abort(); this.settingsController = new AbortController(); this.cache.clear(); }
  close(): void { this.settingsController.abort(); this.cache.clear(); }
  async search(input: PartImageQuery, signal: AbortSignal): Promise<ImagePage> {
    const query = partImageQuery(input.article, input.brand, input.page);
    signal.throwIfAborted();
    const key = this.key.get();
    if (!key) throw new PartImageError("Для галереи укажите API-ключ SerpApi в настройках поиска изображений.", 503);
    const cacheKey = JSON.stringify(query);
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expires > Date.now()) return structuredClone(cached.value);
    if (this.active >= 4) throw new PartImageError("Поиск изображений занят. Повторите попытку чуть позже.", 429);
    const bounded = createBoundedAbortSignal(AbortSignal.any([signal, this.settingsController.signal]), 20_000, "Image search timed out");
    this.active++;
    try {
      const url = new URL("https://serpapi.com/search.json");
      url.search = new URLSearchParams({ engine: "google_images", q: `${query.brand} ${query.article}`, hl: "ru", safe: "active",
        nfpr: "1", ijn: String(query.page), api_key: key }).toString();
      const response = await this.request(url, { headers: { Accept: "application/json" }, redirect: "error", signal: bounded.signal });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401 || response.status === 403) throw new PartImageError("SerpApi отклонил ключ. Проверьте его в настройках изображений.", 401);
        if (response.status === 429) throw new PartImageError("Лимит поиска SerpApi исчерпан. Проверьте баланс сервиса.", 429);
        throw new PartImageError("Поиск изображений временно недоступен.", 502);
      }
      const result = parsePartImages(await readBoundedJsonResponse(response, 2 * 1024 * 1024, "Image search"), query.page);
      bounded.signal.throwIfAborted();
      if (this.cache.size >= 100) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(cacheKey, { value: structuredClone(result), expires: Date.now() + 10 * 60_000 });
      return result;
    } catch (error) {
      signal.throwIfAborted();
      if (bounded.signal.aborted) {
        if (bounded.signal.reason instanceof SupplierTimeoutError) throw new PartImageError("Поиск изображений занял слишком много времени. Повторите попытку.", 504);
        throw new PartImageError("Настройки изображений изменились. Повторите поиск.", 409);
      }
      if (error instanceof PartImageError) throw error;
      throw new PartImageError("Не удалось получить изображения. Повторите попытку позже.", 502);
    } finally { this.active--; bounded.dispose(); }
  }
}
