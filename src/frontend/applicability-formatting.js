import { normalizeElectrification } from "./electrification-normalizer.js";

const combinedVanAndSuvPattern = /автофургон\s*\/\s*спортивно-утилитарный\s+автомобиль/i;
const decimalDisplacementPattern = /(?:^|\s)(\d{1,2}[.,]\d{1,2})(?=\s|$)/;
const integerCcDisplacementPattern = /(?:^|\s)(\d{3,4})(?=\s|$)/;
const minimumEngineDisplacementLiters = 0.4;
const maximumEngineDisplacementLiters = 10;
const minimumEngineDisplacementCc = 400;
const maximumEngineDisplacementCc = 8000;
const applicabilityDocumentFieldSeparator = " | ";
const engineContextPattern = /\b(?:4wd|4x4|awd|turbo|kompressor|supercharger|16v|8v|vtec|gti|gtd|diesel|petrol)\b/i;
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

const bodyAliasRegistry = [
  { bodyType: "SUV/Внедорожник", pattern: combinedVanAndSuvPattern, removableIfTerminal: false, removeAnywhere: true },
  { bodyType: "Универсал", pattern: /\bspace\s+wagon\b/i, removableIfTerminal: false },
  { bodyType: "Универсал", pattern: /\bsports?\s+tourer\b/i, removableIfTerminal: false },
  { bodyType: "Универсал", pattern: /\bcountry\s+tourer\b/i, removableIfTerminal: false },
  { bodyType: "Универсал", pattern: /\bmulti\s+wagon\b/i, removableIfTerminal: false },
  { bodyType: "Универсал", pattern: /\bstation\s+wagon\b/i, removableIfTerminal: false },
  { bodyType: "Вэн", pattern: /\bactive\s+tourer\b/i, removableIfTerminal: false },
  { bodyType: "Вэн", pattern: /\bgran\s+tourer\b/i, removableIfTerminal: false },
  { bodyType: "Купе", pattern: /\bgran\s+coup[eé]\b/i, removableIfTerminal: false },
  { bodyType: "С бортовой платформой/ходовая часть", pattern: /[сc]\s+бортовой\s+платформой\s*\/\s*ходовая\s+часть|platform\/chassis/i, removableIfTerminal: true },
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
  { bodyType: "Универсал", pattern: /универсал|station wagon|\bestate\b|\btourer\b|\bturnier\b|\bvariant\b|\bavant\b|\btouring\b|\bbreak\b|\bsport(?:s)?wagon\b|\bwagon\b|\bcombi\b/i, removableIfTerminal: true },
  { bodyType: "Хэтчбэк", pattern: /хэтчбэк|хетчбэк|\bhatchback\b/i, removableIfTerminal: true },
  { bodyType: "Лифтбэк", pattern: /лифтбэк|\bliftback\b/i, removableIfTerminal: true },
  { bodyType: "Фастбэк", pattern: /\bfastback\b/i, removableIfTerminal: true },
  { bodyType: "Купе", pattern: /купе|\bcoup[eé]\b|\bkoup\b/i, removableIfTerminal: true },
  { bodyType: "Кабриолет", pattern: /кабриолет|\bconvertible\b|\bcabrio(?:let)?\b/i, removableIfTerminal: true },
  { bodyType: "Тарга", pattern: /тарга|\btarga\b/i, removableIfTerminal: true },
  { bodyType: "Родстер", pattern: /родстер|\broadster\b/i, removableIfTerminal: true },
  { bodyType: "Вэн", pattern: /вэн|\bmpv\b|minivan|active tourer|gran tourer/i, removableIfTerminal: true },
  { bodyType: "Вэн", pattern: /picasso/i, removableIfTerminal: false },
  { bodyType: "Универсал", pattern: /\bsw\b/i, removableIfTerminal: false },
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

const parentheticalGroups = (modelName) => [...textValue(modelName).matchAll(/\(([^()]*)\)/g)]
  .map((match) => ({ value: match[1], index: match.index ?? 0 }));

const normalizedCodeToken = (value) => value.replaceAll("_", "").replace(/\s+/g, "").trim();

const isCodeExpression = (value) => {
  const expression = value.trim();
  if (!expression || !/^[\p{Lu}\p{Nd}_./,;|\-\s]+$/u.test(expression)) return false;

  const items = expression.split(/[,;|]+/).filter((item) => item.trim());
  return items.length && items.every((item) => {
    const compact = item.replace(/\s+/g, "");
    return compact
      && /^[\p{Lu}\p{Nd}_./-]+$/u.test(compact)
      && (/[^\p{Lu}]/u.test(compact) || compact.length <= 4);
  });
};

const codeItems = (expression) => expression
  .split(/[,;|]+/)
  .flatMap((item) => item.split(/\s+-\s+/))
  .map(normalizedCodeToken)
  .filter(Boolean);

const explicitVariantCodeItems = (expression) => expression
  .split(/[,;|]+/)
  .flatMap((item) => item.split(/\s+-\s+/))
  .map((item) => item.trim())
  .filter(Boolean);

const variantCodeTokenPattern = /^[\p{Lu}\p{Nd}_.-]{2,12}$/u;
const variantCodeSegmentPattern = /^[\p{Lu}\p{Nd}_.-]{1,12}$/u;

const parseCodeExpression = (value) => {
  if (!isCodeExpression(value)) return null;
  return {
    rawCodeExpression: value.trim(),
    codeItems: codeItems(value),
  };
};

const expandCodeAlternatives = (item) => {
  const parts = item.split("/");
  if (!parts.length || !variantCodeTokenPattern.test(parts[0]) || !parts.slice(1).every((part) => variantCodeSegmentPattern.test(part))) return null;
  if (parts.length === 1) return parts;

  const [baseCode, ...alternatives] = parts;
  const shorthandLength = alternatives[0]?.length ?? 0;
  const isSlashShorthand = shorthandLength > 0
    && alternatives.every((alternative) => alternative.length === shorthandLength && alternative.length < baseCode.length);
  if (isSlashShorthand) {
    return [baseCode, ...alternatives.map((alternative) => `${baseCode.slice(0, -shorthandLength)}${alternative}`)];
  }
  return parts.every((part) => variantCodeTokenPattern.test(part)) ? parts : null;
};

const parseVariantCodeExpression = (value) => {
  const items = explicitVariantCodeItems(value);
  if (!items.length || items.some((item) => engineContextPattern.test(item))) return null;
  const codeItems = items.flatMap((item) => expandCodeAlternatives(item) ?? []);
  if (!codeItems.length || codeItems.length < items.length) return null;
  return { rawCodeExpression: value.trim(), codeItems: [...new Set(codeItems.map(normalizedCodeToken).filter(Boolean))] };
};

const parseModelCodeTemplates = (value) => {
  if (!parseCodeExpression(value)) return [];
  const templates = explicitVariantCodeItems(value)
    .map((item) => item.replace(/\s+/g, ""))
    .flatMap((item) => expandCodeAlternatives(item) ?? []);
  return [...new Set(templates.map((template) => template.toLocaleUpperCase()))];
};

const classifyParentheticalGroup = (value) => {
  const codeExpression = parseCodeExpression(value);
  if (codeExpression) return { type: "CODE", codeItems: codeExpression.codeItems };

  const descriptor = bodyAliasRegistry.find((candidate) => candidate.pattern.test(value));
  if (descriptor) return { type: "BODY_DESCRIPTOR" };

  if (/\b(?:crew|double|single)\s+cab(?:in)?\b|\b(?:long|short)\s+wheelbase\b/i.test(value)) {
    return { type: "MODEL_QUALIFIER" };
  }
  return { type: "UNKNOWN_DESCRIPTOR" };
};

const classifiedCodeTokens = (group) => {
  const classification = classifyParentheticalGroup(group);
  return classification.type === "CODE" ? classification.codeItems : [];
};

const modelNameWithoutParentheticalGroups = (modelName) => textValue(modelName)
  .replace(/\(([^()]*)\)/g, (group, value) => {
    const classification = classifyParentheticalGroup(value);
    if (classification.type === "CODE") return "";
    return classification.type === "BODY_DESCRIPTOR" ? ` ${value}` : group;
  })
  .replace(/\s*\([^()]*$/, "")
  .replace(/\s{2,}/g, " ")
  .trim();

const bodyCodes = (modelName) => {
  const source = textValue(modelName);
  if (source === "отсутствует") return [];

  return parentheticalGroups(source).flatMap((group) => classifiedCodeTokens(group.value));
};

const modelCodeTemplates = (modelName) => parentheticalGroups(textValue(modelName)).flatMap((group) => parseModelCodeTemplates(group.value));

const terminalCodeFragment = (modelName) => {
  const source = textValue(modelName);
  return source.match(/\(([^()]*)$/)?.[1] ?? "";
};

const isDefinitivelyCompleteCodeItem = (rawItem) => {
  const compact = rawItem.replace(/\s+/g, "");
  return compact.length >= 3 || /[_./-]/.test(compact);
};

const terminalCodeFragments = (modelName) => {
  const expression = terminalCodeFragment(modelName);
  if (!isCodeExpression(expression)) return { completeCodeItems: [], incompleteCodeItems: [] };

  const segments = expression.split(/([,;|])/);
  const completeCodeItems = [];
  const incompleteCodeItems = [];
  for (let index = 0; index < segments.length; index += 2) {
    const rawItem = segments[index];
    if (!rawItem.trim()) continue;
    const item = normalizedCodeToken(rawItem);
    if (!item) continue;
    if (segments[index + 1] || isDefinitivelyCompleteCodeItem(rawItem)) completeCodeItems.push(item);
    else incompleteCodeItems.push(item);
  }
  return { completeCodeItems, incompleteCodeItems };
};

const canonicalizeTechnicalTokens = (value) => [...compoundTechnicalCanonicalizations, ...technicalTokenCanonicalizations]
  .reduce((normalized, [pattern, canonical]) => normalized.replace(pattern, canonical), normalizeElectrification(value));

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

const terminalVariantCodeCandidate = (carName) => {
  const match = carName.match(/\s*\(([^()]*)\)\s*$/);
  const expression = match?.[1] ?? "";
  const parsed = parseVariantCodeExpression(expression);
  const variantCodes = parsed?.codeItems ?? [];
  if (!variantCodes.length) {
    return { variantCodes: [], carName };
  }
  return {
    variantCodes: [...new Set(variantCodes.map((code) => code.toLocaleUpperCase()))],
    carName: carName.slice(0, match.index).trim() || "отсутствует",
  };
};

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const variantEmbedsBaseCode = (variantCode, baseCode) => baseCode.length >= 2
  && variantCode.length > baseCode.length
  && variantCode.includes(baseCode);

const variantMatchesTemplate = (variantCode, template) => {
  const normalizedVariant = variantCode.toLocaleUpperCase();
  const normalizedTemplate = template.replace(/\s+/g, "").toLocaleUpperCase();
  if (!normalizedTemplate.includes("_")) {
    return normalizedVariant.startsWith(normalizedTemplate)
      || variantEmbedsBaseCode(normalizedVariant, normalizedTemplate);
  }
  const templatePartPattern = (part) => escapeRegex(part)
    .replaceAll("\\.", "[-._]?")
    .replaceAll("-", "[-._]?");
  const pattern = normalizedTemplate.split("_").map(templatePartPattern).join("[\\p{L}\\p{N}._-]*");
  return new RegExp(`^${pattern}$`, "u").test(normalizedVariant);
};

const commonPrefixLength = (first, second) => {
  const length = Math.min(first.length, second.length);
  let index = 0;
  while (index < length && first[index] === second[index]) index += 1;
  return index;
};

export const buildApplicabilityVariantCodeContext = (vehicles) => {
  const records = Array.isArray(vehicles) ? vehicles : [];
  const context = new Map();

  records.forEach((vehicle) => {
    const candidate = terminalVariantCodeCandidate(textValue(vehicle?.carName));
    const concreteModelCodes = modelCodeTemplates(vehicle?.modelName).filter((code) => !code.includes("_"));
    if (!candidate.variantCodes.length && !concreteModelCodes.length) return;

    const key = normalizedVehicleFamilyIdentity(vehicle);
    const family = context.get(key) ?? { candidateCodes: [], confirmedCodes: new Set() };
    family.candidateCodes.push(...candidate.variantCodes);
    context.set(key, family);
  });

  records.forEach((vehicle) => {
    const candidate = terminalVariantCodeCandidate(textValue(vehicle?.carName));
    const templates = modelCodeTemplates(vehicle?.modelName);
    const family = context.get(normalizedVehicleFamilyIdentity(vehicle));
    if (!family) return;
    const confirmedCodes = templates.filter((template) => !template.includes("_"));
    if (candidate.variantCodes.length && templates.length
      && candidate.variantCodes.every((code) => templates.some((template) => variantMatchesTemplate(code, template)))) {
      confirmedCodes.push(...candidate.variantCodes);
    }
    confirmedCodes.forEach((code) => {
      family.confirmedCodes.add(code);
    });
  });

  return context;
};

const hasRepeatedVariantMorphology = (variantCodes, familyCodes) => {
  const distinctFamilyCodes = new Set(familyCodes);
  return distinctFamilyCodes.size >= 3 && variantCodes.every((variantCode) => (
    [...distinctFamilyCodes].some((familyCode) => familyCode !== variantCode && commonPrefixLength(variantCode, familyCode) >= 2)
  ));
};

const extractCompatibleVariantCodes = (carName, templates, familyContext) => {
  const candidate = terminalVariantCodeCandidate(carName);
  if (!candidate.variantCodes.length) return candidate;

  const matchesTemplate = templates.length > 0
    && candidate.variantCodes.every((variantCode) => templates.some((template) => variantMatchesTemplate(variantCode, template)));
  const matchesEvidence = candidate.variantCodes.every((variantCode) => familyContext?.confirmedCodes.has(variantCode));
  const matchesFamily = templates.length === 0
    && hasRepeatedVariantMorphology(candidate.variantCodes, familyContext?.candidateCodes ?? []);
  return matchesTemplate || matchesEvidence || matchesFamily ? candidate : { variantCodes: [], carName };
};

const terminalBodyDescriptor = (source, descriptor) => {
  if (!descriptor?.removableIfTerminal) return null;
  const descriptorMatch = descriptor.pattern.exec(source);
  const matchedText = descriptorMatch?.[0] ?? "";
  const start = descriptorMatch?.index ?? -1;
  if (start < 0 || source.slice(start + matchedText.length).trim()) return null;
  return { start, text: matchedText };
};

const normalizeModelIdentity = (value) => value
  .replace(/\s{2,}/g, " ")
  .trim()
  .replace(/(?<![\p{L}\p{N}])SANTA FÉ(?![\p{L}\p{N}])/giu, "SANTA FE") || "отсутствует";

const parsedModelName = (modelName) => {
  const source = modelNameWithoutParentheticalGroups(modelName);
  const descriptor = bodyAliasRegistry.find((candidate) => candidate.pattern.test(source));
  if (!descriptor) return { bodyDescriptor: null, modelIdentity: normalizeModelIdentity(source) };

  const terminalDescriptor = terminalBodyDescriptor(source, descriptor);
  const withoutDescriptor = descriptor.removeAnywhere
    ? source.replace(descriptor.pattern, "")
    : terminalDescriptor
      ? `${source.slice(0, terminalDescriptor.start)}${source.slice(terminalDescriptor.start + terminalDescriptor.text.length)}`
      : source;
  const modelIdentity = normalizeModelIdentity(withoutDescriptor);

  return modelIdentity === "отсутствует"
    ? { bodyDescriptor: null, modelIdentity: normalizeModelIdentity(source) }
    : { bodyDescriptor: descriptor, modelIdentity };
};

const bodyType = (modelName) => parsedModelName(modelName).bodyDescriptor?.bodyType ?? "отсутствует";

const modelWithoutBodyType = (modelName) => parsedModelName(modelName).modelIdentity;

const normalizedVehicleIdentity = (vehicle) => `${textValue(vehicle?.makeName).toLocaleUpperCase()}\u0000${modelWithoutBodyType(vehicle?.modelName).toLocaleUpperCase()}`;

const normalizedVehicleFamilyIdentity = (vehicle) => `${textValue(vehicle?.makeName).toLocaleUpperCase()}\u0000${modelWithoutBodyType(vehicle?.modelName)
  .replace(/\s+\b[IVXLCDM]+\b$/i, "")
  .toLocaleUpperCase()}`;

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
  if (!codes.length || terminalCodeFragment(vehicle?.modelName)) return index;
  const key = normalizedVehicleIdentity(vehicle);
  const entries = index.get(key) ?? [];
  entries.push({ codes, years: yearRange(vehicle) });
  index.set(key, entries);
  return index;
}, new Map());

const recoveredBodyCodes = (vehicle, codeIndex) => {
  const { completeCodeItems, incompleteCodeItems } = terminalCodeFragments(vehicle?.modelName);
  if (!incompleteCodeItems.length) return completeCodeItems.length ? [...new Set(completeCodeItems)] : null;
  const candidates = codeIndex.get(normalizedVehicleIdentity(vehicle))?.filter((entry) => yearsOverlap(yearRange(vehicle), entry.years)) ?? [];
  if (!candidates.length) return completeCodeItems.length ? [...new Set(completeCodeItems)] : null;

  const recoveredCodes = incompleteCodeItems.map((fragment) => {
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
  const codes = [...new Set([...completeCodeItems, ...recoveredCodes.filter(Boolean)])];
  return codes.length ? codes : null;
};

const isValidDisplacementLiters = (value) => Number.isFinite(value)
  && value >= minimumEngineDisplacementLiters
  && value <= maximumEngineDisplacementLiters;

const integerCcCandidate = (source) => {
  const match = source.match(integerCcDisplacementPattern);
  if (!match || match.index === undefined) return null;

  const cubicCentimeters = Number(match[1]);
  if (!Number.isInteger(cubicCentimeters)
    || cubicCentimeters < minimumEngineDisplacementCc
    || cubicCentimeters > maximumEngineDisplacementCc
    || !isValidDisplacementLiters(cubicCentimeters / 1000)) return null;

  return {
    cubicCentimeters,
    index: match.index,
    length: match[0].length,
    isCcAligned: cubicCentimeters % 50 === 0,
    hasEngineContext: engineContextPattern.test(source.slice(match.index + match[0].length)),
  };
};

const formatCubicCentimeters = (cubicCentimeters) => {
  const liters = cubicCentimeters / 1000;
  return Number.isInteger(liters) ? liters.toFixed(1) : String(liters);
};

const isUnambiguousIntegerCcCandidate = (candidate) => candidate.cubicCentimeters >= 1000
  && candidate.cubicCentimeters % 100 === 0;

const decimalDisplacementCandidate = (source) => {
  const match = source.match(decimalDisplacementPattern);
  if (!match || match.index === undefined) return null;

  const capacity = match[1].replace(",", ".");
  const liters = Number(capacity);
  if (!isValidDisplacementLiters(liters)) return null;
  return { capacity, cubicCentimeters: liters * 1000, index: match.index, length: match[0].length };
};

const buildDisplacementContext = (vehicles) => vehicles.reduce((context, vehicle) => {
  const source = textValue(vehicle?.carName);
  const decimalCandidate = decimalDisplacementCandidate(source);
  if (!decimalCandidate) return context;

  const key = normalizedVehicleFamilyIdentity(vehicle);
  const family = context.get(key) ?? { decimalCandidates: [] };
  family.decimalCandidates.push(decimalCandidate);
  context.set(key, family);
  return context;
}, new Map());

const familyClassifiesCcCandidate = (family, candidate) => family?.decimalCandidates.some((decimalCandidate) => (
  Math.abs(decimalCandidate.cubicCentimeters - candidate.cubicCentimeters)
    <= Math.max(300, candidate.cubicCentimeters * 0.5)
)) ?? false;

const truncatedSourceParser = (value) => {
  const source = textValue(value);
  const openingParentheses = [...source].filter((character) => character === "(").length;
  const closingParentheses = [...source].filter((character) => character === ")").length;
  const unmatchedOpeningParentheses = Math.max(openingParentheses - closingParentheses, 0);
  const sourceTruncated = /(?:\.\.\.|…)/.test(source) || unmatchedOpeningParentheses > 0;
  if (!sourceTruncated) return { source, sourceTruncated };

  let repaired = source.replace(/\.\.\./g, "…").replace(/,\s*…/g, ", …").trim();
  if (unmatchedOpeningParentheses > 0 && !repaired.endsWith("…")) {
    repaired = repaired.replace(/[\s,]+$/, "");
    repaired = `${repaired}${repaired.endsWith("(") ? "" : ","} …`;
  }
  return { source: `${repaired}${")".repeat(unmatchedOpeningParentheses)}`, sourceTruncated };
};

const displacementCandidateParser = (source, family) => {
  const decimalCandidate = decimalDisplacementCandidate(source);
  if (decimalCandidate) {
    return {
      type: "decimalLiters",
      capacity: decimalCandidate.capacity,
      index: decimalCandidate.index,
      length: decimalCandidate.length,
    };
  }

  const integerCandidate = integerCcCandidate(source);
  if (integerCandidate && (isUnambiguousIntegerCcCandidate(integerCandidate) || familyClassifiesCcCandidate(family, integerCandidate))) {
    return {
      type: "integerCc",
      capacity: formatCubicCentimeters(integerCandidate.cubicCentimeters),
      index: integerCandidate.index,
      length: integerCandidate.length,
    };
  }

  return { type: "modelBadge/unknownNumber" };
};

const consumeRepeatedLeadingDisplacement = (source, capacity) => {
  const canonicalCapacity = Number(capacity.replace(",", "."));
  let remaining = source.trimStart();
  while (true) {
    const match = remaining.match(/^(\d{1,2}[.,]\d{1,2})(?=\s|$)/);
    if (!match || Number(match[1].replace(",", ".")) !== canonicalCapacity) break;
    remaining = remaining.slice(match[0].length).trimStart();
  }
  return remaining.trim();
};

const splitCarName = (carName, family) => {
  const { source, sourceTruncated } = truncatedSourceParser(carName);
  if (source === "отсутствует") return { capacity: source, remaining: source };
  const candidate = displacementCandidateParser(source, family);
  if (candidate.type === "modelBadge/unknownNumber") {
    return { capacity: "отсутствует", remaining: source, sourceTruncated };
  }

  const remaining = consumeRepeatedLeadingDisplacement(
    `${source.slice(0, candidate.index)} ${source.slice(candidate.index + candidate.length)}`,
    candidate.capacity,
  );
  return { capacity: candidate.capacity, remaining: remaining || "отсутствует", sourceTruncated };
};

export const formatApplicabilityVehicle = (vehicle, visibleColumns, recoveredCodes = null, displacementContext = null, variantCodeContext = null, fieldSeparator = ", ") => {
  const record = vehicle && typeof vehicle === "object" && !Array.isArray(vehicle) ? vehicle : {};
  const modelName = textValue(record.modelName);
  const { capacity, remaining } = splitCarName(record.carName, displacementContext?.get(normalizedVehicleFamilyIdentity(record)));
  const model = modelWithoutBodyType(modelName);
  const modelCodes = recoveredCodes ?? bodyCodes(modelName);
  const compatibleVariantCodes = extractCompatibleVariantCodes(
    remaining,
    modelCodeTemplates(modelName),
    variantCodeContext?.get(normalizedVehicleFamilyIdentity(record)),
  );
  const refinedBodyCode = compatibleVariantCodes.variantCodes.length
    ? { bodyCode: null, carName: compatibleVariantCodes.carName }
    : extractCompatibleBodyCode(remaining, modelCodes);
  const codeVariants = compatibleVariantCodes.variantCodes.length
    ? [compatibleVariantCodes.variantCodes.join("/")]
    : refinedBodyCode.bodyCode
    ? [refinedBodyCode.bodyCode]
    : model === "SAMARA" && modelCodes.length ? modelCodes.flatMap((code) => code.split("/")) : [modelCodes.join("/") || "отсутствует"];
  const modification = canonicalizeTechnicalTokens(refinedBodyCode.carName);

  return codeVariants
    .map((code) => [
      ["bodyType", bodyType(modelName)],
      ["bodyCode", code],
      ["makeName", textValue(record.makeName)],
      ["modelName", model === "SAMARA" && code !== "отсутствует" ? code : model],
      ["years", yearPeriod(record.yearStart, record.yearEnd)],
      ["capacity", capacity],
      ["carName", modification],
    ]
      .filter(([column]) => !visibleColumns || visibleColumns.has(column))
      .map(([, value]) => value)
      .join(fieldSeparator))
    .join("\n");
};

export const formatApplicabilityVehicles = (vehicles, visibleColumns, variantCodeContext = null) => {
  const records = Array.isArray(vehicles) ? vehicles : [];
  const codeIndex = buildBodyCodeIndex(records);
  const displacementContext = buildDisplacementContext(records);
  const localVariantCodeContext = variantCodeContext ?? buildApplicabilityVariantCodeContext(records);
  return records
    .map((vehicle) => formatApplicabilityVehicle(
      vehicle,
      visibleColumns,
      recoveredBodyCodes(vehicle, codeIndex),
      displacementContext,
      localVariantCodeContext,
      applicabilityDocumentFieldSeparator,
    ))
    .join("\n");
};
