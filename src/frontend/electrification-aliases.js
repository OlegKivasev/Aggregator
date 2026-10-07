const aliasRecords = (electrificationType, canonical, priority, normalizedAliases) => normalizedAliases.map((normalizedAlias) => ({
  electrificationType,
  canonical,
  normalizedAlias,
  priority,
}));

// Aliases are lower case with punctuation normalized to spaces. The normalizer
// keeps the source intact until it has selected non-overlapping whole-token matches.
export const electrificationAliases = [
  ...aliasRecords("PHEV", "Plug-in Hybrid", 500, ["plug in hybrid", "phev"]),
  ...aliasRecords("FCEV", "FCEV", 450, ["fuel cell electric vehicle", "fuel cell ev", "hydrogen fuel cell", "fuel cell", "fcev"]),
  ...aliasRecords("MHEV_48V", "MHEV 48V", 400, ["hybrid 48v", "48v hybrid"]),
  ...aliasRecords("MHEV", "MHEV", 350, ["mhev"]),
  ...aliasRecords("HEV", "HEV", 300, ["hev", "hybrid"]),
  ...aliasRecords("EV", "EV", 250, ["electric vehicle", "electric", "ev"]),
];
