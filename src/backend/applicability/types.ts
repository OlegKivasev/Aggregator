export interface ApplicabilitySearchQuery {
  sku: string;
  brand: string;
  apiKey: string;
}

export interface ApplicabilitySearchRequest {
  sku: string;
  brand: string;
}

export interface ApplicabilitySearchResult {
  results: ApplicabilityVehicle[];
  cacheHit: boolean;
}

export interface ApplicabilitySavedArticle {
  sku: string;
  brand: string;
}

export interface ApplicabilitySavedArticlesQuery {
  search: string;
  offset: number;
  order: "brand" | "sku";
  includeNotFound: boolean;
}

export interface ApplicabilitySavedArticlesPage {
  articles: ApplicabilitySavedArticle[];
  hasMore: boolean;
}

export interface ApplicabilityApiKeyState {
  configured: boolean;
  fallbackKeyCount: number;
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
