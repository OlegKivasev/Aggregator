import { normalizeApplicabilitySku, parseApplicabilitySkus } from "./applicability-search-input.js";

export const applicabilityFileMaxBytes = 1024 * 1024;
const maxRows = 500;

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
  const makes = new Map(makeNames.map((name) => [name.toLocaleUpperCase(), name]));
  const seen = new Set();
  const rows = [];
  text.replace(/^\uFEFF/u, "").split(/\r\n|\n|\r/u).forEach((line, index) => {
    if (!line.trim()) return;
    const parts = line.split("|");
    const row = { lineNumber: index + 1, sku: parts[0].trim(), brand: (parts[1] ?? "").trim(), error: "" };
    if (parts.length !== 2 || !row.sku || !row.brand) {
      row.error = "Нужен формат: артикул | бренд";
    } else {
      try {
        const skus = parseApplicabilitySkus(row.sku);
        if (skus.length !== 1 || row.sku.includes(",")) throw new Error("В строке должен быть один артикул.");
        if (row.brand.length > 128 || /[\u0000-\u001f\u007f]/u.test(row.brand)) throw new Error("Некорректный бренд.");
        const make = makes.get(row.brand.replace(/\s+/gu, " ").toLocaleUpperCase());
        if (!make) throw new Error("Бренд не найден в списке.");
        row.brand = make;
        const identity = `${normalizeApplicabilitySku(row.sku).toLocaleUpperCase()}\u0000${make.toLocaleUpperCase()}`;
        if (seen.has(identity)) row.error = "Повтор в файле";
        else seen.add(identity);
      } catch (error) {
        row.error = error.message;
      }
    }
    rows.push(row);
    if (rows.length > maxRows) throw new Error(`В файле должно быть не более ${maxRows} непустых строк.`);
  });
  if (!rows.length) throw new Error("Файл не содержит строк для поиска.");
  return rows;
}
