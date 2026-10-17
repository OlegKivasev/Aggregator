const defaultPercent = 35;
export const maximumMarkupTiers = 30;
const isPercent = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1000;

export const validateMarkupSettings = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !["none", "fixed", "tiered"].includes(value.mode) || !isPercent(value.percent)
    || !isPercent(value.fallbackPercent) || !["both", "retail"].includes(value.display)
    || typeof value.showPurchaseInCart !== "boolean" || !Array.isArray(value.tiers)
    || value.tiers.length > maximumMarkupTiers) throw new Error("Проверьте настройки наценки.");
  const tiers = value.tiers.map((tier) => {
    if (!tier || typeof tier !== "object" || typeof tier.upTo !== "number"
      || !Number.isFinite(tier.upTo) || tier.upTo <= 0 || !isPercent(tier.percent)) {
      throw new Error("Укажите положительную цену и наценку от 0 до 1000% для каждой ступени.");
    }
    return { upTo: tier.upTo, percent: tier.percent };
  }).sort((left, right) => left.upTo - right.upTo);
  if (tiers.some((tier, index) => index > 0 && tier.upTo === tiers[index - 1].upTo)) {
    throw new Error("Предельные цены ступеней должны различаться.");
  }
  return { mode: value.mode, percent: value.percent, tiers, fallbackPercent: value.fallbackPercent,
    display: value.display, showPurchaseInCart: value.showPurchaseInCart };
};

export const restoreMarkupSettings = (value, legacyPercent) => {
  try { return validateMarkupSettings(value); }
  catch {
    // Invalid or legacy local preferences fall back to the former fixed markup.
    const parsed = typeof legacyPercent === "number" || typeof legacyPercent === "string" ? Number(legacyPercent) : NaN;
    const percent = Number.isFinite(parsed) ? Math.min(1000, Math.max(0, parsed)) : defaultPercent;
    return { mode: "fixed", percent, tiers: [], fallbackPercent: percent, display: "both", showPurchaseInCart: true };
  }
};

export const markupPercentForPrice = (price, settings) => settings.mode === "none" ? 0
  : settings.mode === "fixed" ? settings.percent
    : settings.tiers.find((tier) => price <= tier.upTo)?.percent ?? settings.fallbackPercent;

export const calculateMarkupPrice = (price, settings) => {
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) return null;
  const markedUp = price * (1 + markupPercentForPrice(price, settings) / 100);
  return Number.isFinite(markedUp) ? markedUp : null;
};

export const showPurchasePrice = (settings, inCart = false) => settings.mode !== "none" && settings.display === "both"
  && (!inCart || settings.showPurchaseInCart);
