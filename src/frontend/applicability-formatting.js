import { transmissionAliases } from "./transmission-aliases.js";
import { normalizeElectrification } from "./electrification-normalizer.js";

const combinedVanAndSuvPattern = /автофургон\s*\/\s*спортивно-утилитарный\s+автомобиль/i;
const engineDisplacementPattern = /(?:^|\s)(\d{1,2}[.,]\d{1,2})(?=\s|$)/;
const minimumEngineDisplacementLiters = 0.5;
const maximumEngineDisplacementLiters = 10;
const technicalTokenCanonicalizations = [
  [/\bt-gdi\b/gi, "T-GDI"],
  [/\btgdi\b/gi, "T-GDI"],
  [/\bcrdi\b/gi, "CRDi"],
  [/\bmpi\b/gi, "MPI"],
  [/\bgdi\b/gi, "GDI"],
  [/\bvvti\b|\bvvt[- ]i\b/gi, "VVT-i"],
  [/\bccvt\b/gi, "CVVT"],
  [/\bhybrid\b/gi, "Hybrid"],
];
const compoundTechnicalCanonicalizations = [
  [/\ball\s*[-‐‑‒–—―]?\s*wheel\s+drive\b/gi, "AWD"],
  [/\bawd\b/gi, "AWD"],
  [/\b4x4\b|\b4wd\b/gi, "4WD"],
];

const bodyDescriptors = [
  { bodyType: "SUV/Внедорожник", pattern: combinedVanAndSuvPattern, removableIfTerminal: false, removeAnywhere: true },
  { bodyType: "С бортовой платформой/ходовая часть", pattern: /с\s+бортовой\s+платформой\s*\/\s*ходовая\s+часть|platform\/chassis/i, removableIfTerminal: true },
  { bodyType: "Фургон/универсал", pattern: /фургон\s*\/\s*универсал/i, removableIfTerminal: true },
  { bodyType: "Автофургон / микроавтобус", pattern: /\bhatchback\s+van\b|\bcombi\s+van\b|\bkombi\s+van\b/i, removableIfTerminal: true },
  { bodyType: "Автофургон / микроавтобус", pattern: /автофургон\s*\/\s*микроавтобус|\bvan\b/i, removableIfTerminal: true },
  { bodyType: "Автофургон / микроавтобус", pattern: /\bcargo\b/i, removableIfTerminal: true },
  { bodyType: "Фургон/хэтчбэк", pattern: /фургон\s*\/\s*хетчбэк|фургон\s*\/\s*хэтчбэк/i, removableIfTerminal: true },
  { bodyType: "Автобус", pattern: /\bbus\b|автобус/i, removableIfTerminal: true },
  { bodyType: "Фургон", pattern: /фургон/i, removableIfTerminal: true },
  { bodyType: "Пикап", pattern: /пикап|pick[ -]?up/i, removableIfTerminal: true },
  { bodyType: "SUV/Внедорожник", pattern: /спортивно-утилитарный|\bsuv\b|\b4x4\b|off[ -]?road/i, removableIfTerminal: true },
  { bodyType: "Седан", pattern: /седан|\bsaloon\b/i, removableIfTerminal: true },
  { bodyType: "Универсал", pattern: /универсал|station wagon|\bestate\b|\btourer\b|\bturnier\b/i, removableIfTerminal: true },
  { bodyType: "Хэтчбэк", pattern: /хэтчбэк|хетчбэк|\bhatchback\b/i, removableIfTerminal: true },
  { bodyType: "Лифтбэк", pattern: /лифтбэк|\bliftback\b/i, removableIfTerminal: true },
  { bodyType: "Фастбэк", pattern: /\bfastback\b/i, removableIfTerminal: true },
  { bodyType: "Купе", pattern: /купе|\bcoup[eé]\b|\bkoup\b/i, removableIfTerminal: true },
  { bodyType: "Кабриолет", pattern: /кабриолет|\bconvertible\b|\bcabrio\b/i, removableIfTerminal: true },
  { bodyType: "Тарга", pattern: /тарга|\btarga\b/i, removableIfTerminal: true },
  { bodyType: "Родстер", pattern: /родстер|\broadster\b/i, removableIfTerminal: true },
  { bodyType: "Вэн", pattern: /вэн|\bmpv\b|minivan|active tourer|gran tourer|picasso/i, removableIfTerminal: true },
  { bodyType: "Универсал", pattern: /\bsportswagon\b|\bsw\b/i, removableIfTerminal: false },
];

const textValue = (value) => typeof value === "string" && value.trim() ? value.trim() : "отсутствует";

const yearValue = (value, fallback = "отсутствует") => {
  const source = typeof value === "string" && value.trim() ? value.trim() : fallback;
  const match = source.match(/\d{4}/);
  return match?.[0] ?? source;
};

const yearPeriod = (yearStart, yearEnd) => {
  const start = yearValue(yearStart);
  const end = yearValue(yearEnd, "н.в.");
  return /^\d{4}$/.test(start) && start === end ? start : `${start}-${end}`;
};

const bodyDescriptor = (modelName) => {
  const source = textValue(modelName);
  return bodyDescriptors.find((descriptor) => descriptor.pattern.test(source));
};

const bodyType = (modelName) => bodyDescriptor(modelName)?.bodyType ?? "отсутствует";

const bodyCodes = (modelName) => {
  const source = textValue(modelName);
  if (source === "отсутствует") return [];

  return [...source.matchAll(/\(([^()]*)\)/g)]
    .flatMap((match) => match[1].split(/[\/,;|]+/))
    .map((code) => code.replaceAll("_", "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
};

const bodyCode = (modelName) => [...new Set(bodyCodes(modelName))].join("/") || "отсутствует";

const codeFragments = (modelName) => {
  const source = textValue(modelName);
  const fragment = source.match(/\(([^()]*)$/)?.[1] ?? "";
  return fragment
    .split(/[\/,;|]+/)
    .map((value) => value.replaceAll("_", "").replace(/\s+/g, " ").trim())
    .filter((value) => /^[\p{L}\p{N}]{1,12}$/u.test(value));
};

const canonicalizeTechnicalTokens = (value) => [...compoundTechnicalCanonicalizations, ...technicalTokenCanonicalizations]
  .reduce((normalized, [pattern, canonical]) => normalized.replace(pattern, canonical), normalizeElectrification(value));

const normalizeTransmissionText = (value) => textValue(value)
  .toLocaleLowerCase()
  .replace(/[‐‑‒–—―-]/g, " ")
  .replace(/[./]/g, " ")
  .replace(/\s/g, " ");

const escapeRegularExpression = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const aliasExpression = (normalizedAlias) => escapeRegularExpression(normalizedAlias).replaceAll(" ", "\\s+");

const numericTransmissionPatterns = [
  { canonicalType: "Робот", priority: 575, subtype: "DCT", conflictRelevant: true, pattern: /(?<![\p{L}\p{N}])(?:\d+\s*(?:dct|dsg|amt)|(?:dct|dsg|amt)\s*\d+)(?![\p{L}\p{N}])/giu },
  { canonicalType: "Вариатор", priority: 525, subtype: "CVT", conflictRelevant: true, pattern: /(?<![\p{L}\p{N}])cvt\s*\d+(?![\p{L}\p{N}])/giu },
  { canonicalType: "Механика", priority: 525, subtype: "manual", conflictRelevant: true, pattern: /(?<![\p{L}\p{N}])(?:\d+\s*(?:speed\s+)?(?:manual|mt|m\s*t|bvm)|(?:mt|m\s*t|bvm)\s*\d+)(?![\p{L}\p{N}])/giu },
  { canonicalType: "АКПП", priority: 525, subtype: "torque_converter", conflictRelevant: true, pattern: /(?<![\p{L}\p{N}])(?:\d+\s*(?:speed\s+)?(?:automatic|at|a\s*t|bva|eat)|(?:at|a\s*t|bva|eat)\s*\d+)(?![\p{L}\p{N}])/giu },
  { canonicalType: "АКПП", priority: 575, subtype: "torque_converter", pattern: /(?<![\p{L}\p{N}])zf\s*\d+\s*hp(?![\p{L}\p{N}])/giu },
  { canonicalType: "АКПП", priority: 575, subtype: "torque_converter", pattern: /(?<![\p{L}\p{N}])(?:4|5|7|9)g\s*tronic(?:\s+plus)?(?![\p{L}\p{N}])/giu },
];

const aliasMatches = (normalized) => transmissionAliases.flatMap((alias) => {
  const expression = new RegExp(`(^|\\s)(${aliasExpression(alias.normalizedAlias)})(?=$|\\s)`, "giu");
  return [...normalized.matchAll(expression)].map((match) => ({
    ...alias,
    end: match.index + match[0].length,
    start: match.index + match[1].length,
  }));
});

const numericMatches = (normalized) => numericTransmissionPatterns.flatMap((definition) => {
  definition.pattern.lastIndex = 0;
  return [...normalized.matchAll(definition.pattern)].map((match) => ({
    ...definition,
    end: match.index + match[0].length,
    start: match.index,
  }));
});

const selectTransmissionMatches = (matches) => matches
  .sort((first, second) => second.priority - first.priority || (second.end - second.start) - (first.end - first.start))
  .reduce((selected, match) => selected.some((other) => match.start < other.end && other.start < match.end) ? selected : [...selected, match], []);

const removeTransmissionAliases = (source, matches) => [...matches]
  .sort((first, second) => second.start - first.start)
  .reduce((remaining, match) => `${remaining.slice(0, match.start)} ${remaining.slice(match.end)}`, source)
  .replace(/\s{2,}/g, " ")
  .replace(/\s+([,;:/)])/g, "$1")
  .replace(/([(/])\s+/g, "$1")
  .replace(/(?:^|\s)[‐‑‒–—―-]+(?=\s|$)/gu, " ")
  .trim() || "отсутствует";

const extractTransmission = (carName) => {
  const normalized = normalizeTransmissionText(carName);
  if (normalized === "отсутствует") return { carName, transmission: "отсутствует" };
  const matches = selectTransmissionMatches([...aliasMatches(normalized), ...numericMatches(normalized)]);
  const concreteTypes = new Set(matches.filter(({ conflictRelevant }) => conflictRelevant).map(({ canonicalType }) => canonicalType));
  if (concreteTypes.size > 1 || !matches.length) return { carName, transmission: "отсутствует" };

  const highestPriority = Math.max(...matches.map(({ priority }) => priority));
  const winningTypes = new Set(matches.filter(({ priority }) => priority === highestPriority).map(({ canonicalType }) => canonicalType));
  if (winningTypes.size !== 1) return { carName, transmission: "отсутствует" };

  const transmission = [...winningTypes][0];
  const removableMatches = matches.filter((match) => match.canonicalType === transmission || match.removableWithWinner);
  return { carName: removeTransmissionAliases(carName, removableMatches), transmission };
};

const compatibleBodyCode = (baseCodes, candidate) => {
  const normalizedCandidate = candidate.toLocaleUpperCase();
  return baseCodes.some((baseCode) => {
    const normalizedBaseCode = baseCode.toLocaleUpperCase();
    return normalizedCandidate.startsWith(normalizedBaseCode);
  });
};

const extractCompatibleBodyCode = (carName, baseCodes) => {
  const match = carName.match(/\s*\(([^()]*)\)\s*$/);
  const candidate = match?.[1].trim() ?? "";
  if (!/^[\p{L}\p{N}]{2,12}$/u.test(candidate) || !compatibleBodyCode(baseCodes, candidate)) {
    return { bodyCode: null, carName };
  }
  return {
    bodyCode: candidate.toLocaleUpperCase(),
    carName: carName.slice(0, match.index).trim() || "отсутствует",
  };
};

const terminalBodyDescriptor = (source, descriptor) => {
  if (!descriptor?.removableIfTerminal) return null;
  const descriptorMatch = descriptor.pattern.exec(source);
  const matchedText = descriptorMatch?.[0] ?? "";
  const start = descriptorMatch?.index ?? -1;
  if (start < 0 || source.slice(start + matchedText.length).trim()) return null;
  return { start, text: matchedText };
};

const modelWithoutBodyType = (modelName) => {
  const source = textValue(modelName);
  const withoutCodes = source.replace(/\s*\([^()]*\)/g, "").replace(/\s*\([^()]*$/, "");
  const descriptor = bodyDescriptor(withoutCodes);
  const terminalDescriptor = terminalBodyDescriptor(withoutCodes, descriptor);
  const withoutBodyType = descriptor?.removeAnywhere
    ? withoutCodes.replace(descriptor.pattern, "")
    : terminalDescriptor
      ? `${withoutCodes.slice(0, terminalDescriptor.start)}${withoutCodes.slice(terminalDescriptor.start + terminalDescriptor.text.length)}`
      : withoutCodes;
  const model = (descriptor?.removeAnywhere
    ? withoutBodyType.replace(/\s*\([^()]*$/, "")
    : withoutBodyType)
    .replace(/\s{2,}/g, " ")
    .trim();
  return model.replace(/(?<![\p{L}\p{N}])SANTA FÉ(?![\p{L}\p{N}])/giu, "SANTA FE") || "отсутствует";
};

const normalizedVehicleIdentity = (vehicle) => `${textValue(vehicle?.makeName).toLocaleUpperCase()}\u0000${modelWithoutBodyType(vehicle?.modelName).toLocaleUpperCase()}`;

const yearRange = (vehicle) => {
  const start = Number.parseInt(yearValue(vehicle?.yearStart, ""), 10);
  const end = Number.parseInt(yearValue(vehicle?.yearEnd, ""), 10);
  return {
    start: Number.isInteger(start) ? start : null,
    end: Number.isInteger(end) ? end : null,
  };
};

const yearsOverlap = (first, second) => {
  if (first.start === null || second.start === null) return false;
  const firstEnd = first.end ?? Infinity;
  const secondEnd = second.end ?? Infinity;
  return first.start <= secondEnd && second.start <= firstEnd;
};

const buildBodyCodeIndex = (vehicles) => vehicles.reduce((index, vehicle) => {
  const codes = bodyCodes(vehicle?.modelName);
  if (!codes.length || codeFragments(vehicle?.modelName).length) return index;
  const key = normalizedVehicleIdentity(vehicle);
  const entries = index.get(key) ?? [];
  entries.push({ codes, years: yearRange(vehicle) });
  index.set(key, entries);
  return index;
}, new Map());

const recoveredBodyCode = (vehicle, codeIndex) => {
  const fragments = codeFragments(vehicle?.modelName);
  if (!fragments.length) return null;
  const candidates = codeIndex.get(normalizedVehicleIdentity(vehicle))?.filter((entry) => yearsOverlap(yearRange(vehicle), entry.years)) ?? [];
  if (!candidates.length) return null;

  const recoveredCodes = fragments.map((fragment) => {
    const normalizedFragment = fragment.toLocaleUpperCase();
    const availableCodes = new Set(candidates
      .flatMap(({ codes }) => codes)
      .map((code) => code.toLocaleUpperCase()));
    const exactCodes = new Set([...availableCodes].filter((code) => code === normalizedFragment));
    const matchingCodes = exactCodes.size
      ? exactCodes
      : new Set([...availableCodes].filter((code) => code.startsWith(normalizedFragment)));
    return matchingCodes.size === 1 ? [...matchingCodes][0] : null;
  });
  return recoveredCodes.every(Boolean) ? [...new Set(recoveredCodes)].join("/") : null;
};

const splitCarName = (carName) => {
  const source = textValue(carName);
  if (source === "отсутствует") return { capacity: source, remaining: source };
  const match = source.match(engineDisplacementPattern);
  if (!match || match.index === undefined) return { capacity: "отсутствует", remaining: source };
  const capacity = match[1].replace(",", ".");
  const capacityLiters = Number(capacity);
  if (capacityLiters < minimumEngineDisplacementLiters || capacityLiters > maximumEngineDisplacementLiters) {
    return { capacity: "отсутствует", remaining: source };
  }
  const remaining = `${source.slice(0, match.index)} ${source.slice(match.index + match[0].length)}`.trim();
  return { capacity, remaining: remaining || "отсутствует" };
};

export const formatApplicabilityVehicle = (vehicle, visibleColumns, recoveredCode = null) => {
  const record = vehicle && typeof vehicle === "object" && !Array.isArray(vehicle) ? vehicle : {};
  const modelName = textValue(record.modelName);
  const { capacity, remaining } = splitCarName(record.carName);
  const model = modelWithoutBodyType(modelName);
  const codes = recoveredCode ? recoveredCode.split("/") : bodyCodes(modelName);
  const refinedBodyCode = extractCompatibleBodyCode(remaining, codes);
  const codeVariants = refinedBodyCode.bodyCode
    ? [refinedBodyCode.bodyCode]
    : model === "SAMARA" && codes.length ? codes : [recoveredCode ?? bodyCode(modelName)];
  const transmission = extractTransmission(refinedBodyCode.carName);
  const modification = canonicalizeTechnicalTokens(transmission.carName);

  return codeVariants
    .map((code) => [
      ["bodyType", bodyType(modelName)],
      ["bodyCode", code],
      ["makeName", textValue(record.makeName)],
      ["modelName", model === "SAMARA" && code !== "отсутствует" ? code : model],
      ["years", yearPeriod(record.yearStart, record.yearEnd)],
      ["capacity", capacity],
      ["transmission", transmission.transmission],
      ["carName", modification],
    ]
      .filter(([column]) => visibleColumns ? visibleColumns.has(column) : column !== "transmission")
      .map(([, value]) => value)
      .join(", "))
    .join("\n");
};

export const formatApplicabilityVehicles = (vehicles, visibleColumns) => {
  const records = Array.isArray(vehicles) ? vehicles : [];
  const codeIndex = buildBodyCodeIndex(records);
  return records
    .map((vehicle) => formatApplicabilityVehicle(vehicle, visibleColumns, recoveredBodyCode(vehicle, codeIndex)))
    .join("\n");
};
