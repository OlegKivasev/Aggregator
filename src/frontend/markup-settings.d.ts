export interface MarkupRules {
  mode: "none" | "fixed" | "tiered";
  percent: number;
  tiers: { upTo: number; percent: number }[];
  fallbackPercent: number;
}

export function validateMarkupRules(value: unknown): MarkupRules;
