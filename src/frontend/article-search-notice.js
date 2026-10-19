export function readArticleVariants(value) {
  if (!Array.isArray(value) || value.length !== 1) return [];
  const variant = value[0];
  if (!variant || typeof variant !== "object" || !["short", "full"].includes(variant.form)
    || typeof variant.article !== "string" || !variant.article.trim() || variant.article.length > 128
    || /[\u0000-\u001f\u007f]/u.test(variant.article)) return [];
  return [{ article: variant.article, form: variant.form }];
}

export function articleVariantNotice(variants) {
  const [variant] = readArticleVariants(variants);
  return variant ? `Дополнительно ищем по ${variant.form === "short" ? "сокращённому" : "полному"} написанию артикула: ${variant.article}.` : "";
}
