import { randomUUID } from "node:crypto";
import type { NormalizedSearchResult } from "../types.ts";
import { getPurchaseReference, purchaseOfferKey, type PurchaseLine, type PurchaseReference, type TestOrder } from "./purchase-offer.ts";
import { SqliteCartRepository } from "./sqlite-cart-repository.ts";

export class CartError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 400) { super(message); this.statusCode = statusCode; }
}

const stock = (result: NormalizedSearchResult): number => typeof result.quantity === "number" && Number.isFinite(result.quantity)
  ? Math.min(1_000_000, Math.floor(result.quantity)) : 0;

function validateQuantity(value: unknown, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new CartError(`Количество должно быть от 1 до ${Math.max(0, maximum)}.`);
  }
  return value;
}

function normalizeCartSupplier(value: unknown): "all" | PurchaseReference["supplier"] {
  if (value !== "all" && value !== "armtek" && value !== "part-kom" && value !== "forum-auto" && value !== "rossko") {
    throw new CartError("Выберите вкладку корзины.");
  }
  return value;
}

const nullableIdentifier = (value: unknown): boolean => value === null
  || typeof value === "string" && value.length > 0 && value.length <= 2000;

function validLine(line: PurchaseLine): boolean {
  return Boolean(line && typeof line.id === "string" && /^[0-9a-f-]{36}$/.test(line.id)
    && line.result && typeof line.result.article === "string" && typeof line.result.brand === "string"
    && line.result.article.length > 0 && line.result.article.length <= 128 && line.result.brand.length > 0 && line.result.brand.length <= 128
    && typeof line.result.title === "string" && Number.isFinite(line.result.price) && line.result.price > 0
    && line.result.title.length <= 4000 && (line.result.warehouse === null || typeof line.result.warehouse === "string" && line.result.warehouse.length <= 2000)
    && Number.isFinite(line.result.price * stock(line.result))
    && line.reference && line.reference.supplier === line.result.supplier
    && (line.reference.supplier === "armtek" && typeof line.reference.keyzak === "string" && /^[\w-]{1,10}$/.test(line.reference.keyzak)
      || line.reference.supplier === "part-kom" && typeof line.reference.makerId === "string" && typeof line.reference.providerId === "string"
        && /^[1-9]\d{0,19}$/.test(line.reference.makerId) && /^[1-9]\d{0,19}$/.test(line.reference.providerId)
      || line.reference.supplier === "forum-auto" && nullableIdentifier(line.reference.warehouse) && line.reference.warehouse === line.result.warehouse
      || line.reference.supplier === "rossko" && nullableIdentifier(line.reference.partGuid) && nullableIdentifier(line.reference.stockId))
    && Number.isSafeInteger(line.quantity) && line.quantity >= 1 && line.quantity <= stock(line.result));
}

export class CartApplicationService {
  private readonly repository: SqliteCartRepository;
  private readonly testOrder: TestOrder;
  private readonly offers = new Map<string, { line: PurchaseLine; expires: number }>();
  private testing = false;
  private readonly controller = new AbortController();

  constructor(repository: SqliteCartRepository, testOrder: TestOrder) {
    this.repository = repository;
    this.testOrder = testOrder;
  }

  registerOffer(id: string, result: NormalizedSearchResult): void {
    const now = Date.now();
    for (const [key, offer] of this.offers) if (offer.expires <= now) this.offers.delete(key);
    const reference = getPurchaseReference(result);
    if (!reference || stock(result) < 1) return;
    const line = { id, result, reference, quantity: 1 };
    if (!validLine(line)) return;
    if (this.offers.size >= 10_000) this.offers.delete(this.offers.keys().next().value!);
    this.offers.set(id, { line: structuredClone(line), expires: now + 5 * 60_000 });
  }

  private load() {
    const cart = this.repository.load();
    if (cart.lines.length > 500 || !cart.lines.every(validLine)) throw new CartError("Корзина содержит повреждённые данные. Обратитесь к администратору.", 500);
    return cart;
  }

  view() {
    const cart = this.load();
    return { revision: cart.revision, items: cart.lines.map(({ id, result, quantity }) => ({ id, result, quantity })),
      count: cart.lines.reduce((sum, line) => sum + line.quantity, 0),
      total: cart.lines.reduce((sum, line) => sum + line.result.price * line.quantity, 0), testing: this.testing };
  }

  mutate(action: "add" | "update" | "remove", payload: Record<string, unknown>) {
    if (this.testing) throw new CartError("Дождитесь завершения проверки заказа.", 409);
    const cart = this.load();
    if (payload.revision !== cart.revision) throw new CartError("Корзина изменилась. Обновите её и повторите действие.", 409);
    if (action === "add") {
      const offer = typeof payload.offerId === "string" ? this.offers.get(payload.offerId) : undefined;
      if (!offer || offer.expires <= Date.now()) throw new CartError("Предложение устарело или не поддерживает заказ. Повторите поиск.", 409);
      const existing = cart.lines.find((line) => purchaseOfferKey(line.result, line.reference) === purchaseOfferKey(offer.line.result, offer.line.reference));
      const quantity = validateQuantity(payload.quantity, stock(offer.line.result));
      if (existing) {
        existing.quantity = validateQuantity(existing.quantity + quantity, stock(offer.line.result));
        existing.result = structuredClone(offer.line.result);
      } else {
        if (cart.lines.length >= 500) throw new CartError("В корзине может быть не больше 500 позиций.");
        cart.lines.push({ ...structuredClone(offer.line), id: randomUUID(), quantity });
      }
    } else {
      const index = cart.lines.findIndex((line) => line.id === payload.id);
      if (index < 0) throw new CartError("Позиция не найдена в корзине.", 404);
      if (action === "remove") cart.lines.splice(index, 1);
      else cart.lines[index].quantity = validateQuantity(payload.quantity, stock(cart.lines[index].result));
    }
    if (!this.repository.save({ ...cart, revision: cart.revision + 1 }, cart.revision)) throw new CartError("Корзина изменилась. Повторите действие.", 409);
    return this.view();
  }

  clear(supplier: unknown, revision: unknown) {
    if (this.testing) throw new CartError("Дождитесь завершения проверки заказа.", 409);
    const scope = normalizeCartSupplier(supplier);
    const cart = this.load();
    if (revision !== cart.revision) throw new CartError("Корзина изменилась. Обновите её и повторите действие.", 409);
    const lines = scope === "all" ? [] : cart.lines.filter((line) => line.reference.supplier !== scope);
    if (lines.length === cart.lines.length) return this.view();
    if (!this.repository.save({ lines, revision: cart.revision + 1 }, cart.revision)) throw new CartError("Корзина изменилась. Повторите действие.", 409);
    return this.view();
  }

  async test(revision: unknown, signal: AbortSignal, supplier: unknown = "all") {
    if (this.testing) throw new CartError("Заказ уже проверяется.", 409);
    const scope = normalizeCartSupplier(supplier);
    const cart = this.load();
    if (revision !== cart.revision) throw new CartError("Корзина изменилась. Обновите её перед проверкой.", 409);
    const lines = scope === "all" ? cart.lines : cart.lines.filter((line) => line.reference.supplier === scope);
    if (!lines.length) throw new CartError("Добавьте товары в выбранную вкладку корзины.");
    this.testing = true;
    try {
      const combinedSignal = AbortSignal.any([signal, this.controller.signal]);
      combinedSignal.throwIfAborted();
      const results = await this.testOrder(structuredClone(lines), combinedSignal);
      combinedSignal.throwIfAborted();
      return { testOnly: true, revision: cart.revision, supplier: scope, results };
    } finally { this.testing = false; }
  }

  close(): void {
    this.controller.abort(new Error("Cart closed"));
    this.offers.clear();
    this.repository.close();
  }
}
