export function readArticleVariants(value) {
  if (!Array.isArray(value) || value.length > 3) return [];
  const variants = [];
  for (const variant of value) {
    if (!variant || typeof variant !== "object" || !["short", "full"].includes(variant.form)
      || typeof variant.article !== "string" || !variant.article.trim() || variant.article.length > 128
      || /[\u0000-\u001f\u007f]/u.test(variant.article) || variants.some(({ article }) => article === variant.article)) return [];
    variants.push({ article: variant.article, form: variant.form });
  }
  return variants;
}

export function articleVariantNotice(variants) {
  const validated = readArticleVariants(variants);
  if (validated.length > 1) return `Также ищем по артикулам ${validated.map(({ article }) => article).join(", ")}.`;
  const [variant] = validated;
  return variant ? `Дополнительно ищем по ${variant.form === "short" ? "сокращённому" : "полному"} написанию артикула: ${variant.article}.` : "";
}
