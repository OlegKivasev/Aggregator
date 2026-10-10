import { SupplierAuthError } from "../errors.ts";

export class PartsApiKeyError extends SupplierAuthError {
  readonly publicMessage: string;
  readonly limitExceeded: boolean;

  constructor(apiKey: string | null, limitExceeded: boolean) {
    super(limitExceeded ? "PartsAPI request limit exceeded" : "PartsAPI key access is unavailable");
    const characters = [...(apiKey ?? "")];
    const maskedKey = characters.length > 5 ? `…${characters.slice(-5).join("")}` : "…";
    this.limitExceeded = limitExceeded;
    this.publicMessage = apiKey === null
      ? "Лимиты всех сохранённых ключей PartsAPI исчерпаны. Повторите поиск после сброса лимитов."
      : limitExceeded
      ? `Закончились лимиты у ключа PartsAPI ${maskedKey}.`
      : `Лимиты исчерпаны или доступ к ключу PartsAPI ${maskedKey} закрыт.`;
  }
}
