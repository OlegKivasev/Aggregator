export interface StockDetailLine {
  name: string;
  article: string;
  quantity: number;
}

export interface StockDetails {
  original: number;
  replacements: StockDetailLine[];
}

export function parseStockDetails(value: unknown, total: number, invalid: () => never): StockDetails {
  const fields = (input: unknown, keys: string[]) => {
    if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.keys(input).some((key) => !keys.includes(key))) invalid();
    return input as Record<string, unknown>;
  };
  const quantity = (input: unknown) => {
    if (typeof input !== "number" || !Number.isFinite(input) || input < 0 || input > 1e15) invalid();
    return input;
  };
  const label = (input: unknown, limit: number) => {
    if (typeof input !== "string" || input.length > limit || /[\u0000-\u001f\u007f-\u009f]/.test(input)) invalid();
    return input.trim();
  };
  const { original, replacements } = fields(value, ["original", "replacements"]);
  if (!Array.isArray(replacements)) invalid();
  const lines = replacements.map((input) => {
    const line = fields(input, ["name", "article", "quantity"]);
    const name = label(line.name, 500);
    if (!name) invalid();
    return { name, article: label(line.article, 100), quantity: quantity(line.quantity) };
  });
  const originalQuantity = quantity(original);
  const sum = lines.reduce((count, line) => count + line.quantity, originalQuantity);
  if (Math.abs(sum - total) > Math.max(1e-7, total * Number.EPSILON * (lines.length + 1))) invalid();
  return { original: originalQuantity, replacements: lines };
}
