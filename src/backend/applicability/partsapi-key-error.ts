import { SupplierAuthError } from "../errors.ts";

export class PartsApiKeyError extends SupplierAuthError {
  readonly publicMessage: string;

  constructor(apiKey: string, limitExceeded: boolean, httpStatus: number, detail: string) {
    super(limitExceeded ? "PartsAPI request limit exceeded" : "PartsAPI key access is unavailable");
    const characters = [...apiKey];
    const maskedKey = characters.length > 5 ? `…${characters.slice(-5).join("")}` : "…";
    const message = limitExceeded
      ? `Закончились лимиты у ключа PartsAPI ${maskedKey}.`
      : `Лимиты исчерпаны или доступ к ключу PartsAPI ${maskedKey} закрыт.`;
    // Temporary diagnostic requested by the project owner.
    this.publicMessage = `${message} Ошибка PartsAPI (HTTP ${httpStatus}): ${detail}`;
  }
}
