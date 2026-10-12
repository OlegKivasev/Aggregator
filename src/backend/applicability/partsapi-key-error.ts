import { SupplierAuthError } from "../errors.ts";

export class PartsApiKeyError extends SupplierAuthError {
  readonly publicMessage: string;

  constructor(apiKey: string, publicMessage?: string) {
    super("PartsAPI key access is unavailable");
    const characters = [...apiKey];
    const maskedKey = characters.length > 5 ? `…${characters.slice(-5).join("")}` : "…";
    this.publicMessage = publicMessage ?? `PartsAPI отклонил запрос для ключа ${maskedKey}. Проверьте ключ и подписку.`;
  }
}

export class PartsApiIpLimitError extends PartsApiKeyError {
  constructor(apiKey: string, exhausted = false) {
    super(apiKey, exhausted ? "PartsAPI ограничил запросы по IP. Выберите другое соединение, добавьте прокси или повторите проверку позже." : undefined);
  }
}
