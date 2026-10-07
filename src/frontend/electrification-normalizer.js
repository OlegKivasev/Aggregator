import { electrificationAliases } from "./electrification-aliases.js";

const normalizeSearchText = (value) => value
  .toLocaleLowerCase()
  .replace(/[‐‑‒–—―-]/g, " ")
  .replace(/[./]/g, " ")
  .replace(/\s/g, " ");

const escapeRegularExpression = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const normalizedAliasExpression = (normalizedAlias) => escapeRegularExpression(normalizedAlias).replaceAll(" ", "\\s+");

const selectAliases = (source) => {
  const normalized = normalizeSearchText(source);
  const matches = electrificationAliases.flatMap((alias) => {
    const expression = new RegExp(`(^|\\s)(${normalizedAliasExpression(alias.normalizedAlias)})(?=$|\\s)`, "giu");
    return [...normalized.matchAll(expression)].map((match) => ({
      ...alias,
      end: match.index + match[0].length,
      start: match.index + match[1].length,
    }));
  });

  return matches
    .sort((first, second) => second.priority - first.priority || (second.end - second.start) - (first.end - first.start))
    .reduce((selected, match) => selected.some((other) => match.start < other.end && other.start < match.end) ? selected : [...selected, match], []);
};

export const normalizeElectrification = (source) => {
  const matches = selectAliases(source).sort((first, second) => first.start - second.start);
  const normalized = matches.reduce(({ cursor, value }, match) => ({
    cursor: match.end,
    value: `${value}${source.slice(cursor, match.start)}${match.canonical}`,
  }), { cursor: 0, value: "" });
  const withAliases = `${normalized.value}${source.slice(normalized.cursor)}`;

  return ["Plug-in Hybrid", "MHEV 48V", "MHEV", "HEV", "FCEV", "EV"]
    .reduce((value, canonical) => value.replace(new RegExp(`\\b${escapeRegularExpression(canonical)}(?:\\s+${escapeRegularExpression(canonical)})+\\b`, "g"), canonical), withAliases);
};
