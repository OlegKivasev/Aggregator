const bodyTypePatterns = [
  ["SUV/Внедорожник", /автофургон\s*\/\s*спортивно-утилитарный\s+автомобиль/i],
  ["С бортовой платформой/ходовая часть", /с\s+бортовой\s+платформой\s*\/\s*ходовая\s+часть|platform\/chassis/i],
  ["Фургон/универсал", /фургон\s*\/\s*универсал/i],
  ["Автофургон / микроавтобус", /автофургон\s*\/\s*микроавтобус|\bvan\b/i],
  ["Фургон/хэтчбэк", /фургон\s*\/\s*хетчбэк|фургон\s*\/\s*хэтчбэк/i],
  ["Автобус", /\bbus\b|автобус/i],
  ["Фургон", /фургон/i],
  ["Пикап", /пикап|pick[ -]?up/i],
  ["SUV/Внедорожник", /спортивно-утилитарный|\bsuv\b|\b4x4\b|off[ -]?road/i],
  ["Седан", /седан|\bsaloon\b/i],
  ["Универсал", /универсал|station wagon|\bestate\b|\btourer\b|\bturnier\b/i],
  ["Хэтчбэк", /хэтчбэк|хетчбэк|\bhatchback\b/i],
  ["Лифтбэк", /лифтбэк|\bliftback\b/i],
  ["Купе", /купе|\bcoup[eé]\b/i],
  ["Кабриолет", /кабриолет|\bconvertible\b|\bcabrio\b/i],
  ["Тарга", /тарга|\btarga\b/i],
  ["Родстер", /родстер|\broadster\b/i],
  ["Вэн", /вэн|\bmpv\b|minivan|active tourer|gran tourer|picasso/i],
];

const textValue = (value) => typeof value === "string" && value.trim() ? value.trim() : "отсутствует";

const yearValue = (value, fallback = "отсутствует") => {
  const source = typeof value === "string" && value.trim() ? value.trim() : fallback;
  const match = source.match(/\d{4}/);
  return match?.[0] ?? source;
};

const bodyTypeMatch = (modelName) => {
  const source = textValue(modelName);
  return bodyTypePatterns.find(([, pattern]) => pattern.test(source));
};

const bodyType = (modelName) => bodyTypeMatch(modelName)?.[0] ?? "отсутствует";

const bodyCodes = (modelName) => {
  const source = textValue(modelName);
  if (source === "отсутствует") return [];

  return [...source.matchAll(/\(([^()]*)\)/g)]
    .flatMap((match) => match[1].split(/[\/,;|]+/))
    .map((code) => code.replaceAll("_", "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
};

const bodyCode = (modelName) => [...new Set(bodyCodes(modelName))].join("/") || "отсутствует";

const modelWithoutBodyType = (modelName) => {
  const source = textValue(modelName);
  const match = bodyTypeMatch(source);
  const model = source
    .replace(/\s*\([^()]*\)/g, "")
    .replace(match?.[1] ?? /$^/, "")
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
