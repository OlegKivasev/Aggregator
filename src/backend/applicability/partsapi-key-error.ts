import { SupplierAuthError } from "../errors.ts";

export class PartsApiKeyError extends SupplierAuthError {
  readonly publicMessage: string;

  constructor(apiKey: string) {
    super("PartsAPI key access is unavailable");
    const characters = [...apiKey];
    const maskedKey = characters.length > 5 ? `…${characters.slice(-5).join("")}` : "…";
    this.publicMessage = `PartsAPI отклонил запрос для ключа ${maskedKey}. Проверьте ключ и подписку.`;
  }
}
