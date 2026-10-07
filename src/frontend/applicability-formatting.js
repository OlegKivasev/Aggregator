const combinedVanAndSuvPattern = /автофургон\s*\/\s*спортивно-утилитарный\s+автомобиль/i;
const engineDisplacementPattern = /(?:^|\s)(\d{1,2}[.,]\d{1,2})(?=\s|$)/;
const minimumEngineDisplacementLiters = 0.5;
const maximumEngineDisplacementLiters = 10;
const technicalTokenCanonicalizations = [
  [/\bt-gdi\b/gi, "T-GDI"],
  [/\bcrdi\b/gi, "CRDi"],
  [/\bmpi\b/gi, "MPI"],
  [/\bgdi\b/gi, "GDI"],
  [/\bhybrid\b/gi, "Hybrid"],
];

const bodyDescriptors = [
  { bodyType: "SUV/Внедорожник", pattern: combinedVanAndSuvPattern, removableIfTerminal: false, removeAnywhere: true },
  { bodyType: "С бортовой платформой/ходовая часть", pattern: /с\s+бортовой\s+платформой\s*\/\s*ходовая\s+часть|platform\/chassis/i, removableIfTerminal: true },
  { bodyType: "Фургон/универсал", pattern: /фургон\s*\/\s*универсал/i, removableIfTerminal: true },
  { bodyType: "Автофургон / микроавтобус", bodySubtype: "Hatchback", pattern: /\bhatchback\s+van\b/i, removableIfTerminal: true },
  { bodyType: "Автофургон / микроавтобус", bodySubtype: "Combi", pattern: /\bcombi\s+van\b/i, removableIfTerminal: true },
  { bodyType: "Автофургон / микроавтобус", bodySubtype: "Kombi", pattern: /\bkombi\s+van\b/i, removableIfTerminal: true },
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
const bodySubtype = (modelName) => bodyDescriptor(modelName)?.bodySubtype ?? "отсутствует";

const bodyCodes = (modelName) => {
  const source = textValue(modelName);
  if (source === "отсутствует") return [];

  return [...source.matchAll(/\(([^()]*)\)/g)]
    .flatMap((match) => match[1].split(/[\/,;|]+/))
    .map((code) => code.replaceAll("_", "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
};

const bodyCode = (modelName) => [...new Set(bodyCodes(modelName))].join("/") || "отсутствует";

const canonicalizeTechnicalTokens = (value) => technicalTokenCanonicalizations
  .reduce((normalized, [pattern, canonical]) => normalized.replace(pattern, canonical), value);

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
  const withoutCodes = source.replace(/\s*\([^()]*\)/g, "");
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
  return model || "отсутствует";
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

export const formatApplicabilityVehicle = (vehicle, visibleColumns) => {
  const record = vehicle && typeof vehicle === "object" && !Array.isArray(vehicle) ? vehicle : {};
  const modelName = textValue(record.modelName);
  const { capacity, remaining } = splitCarName(record.carName);
  const model = modelWithoutBodyType(modelName);
  const codes = bodyCodes(modelName);
  const refinedBodyCode = extractCompatibleBodyCode(remaining, codes);
  const codeVariants = refinedBodyCode.bodyCode
    ? [refinedBodyCode.bodyCode]
    : model === "SAMARA" && codes.length ? codes : [bodyCode(modelName)];
  const modification = canonicalizeTechnicalTokens(refinedBodyCode.carName);

  return codeVariants
    .map((code) => [
      ["bodyType", bodyType(modelName)],
      ["bodySubtype", bodySubtype(modelName)],
      ["bodyCode", code],
      ["makeName", textValue(record.makeName)],
      ["modelName", model === "SAMARA" && code !== "отсутствует" ? code : model],
      ["years", yearPeriod(record.yearStart, record.yearEnd)],
      ["capacity", capacity],
      ["carName", modification],
    ]
      .filter(([column]) => !visibleColumns || visibleColumns.has(column))
      .map(([, value]) => value)
      .join(", "))
    .join("\n");
};
