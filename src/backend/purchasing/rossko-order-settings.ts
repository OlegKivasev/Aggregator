import type { RosskoOrderChoices } from "./order-contract.ts";

export interface RosskoOrderSettings {
  companyId: string;
  deliveryId: string;
  addressId: string;
  paymentId: string;
  contactName: string;
  contactPhone: string;
}

export interface RosskoOrderSettingsState {
  choices: RosskoOrderChoices;
  settings: RosskoOrderSettings | null;
  persistent: boolean;
}

export class RosskoOrderSettingsValidationError extends Error {}

export function parseRosskoOrderSettings(value: unknown): RosskoOrderSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RosskoOrderSettingsValidationError("Заполните параметры заказа Rossko.");
  }
  const fields = value as Record<string, unknown>;
  const text = (key: string, limit: number): string => {
    const raw = fields[key];
    if (typeof raw !== "string" || !raw.trim() || raw.trim().length > limit || /[\u0000-\u001f\u007f]/u.test(raw)) {
      throw new RosskoOrderSettingsValidationError("Заполните покупателя, доставку, оплату, контактное лицо и телефон Rossko.");
    }
    return raw.trim();
  };
  const settings = { companyId: text("companyId", 200), deliveryId: text("deliveryId", 200), addressId: text("addressId", 200),
    paymentId: text("paymentId", 200), contactName: text("contactName", 100), contactPhone: text("contactPhone", 40) };
  if (!/^[+\d() -]{6,40}$/.test(settings.contactPhone) || settings.contactPhone.replace(/\D/g, "").length < 6) {
    throw new RosskoOrderSettingsValidationError("Укажите корректный телефон для заказа Rossko.");
  }
  return settings;
}
