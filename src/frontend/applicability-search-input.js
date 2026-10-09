export const normalizeApplicabilitySku = (sku) => sku.replace(/[^\p{L}\p{N}]/gu, "");

export function parseApplicabilitySkus(value) {
  if (typeof value !== "string" || value.length > 8192) {
    throw new Error("Список артикулов слишком длинный.");
  }
  const skus = new Map();
  for (const sku of value.split(",").map((part) => part.trim()).filter(Boolean)) {
    const identity = normalizeApplicabilitySku(sku).toLocaleUpperCase();
    if (sku.length > 128 || !identity || /[\u0000-\u001f\u007f]/.test(sku)) {
      throw new Error("Каждый артикул должен содержать буквы или цифры и не превышать 128 символов.");
    }
    if (!skus.has(identity)) skus.set(identity, sku);
    if (skus.size > 50) throw new Error("За один поиск можно указать до 50 разных артикулов.");
  }
  return [...skus.values()];
}

export async function runApplicabilityBatch(entries, request, signal) {
  const outcomes = new Array(entries.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(4, entries.length) }, async () => {
    while (!signal.aborted && nextIndex < entries.length) {
      const index = nextIndex++;
      const entry = entries[index];
      try {
        outcomes[index] = { entry, result: await request(entry, signal) };
      } catch (error) {
        outcomes[index] = { entry, error };
      }
    }
  }));
  return outcomes.filter(Boolean);
}
