import type { ArticleSearchVariant } from "./types.ts";

export function additionalArticleVariants(
  article: string,
  { preserveArticleSuffix = false }: { preserveArticleSuffix?: boolean } = {},
): ArticleSearchVariant[] {
  const source = article.trim();
  if (source.length > 128) return [];
  const match = /^((?:11|21)\d{2})(\d?)[\s.-]+(\d{7})(?:[\s.-]+(\d{2}))?$/.exec(source)
    ?? /^((?:11|21)\d{2})(\d?)(\d{7})(\d{2})?$/.exec(source);
  if (!match) return [];
  const [, model, fifthDigit, detail, suffix] = match;
  const full = fifthDigit !== "";
  const originalBase = `${model}${fifthDigit}-${detail}`;
  const canToggleSuffix = !preserveArticleSuffix && (!suffix || suffix === "00");
  const alternateSuffix = suffix ? "" : "-00";
  if (full && fifthDigit !== "0") {
    return canToggleSuffix ? [{ article: `${originalBase}${alternateSuffix}`, form: "full" }] : [];
  }

  const alternateBase = `${model}${full ? "" : "0"}-${detail}`;
  const alternateForm = full ? "short" : "full";
  const variants: ArticleSearchVariant[] = [
    { article: `${alternateBase}${suffix ? `-${suffix}` : ""}`, form: alternateForm },
  ];
  if (canToggleSuffix) {
    variants.push(
      { article: `${originalBase}${alternateSuffix}`, form: full ? "full" : "short" },
      { article: `${alternateBase}${alternateSuffix}`, form: alternateForm },
    );
  }
  return variants;
}
