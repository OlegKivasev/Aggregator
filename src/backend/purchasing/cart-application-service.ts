import { randomUUID } from "node:crypto";
import type { NormalizedSearchResult } from "../types.ts";
import { getPurchaseReference, purchaseOfferKey, type PurchaseLine, type PurchaseReference, type TestOrder } from "./purchase-offer.ts";
import { SqliteCartRepository } from "./sqlite-cart-repository.ts";
import type { CheckoutDetails, OrderChoices, OrderGroupResult, OrderSupplier } from "./order-contract.ts";

export interface RealOrderGateway {
  choices(suppliers: OrderSupplier[], signal: AbortSignal): Promise<OrderChoices>;
  prepare(supplier: OrderSupplier, lines: PurchaseLine[], details: CheckoutDetails, signal: AbortSignal):
    Promise<(attemptId: string, signal: AbortSignal) => Promise<OrderGroupResult>>;
}

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
        && (line.reference.gid === undefined || typeof line.reference.gid === "string" && line.reference.gid.length > 0 && line.reference.gid.length <= 2000)
      || line.reference.supplier === "rossko" && nullableIdentifier(line.reference.partGuid) && nullableIdentifier(line.reference.stockId))
    && Number.isSafeInteger(line.quantity) && line.quantity >= 1 && line.quantity <= stock(line.result));
}

export class CartApplicationService {
  private readonly repository: SqliteCartRepository;
  private readonly testOrder: TestOrder;
  private readonly realOrder: RealOrderGateway | null;
  private readonly offers = new Map<string, { line: PurchaseLine; expires: number }>();
  private testing = false;
  private readonly controller = new AbortController();

  constructor(repository: SqliteCartRepository, testOrder: TestOrder, realOrder: RealOrderGateway | null = null) {
    this.repository = repository;
    this.testOrder = testOrder;
    this.realOrder = realOrder;
  }

  registerOffer(id: string, result: NormalizedSearchResult): void {
    const now = Date.now();
    for (const [key, offer] of this.offers) if (offer.expires <= now) this.offers.delete(key);
    const reference = getPurchaseReference(result);
    if (!reference || stock(result) < 1) return;
    if (reference.supplier === "forum-auto" && !reference.gid) return;
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
      total: cart.lines.reduce((sum, line) => sum + line.result.price * line.quantity, 0), testing: this.testing,
      pendingIds: this.repository.pendingLineIds() };
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
        if (this.repository.pendingLineIds().includes(existing.id)) throw new CartError("Статус заказа этой позиции нужно сверить с поставщиком.", 409);
        existing.quantity = validateQuantity(existing.quantity + quantity, stock(offer.line.result));
        existing.result = structuredClone(offer.line.result);
      } else {
        if (cart.lines.length >= 500) throw new CartError("В корзине может быть не больше 500 позиций.");
        cart.lines.push({ ...structuredClone(offer.line), id: randomUUID(), quantity });
      }
    } else {
      const index = cart.lines.findIndex((line) => line.id === payload.id);
      if (index < 0) throw new CartError("Позиция не найдена в корзине.", 404);
      if (this.repository.pendingLineIds().includes(cart.lines[index].id)) throw new CartError("Статус заказа этой позиции нужно сверить с поставщиком.", 409);
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
    const pending = new Set(this.repository.pendingLineIds());
    if (cart.lines.some((line) => pending.has(line.id) && !lines.some((kept) => kept.id === line.id))) {
      throw new CartError("Статус заказа этих позиций нужно сверить с поставщиком.", 409);
    }
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

  async orderChoices(revision: unknown, supplier: unknown, signal: AbortSignal): Promise<OrderChoices> {
    if (!this.realOrder) throw new CartError("Оформление заказов не настроено.", 503);
    const scope = normalizeCartSupplier(supplier);
    const cart = this.load();
    if (cart.revision !== revision) throw new CartError("Корзина изменилась. Обновите её.", 409);
    const lines = scope === "all" ? cart.lines : cart.lines.filter((line) => line.reference.supplier === scope);
    if (!lines.length) throw new CartError("Добавьте товары в выбранную вкладку корзины.");
    if (lines.some((line) => line.reference.supplier === "forum-auto" && !line.reference.gid)) {
      throw new CartError("Для старой позиции Forum Auto нужно повторить поиск и добавить её заново.", 409);
    }
    const pending = new Set(this.repository.pendingLineIds());
    if (lines.some((line) => pending.has(line.id))) throw new CartError("Статус предыдущего заказа нужно сверить с поставщиком.", 409);
    return this.realOrder.choices([...new Set(lines.map((line) => line.reference.supplier))], AbortSignal.any([signal, this.controller.signal]));
  }

  async order(revision: unknown, supplier: unknown, details: CheckoutDetails, signal: AbortSignal) {
    if (!this.realOrder) throw new CartError("Оформление заказов не настроено.", 503);
    if (this.testing) throw new CartError("Заказ уже оформляется.", 409);
    const scope = normalizeCartSupplier(supplier);
    const cart = this.load();
    if (revision !== cart.revision) throw new CartError("Корзина изменилась. Проверьте заказ заново.", 409);
    const lines = scope === "all" ? cart.lines : cart.lines.filter((line) => line.reference.supplier === scope);
    if (!lines.length) throw new CartError("Добавьте товары в выбранную вкладку корзины.");
    if (lines.some((line) => line.reference.supplier === "forum-auto" && !line.reference.gid)) {
      throw new CartError("Для старой позиции Forum Auto нужно повторить поиск и добавить её заново.", 409);
    }
    if (!details || typeof details !== "object" || Array.isArray(details)) throw new CartError("Неверные параметры заказа.");
    const pending = new Set(this.repository.pendingLineIds());
    if (lines.some((line) => pending.has(line.id))) throw new CartError("Статус предыдущего заказа нужно сверить с поставщиком.", 409);
    const combinedSignal = AbortSignal.any([signal, this.controller.signal]);
    this.testing = true;
    const results: Array<{ supplier: OrderSupplier; status: "confirmed" | "uncertain"; result?: OrderGroupResult; message?: string }> = [];
    try {
      const groups = [...new Set(lines.map((line) => line.reference.supplier))];
      const units: Array<{ supplier: OrderSupplier; lines: PurchaseLine[] }> = [];
      for (const group of groups) {
        const groupLines = lines.filter((line) => line.reference.supplier === group);
        if (group === "part-kom" || group === "forum-auto" || group === "rossko") {
          for (const line of groupLines) units.push({ supplier: group, lines: [line] });
        } else units.push({ supplier: group, lines: groupLines });
      }
      const prepared: Array<{ supplier: OrderSupplier; lines: PurchaseLine[];
        submit: (attemptId: string, signal: AbortSignal) => Promise<OrderGroupResult> }> = [];
      for (const unit of units) {
        prepared.push({ ...unit, submit: await this.realOrder.prepare(unit.supplier, structuredClone(unit.lines), details, combinedSignal) });
      }
      for (const { supplier: group, lines: groupLines, submit } of prepared) {
        combinedSignal.throwIfAborted();
        const attemptId = this.repository.beginOrder(group, groupLines.map((line) => line.id));
        try {
          const result = await submit(attemptId, combinedSignal);
          const covered = [...result.confirmed.map((line) => line.id), ...result.rejected.map((line) => line.id)];
          if (covered.length !== groupLines.length || new Set(covered).size !== groupLines.length
            || covered.some((id) => !groupLines.some((line) => line.id === id))
            || result.confirmed.some((item) => !Number.isSafeInteger(item.acceptedQuantity) || item.acceptedQuantity < 1
              || item.acceptedQuantity > groupLines.find((line) => line.id === item.id)!.quantity || !item.orderIds.length)) {
            throw new Error("Supplier order confirmation is inconsistent");
          }
          this.repository.finishOrder(attemptId, result.confirmed);
          results.push({ supplier: group, status: "confirmed", result });
        } catch {
          this.repository.markOrderUncertain(attemptId);
          results.push({ supplier: group, status: "uncertain", message: "Статус заказа не подтверждён. Проверьте его в кабинете поставщика перед повторной попыткой." });
          break;
        }
      }
      this.testing = false;
      return { supplier: scope, results, cart: this.view() };
    } finally { this.testing = false; }
  }

  close(): void {
    this.controller.abort(new Error("Cart closed"));
    this.offers.clear();
    this.repository.close();
  }
}
