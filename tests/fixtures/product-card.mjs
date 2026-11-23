export function productCardFixture(product, overrides = {}) {
  return {
    name: product.name, article: product.article, brand: "Тестовый бренд", category: "Запчасти", unit: "шт",
    image: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aU8kAAAAASUVORK5CYII=",
    stock: 3, stockDetails: { original: 0, replacements: [
      { name: "Замена в наличии", article: "A-7", quantity: 3 },
      { name: "Без остатка", article: "A-8", quantity: 0 },
    ] },
    incoming: { original: 0, replacement: 2 },
    monthlySales: [{ month: "2026-11", quantity: 3 }, { month: "2026-10", quantity: 7 }],
    average: 2, recommendation: 1, period: { from: "2026-11-01", to: "2026-11-18" },
    prices: [
      { name: "Розничная цена", characteristic: "", unit: "шт", currency: "RUB", amount: 2150, primary: true },
      { name: "Цена комплекта", characteristic: "Комплект", unit: "шт", currency: "RUB", amount: 7200, primary: false },
    ],
    oem: [{ article: "OEM-123", make: "Toyota" }],
    applicability: [{ make: "Toyota", model: "Corolla", from: "2006", to: "2010", body: "Седан", bodyCode: "E150", engine: "1.6", engineCode: "1ZR-FE", note: "" }],
    replacements: [], ...overrides,
  };
}
