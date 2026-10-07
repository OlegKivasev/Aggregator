const combinedVanAndSuvPattern = /автофургон\s*\/\s*спортивно-утилитарный\s+автомобиль/i;

const bodyDescriptors = [
  { bodyType: "SUV/Внедорожник", pattern: combinedVanAndSuvPattern, removableIfTerminal: false, removeAnywhere: true },
  { bodyType: "С бортовой платформой/ходовая часть", pattern: /с\s+бортовой\s+платформой\s*\/\s*ходовая\s+часть|platform\/chassis/i, removableIfTerminal: true },
  { bodyType: "Фургон/универсал", pattern: /фургон\s*\/\s*универсал/i, removableIfTerminal: true },
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
  { bodyType: "Купе", pattern: /купе|\bcoup[eé]\b/i, removableIfTerminal: true },
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
  const match = source.match(/(?:^|\s)(\d{1,2}(?:[.,]\d{1,2})?)(?=\s|$)/);
  if (!match || match.index === undefined) return { capacity: "отсутствует", remaining: source };
  const capacity = match[1].replace(",", ".");
  const remaining = `${source.slice(0, match.index)} ${source.slice(match.index + match[0].length)}`.trim();
  return { capacity, remaining: remaining || "отсутствует" };
};

export const formatApplicabilityVehicle = (vehicle, visibleColumns) => {
  const record = vehicle && typeof vehicle === "object" && !Array.isArray(vehicle) ? vehicle : {};
  const modelName = textValue(record.modelName);
  const { capacity, remaining } = splitCarName(record.carName);
  const model = modelWithoutBodyType(modelName);
  const codes = bodyCodes(modelName);
  const codeVariants = model === "SAMARA" && codes.length ? codes : [bodyCode(modelName)];

  return codeVariants
    .map((code) => [
      ["bodyType", bodyType(modelName)],
      ["bodyCode", code],
      ["makeName", textValue(record.makeName)],
      ["modelName", model === "SAMARA" && code !== "отсутствует" ? code : model],
      ["years", `${yearValue(record.yearStart)}-${yearValue(record.yearEnd, "н.в.")}`],
      ["capacity", capacity],
      ["carName", remaining],
    ]
      .filter(([column]) => !visibleColumns || visibleColumns.has(column))
      .map(([, value]) => value)
      .join(", "))
    .join("\n");
};
