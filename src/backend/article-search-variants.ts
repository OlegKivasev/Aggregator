import type { ArticleSearchVariant } from "./types.ts";

export function additionalArticleVariants(
  article: string,
  { preserveArticleSuffix = false }: { preserveArticleSuffix?: boolean } = {},
): ArticleSearchVariant[] {
  const source = article.trim();
  if (source.length > 128 || !/^[0-9\s.-]+$/u.test(source)) return [];
  if (/[\s.-]/u.test(source) && !/^(?:11|21)\d{2}0?[\s.-]+\d{7}(?:[\s.-]+\d{2})?$/u.test(source)) return [];
  const digits = source.replace(/[\s.-]/gu, "");
  const full = /^((?:11|21)\d{2})0(\d{7})(\d{2})?$/.exec(digits);
  const short = /^((?:11|21)\d{2})(\d{7})(\d{2})?$/.exec(digits);
  const match = full ?? short;
  if (!match) return [];
  const [, model, detail, suffix] = match;
  const originalBase = `${model}${full ? "0" : ""}-${detail}`;
  const alternateBase = `${model}${full ? "" : "0"}-${detail}`;
  const alternateForm = full ? "short" : "full";
  const variants: ArticleSearchVariant[] = [
    { article: `${alternateBase}${suffix ? `-${suffix}` : ""}`, form: alternateForm },
  ];
  if (!preserveArticleSuffix && (!suffix || suffix === "00")) {
    const alternateSuffix = suffix ? "" : "-00";
    variants.push(
      { article: `${originalBase}${alternateSuffix}`, form: full ? "full" : "short" },
      { article: `${alternateBase}${alternateSuffix}`, form: alternateForm },
    );
  }
  return variants;
}
