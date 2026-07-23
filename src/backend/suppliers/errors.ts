export class SupplierAuthError extends Error {
  constructor(message = "Supplier authorization error") {
    super(message);
    this.name = "SupplierAuthError";
  }
}

export class SupplierTimeoutError extends Error {
  constructor(message = "Supplier search timed out") {
    super(message);
    this.name = "SupplierTimeoutError";
  }
}

export class SupplierIntegrationError extends Error {
  constructor(message = "Supplier integration error") {
    super(message);
    this.name = "SupplierIntegrationError";
  }
}
