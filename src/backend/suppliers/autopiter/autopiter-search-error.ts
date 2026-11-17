import { SupplierAuthError, SupplierIntegrationError, SupplierSessionInvalidatedError, SupplierTimeoutError } from "../errors.ts";

const offerFieldReasons = {
  Number: "не указан артикул",
  CatalogName: "не указан производитель",
  Name: "не указано наименование",
  SalePrice: "некорректная цена",
  TypeRefusal: "некорректные условия возврата",
  NumberOfAvailable: "некорректное количество",
  CurrencyName: "неподдерживаемая валюта",
};

export function autopiterOfferError(field: keyof typeof offerFieldReasons): SupplierIntegrationError {
  return new SupplierIntegrationError(`Autopiter offer has invalid field ${field}`);
}

const responseReasons = new Map<string, { code: string; label: string }>([
  ...Object.entries(offerFieldReasons).map(([field, label]) => [
    `Autopiter offer has invalid field ${field}`, { code: `offer_${field}`, label },
  ] as const),
  ["Autopiter returned an unexpected content type", { code: "content_type", label: "получен ответ неподдерживаемого типа" }],
  ["Autopiter returned an invalid SOAP envelope", { code: "envelope", label: "некорректная структура ответа" }],
  ["Autopiter returned a SOAP fault", { code: "soap_fault", label: "сервис поставщика вернул ошибку" }],
  ["Autopiter request failed", { code: "http_status", label: "сервер поставщика отклонил запрос" }],
  ["Autopiter did not return a method result", { code: "method_result", label: "в ответе нет результата запроса" }],
  ["Autopiter returned an invalid result list", { code: "result_list", label: "некорректный список результатов" }],
  ["Autopiter returned an invalid catalog", { code: "catalog", label: "некорректные данные каталога" }],
  ["Autopiter returned an invalid authorization flag", { code: "authorization_flag", label: "некорректный ответ проверки подключения" }],
  ["Autopiter did not establish an authorization cookie", { code: "session_cookie", label: "поставщик не создал сессию" }],
  ["Autopiter returned an invalid cookie", { code: "cookie", label: "некорректные данные сессии" }],
  ["Autopiter returned too many cookies", { code: "cookie_limit", label: "превышен допустимый размер данных сессии" }],
  ["Supplier SOAP API returned malformed XML", { code: "xml", label: "повреждённый XML в ответе" }],
  ["Supplier SOAP API returned unsupported XML declarations", { code: "xml_declarations", label: "недопустимые объявления XML в ответе" }],
  ["Supplier response is too large", { code: "response_size", label: "ответ превысил допустимый размер" }],
  ["Supplier response was interrupted", { code: "interrupted", label: "загрузка ответа прервалась" }],
]);
const networkErrors = new Set(["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "ETIMEDOUT", "ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"]);

export function autopiterSearchError(error: unknown, progress?: { index: number; total: number }): Error {
  if (error instanceof SupplierAuthError || error instanceof SupplierTimeoutError || error instanceof SupplierSessionInvalidatedError) return error;
  // Only local, allowlisted descriptions reach SSE. Never forward fault text, values, cookies or arbitrary error messages.
  const networkError = error instanceof Error && "code" in error && typeof error.code === "string" && networkErrors.has(error.code);
  const reason = error instanceof SupplierIntegrationError && responseReasons.get(error.message)
    || (networkError ? { code: "connection", label: "ошибка соединения с поставщиком" }
      : { code: "unknown", label: "не удалось завершить обработку ответа" });
  const stage = progress ? `Ошибка получения цен (каталог ${progress.index} из ${progress.total})` : "Ошибка получения списка производителей";
  return new SupplierIntegrationError("Autopiter search failed", {
    cause: error,
    publicMessage: `${stage}: ${reason.label}.`,
    diagnosticCode: `autopiter_${progress ? "prices" : "catalogs"}_${reason.code}`,
  });
}
