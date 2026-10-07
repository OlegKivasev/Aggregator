const aliasRecords = (canonicalType, priority, normalizedAliases, options = {}) => normalizedAliases.map((normalizedAlias) => ({
  canonicalType,
  normalizedAlias,
  priority,
  ...options,
}));

const range = (start, end) => Array.from({ length: end - start + 1 }, (_, offset) => start + offset);

const numberedAliases = (numbers, suffixes) => numbers.flatMap((number) => suffixes.map((suffix) => `${number}${suffix}`));

// These aliases are already lower-cased and separator-normalized. The detector
// applies the identical normalization to the source before matching whole tokens.
export const transmissionAliases = [
  ...aliasRecords("Робот", 500, [
    "dual clutch transmission", "dual clutch", "double clutch", "twin clutch transmission", "twin clutch", "efficient dual clutch",
    "porsche doppelkupplung", "automated manual transmission", "automated manual", "automated gearbox", "robotic transmission", "robotized transmission", "robotised transmission",
    "dct steptronic", "steptronic dct", "m dct drivelogic", "speedshift dct", "twin clutch sst", "sequential manual gearbox", "multi mode transmission",
    "s tronic", "pdk", "powershift", "power shift", "tct", "edc", "ddct", "d dct", "dcct", "tc sst",
    "m dct", "smg ii", "smg iii", "smg2", "smg3", "r tronic", "rtronic", "e gear", "selespeed", "dual logic", "dualogic", "easytronic", "easy tronic", "sensodrive", "senso drive",
    "etg", "egs", "bmp", "mcp", "mmt", "multimode", "multi mode", "amt", "a mt", "робот", "роботизированная", "роботизированная коробка", "ркпп", "ркп", "mta", "asg", "ags", "auto gear shift", "autogearshift",
  ], { conflictRelevant: true }),
  ...aliasRecords("Робот", 500, [
    ...numberedAliases(range(6, 8), ["dct"]),
    ...numberedAliases(range(6, 8), [" dct"]),
    ...numberedAliases(range(6, 8), ["dsg"]),
    ...numberedAliases(range(6, 8), [" dsg"]),
    ...numberedAliases(range(5, 6), ["etg"]),
    ...numberedAliases(range(5, 6), [" etg"]),
    ...numberedAliases(range(5, 6), ["mta"]),
    ...numberedAliases(range(5, 6), [" asg"]),
    ...numberedAliases(range(5, 6), ["asg"]),
    "dct6", "dct7", "dct8", "dct 6", "dct 7", "dct 8", "dsg6", "dsg7", "dsg 6", "dsg 7", "mta5", "mta6", "asg5", "asg6", "etg5", "etg6", "7g dct", "8g dct",
  ], { conflictRelevant: true }),
  ...aliasRecords("Робот", 450, ["dct", "dsg", "stronic"], { conflictRelevant: true }),
  ...aliasRecords("Вариатор", 400, [
    "electronic continuously variable transmission", "electronically controlled continuously variable transmission", "continuously variable transmission", "continuously variable",
    "smartstream ivt", "smart stream ivt", "direct shift cvt", "super cvt i", "cvt transmission", "intelligent variable transmission",
    "xtronic cvt", "lineartronic", "linear tronic", "multitronic", "multitronic", "multimatic", "autotronic", "cvt i", "cvti", "d cvt", "dcvt", "w cvt", "wcvt", "i cvt", "icvt",
    "xtronic", "x tronic", "ivt", "cvt", "c v t", "вариатор", "вариаторная коробка", "бесступенчатая коробка", "бесступенчатая трансмиссия",
  ], { conflictRelevant: true }),
  ...aliasRecords("Вариатор", 450, ["e cvt", "ecvt"], { subtype: "e-CVT", conflictRelevant: true }),
  ...aliasRecords("Вариатор", 400, ["cvt7", "cvt8"], { conflictRelevant: true }),
  ...aliasRecords("Механика", 200, [
    "manual transmission", "manual gearbox", "manual gear", "stick shift", "manual", "механическая коробка", "механическая кпп", "механическая", "механика", "мкпп", "мкп", "mt", "m t",
  ], { conflictRelevant: true }),
  ...aliasRecords("Механика", 300, [
    ...numberedAliases(range(4, 7), ["mt", " mt", "m t", " m t", " speed manual", " speed mt", " speed m t"]),
    "mt4", "mt5", "mt6", "mt7",
  ], { conflictRelevant: true }),
  ...aliasRecords("АКПП", 150, [
    "automatic transmission", "automatic gearbox", "automatic", "автоматическая коробка", "автоматическая кпп", "автоматическая", "автомат", "акпп", "акп",
    "tiptronic", "steptronic", "geartronic", "touchtronic", "commandshift", "command shift", "activematic", "invecs ii", "invecs iii", "invecs", "sportronic",
    "g tronic", "zf4hp", "zf5hp", "zf6hp", "zf8hp", "zf9hp", "auto", "at", "a t",
  ]),
  ...aliasRecords("АКПП", 300, [
    ...numberedAliases(range(3, 10), ["at", " at", "a t", " a t", " speed automatic"]),
    ...numberedAliases([4, 5, 6, 8, 9], ["hp", " hp"]),
    "at3", "at4", "at5", "at6", "at7", "at8", "at9", "at10", "4g tronic", "5g tronic", "7g tronic", "9g tronic", "7g tronic plus",
  ], { conflictRelevant: true }),
];
