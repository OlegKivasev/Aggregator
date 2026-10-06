export interface ApplicabilitySearchQuery {
  sku: string;
  apiKey: string;
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
