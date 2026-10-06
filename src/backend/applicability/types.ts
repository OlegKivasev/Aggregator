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
  carName: string;
  carType: string;
  makeName: string;
  modelName: string;
  yearEnd: string;
  yearStart: string;
}
