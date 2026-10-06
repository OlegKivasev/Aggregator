export interface ApplicabilitySearchQuery {
  sku: string;
  brand: string;
  apiKey: string;
}

export interface ApplicabilitySearchRequest {
  sku: string;
  brand: string;
}

export interface ApplicabilityApiKeyState {
  configured: boolean;
  persistent: boolean;
}

export interface ApplicabilityVehicle {
  carId: number;
  carName: string | null;
  carType: string | null;
  makeName: string | null;
  modelName: string | null;
  yearEnd: string | null;
  yearStart: string | null;
}
