export class SupplierAuthError extends Error {
  readonly publicMessage: string | null;
  readonly diagnosticCode: string | null;

  constructor(message = "Supplier authorization error", options?: ErrorOptions & { publicMessage?: string; diagnosticCode?: string }) {
    super(message, options);
    this.name = "SupplierAuthError";
    this.publicMessage = options?.publicMessage ?? null;
    this.diagnosticCode = options?.diagnosticCode ?? null;
  }
}

export class SupplierTimeoutError extends Error {
  readonly publicMessage: string | null;
  readonly diagnosticCode: string | null;

  constructor(message = "Supplier search timed out", options?: ErrorOptions & { publicMessage?: string; diagnosticCode?: string }) {
    super(message, options);
    this.name = "SupplierTimeoutError";
    this.publicMessage = options?.publicMessage ?? null;
    this.diagnosticCode = options?.diagnosticCode ?? null;
  }
}

export class SupplierIntegrationError extends Error {
  readonly publicMessage: string | null;
  readonly diagnosticCode: string | null;

  constructor(message = "Supplier integration error", options?: ErrorOptions & { publicMessage?: string; diagnosticCode?: string }) {
    super(message, options);
    this.name = "SupplierIntegrationError";
    this.publicMessage = options?.publicMessage ?? null;
    this.diagnosticCode = options?.diagnosticCode ?? null;
  }
}

export class SupplierSessionInvalidatedError extends Error {
  constructor(message = "Supplier session was invalidated") {
    super(message);
    this.name = "SupplierSessionInvalidatedError";
  }
}

export type OperationalErrorCategory = "authorization" | "timeout" | "integration" | "internal";

export function classifyOperationalError(error: unknown): OperationalErrorCategory {
  if (error instanceof SupplierAuthError) {
    return "authorization";
  }
  if (error instanceof SupplierTimeoutError) {
    return "timeout";
  }
  if (error instanceof SupplierIntegrationError) {
    return "integration";
  }
  return "internal";
}
