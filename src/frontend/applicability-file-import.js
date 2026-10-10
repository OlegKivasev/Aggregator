import { normalizeApplicabilitySku, parseApplicabilitySkus } from "./applicability-search-input.js";
import { createApplicabilityMakeMatcher } from "./applicability-make-aliases.js";

export const applicabilityFileMaxBytes = 1024 * 1024;
const maxRows = 5000;
const maxArticles = 100;

export function decodeApplicabilityFile(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length > applicabilityFileMaxBytes) throw new Error("Размер файла не должен превышать 1 МБ.");
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le", { fatal: true }).decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be", { fatal: true }).decode(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // Older Windows text files may use Windows-1251 instead of UTF-8.
    return new TextDecoder("windows-1251").decode(bytes);
  }
}

export function parseApplicabilityFile(text, makeNames) {
  if (typeof text !== "string" || text.length > applicabilityFileMaxBytes) throw new Error("Размер файла не должен превышать 1 МБ.");
  const makes = createApplicabilityMakeMatcher(makeNames);
  const lines = text.replace(/^\uFEFF/u, "").split(/\r\n|\n|\r/u);
  if (lines.filter((line) => line.trim()).length > maxRows) throw new Error(`В файле должно быть не более ${maxRows} непустых строк.`);
  const structured = lines.some((line) => /^\s*Артикул\s*:/iu.test(line));
  const articles = new Map();
  let article = null;
  const seen = new Set();
  const rows = [];
  const validateSku = (sku) => {
    const skus = parseApplicabilitySkus(sku);
    if (skus.length !== 1 || sku.includes(",")) throw new Error("В строке должен быть один артикул.");
  };
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    const header = /^\s*Артикул\s*:\s*(.*?)\s*$/iu.exec(line);
    if (header) {
      article = null;
      try {
        validateSku(header[1]);
        const identity = normalizeApplicabilitySku(header[1]).toLocaleUpperCase();
        if (!articles.has(identity)) articles.set(identity, header[1]);
        article = articles.get(identity);
      } catch (error) {
        rows.push({ lineNumber: index + 1, article: null, sku: header[1], brand: "", error: error.message });
      }
      return;
    }
    const parts = line.replace(/^\s*OEM-артикул\s*:\s*/iu, "").split("|");
    const row = { lineNumber: index + 1, sku: parts[0].trim(), brand: (parts[1] ?? "").trim(), error: "" };
    if (structured) row.article = article;
    if (structured && !article) {
      row.error = "Сначала укажите исходный артикул: Артикул: …";
    } else if (parts.length !== 2 || !row.sku || !row.brand) {
      row.error = "Нужен формат: артикул | бренд";
    } else {
      try {
        validateSku(row.sku);
        if (row.brand.length > 128 || /[\u0000-\u001f\u007f]/u.test(row.brand)) throw new Error("Некорректный бренд.");
        const make = makes.resolve(row.brand);
        if (!make && /^(GM|GENERAL\s+MOTORS|ДЖЕНЕРАЛ\s+МОТОРС)$/iu.test(row.brand)) {
          throw new Error("GM не определяет одну марку автомобиля. Укажите конкретный бренд.");
        }
        if (!make) throw new Error("Бренд не найден в списке.");
        row.brand = make;
        const identity = `${article ?? ""}\u0000${normalizeApplicabilitySku(row.sku).toLocaleUpperCase()}\u0000${make.toLocaleUpperCase()}`;
        if (seen.has(identity)) row.error = "Повтор в файле";
        else seen.add(identity);
      } catch (error) {
        row.error = error.message;
      }
    }
    rows.push(row);
  });
  if (articles.size > maxArticles) throw new Error(`В файле должно быть не более ${maxArticles} исходных артикулов.`);
  if (!rows.length) throw new Error("Файл не содержит строк для поиска.");
  return { articles: [...articles.values()], rows };
}
