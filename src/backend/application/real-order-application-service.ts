import { CartError, type CartRefreshIssue, type RealOrderGateway, type RefreshedPurchaseLine } from "../purchasing/cart-application-service.ts";
import type { CheckoutDetails, OrderChoices, OrderSupplier, RosskoOrderChoices } from "../purchasing/order-contract.ts";
import { getPurchaseReference, type PurchaseLine, type PurchaseReference } from "../purchasing/purchase-offer.ts";
import type { SupplierSessionManager } from "../session/session-manager.ts";
import type { SearchStreamEvent, SupplierSearchQuery } from "../types.ts";
import { SupplierAuthError, SupplierIntegrationError, SupplierTimeoutError } from "../suppliers/errors.ts";
import { listArmtekOrderHistory, placeArmtekOrder } from "../suppliers/armtek/armtek-order.ts";
import { resolveArmtekConfig } from "../suppliers/armtek/armtek-api-adapter.ts";
import { listForumAutoOrderHistory, placeForumAutoOrder, verifyForumAutoCredentials } from "../suppliers/forum-auto/forum-auto-api-adapter.ts";
import { getPartKomOrderChoices, listPartKomOrderHistory, placePartKomOrder } from "../suppliers/part-kom/part-kom-order.ts";
import { getRosskoOrderChoices, listRosskoOrderHistory, placeRosskoOrder } from "../suppliers/rossko/rossko-api-adapter.ts";
import type { OrderHistory, SupplierOrderHistoryQuery } from "../purchasing/order-history-contract.ts";
import { createBoundedAbortSignal } from "../abort.ts";
import { additionalArticleVariants } from "../article-search-variants.ts";
import type { SupplierCredentialRepository, StoredSupplierCredentials } from "../session/encrypted-credential-store.ts";
import { decodeRosskoApiCredentials } from "./supplier-session-service.ts";
import { parseRosskoOrderSettings, RosskoOrderSettingsValidationError, type RosskoOrderSettings, type RosskoOrderSettingsState } from "../purchasing/rossko-order-settings.ts";
import type { RosskoApiCredentials } from "../types.ts";

const validPhone = (value: unknown): value is string => typeof value === "string" && /^[+\d()\s-]{6,40}$/.test(value);
const sameText = (left: string, right: string): boolean => left.trim().toLocaleUpperCase() === right.trim().toLocaleUpperCase();
const articleKey = (article: string): string => article.replace(/[^\p{L}\p{N}]/gu, "").toLocaleUpperCase();
const sameArticle = (left: string, right: string): boolean => [left, ...additionalArticleVariants(left).map((variant) => variant.article)]
  .some((article) => articleKey(article) === articleKey(right));
const supplierNames: Record<OrderSupplier, string> = { armtek: "Armtek", "part-kom": "PartKOM", "forum-auto": "Forum Auto", rossko: "Rossko" };

export function allowedRosskoOrderChoices(options: RosskoOrderChoices): RosskoOrderChoices {
  const deliveries = options.deliveries.filter((item) => item.addressId !== null);
  const payments = options.payments.filter((item) => /безнал|банковск\S*\s+(?:плат[её]ж|перевод)|через\s+банк|перечислен|расч[её]тн\S*\s+сч[её]т/i.test(item.label)
    && !/(?:^|[^\p{L}])наличн|карт|эквайр|онлайн/iu.test(item.label));
  if (!deliveries.length) throw new SupplierIntegrationError("Rossko has no delivery address", {
    publicMessage: "Rossko не предложил доставку по адресу. Заказ не отправлен.",
  });
  if (!payments.length) throw new SupplierIntegrationError("Rossko has no bank transfer payment", {
    publicMessage: "Rossko не предложил оплату банковским переводом. Заказ не отправлен.",
  });
  return { ...options, deliveries, payments };
}

interface RosskoOrderConfiguration {
  buyerName?: string;
  contactName?: string;
  contactPhone?: string;
  deliveryAddressId?: string;
}

export function resolveRosskoOrderDefaults(options: RosskoOrderChoices, config: RosskoOrderConfiguration): NonNullable<CheckoutDetails["rossko"]> {
  const buyerName = config.buyerName?.trim();
  const name = config.contactName?.trim();
  const phone = config.contactPhone?.trim();
  if (!buyerName || !name || name.length > 100 || !validPhone(phone)) {
    throw new CartError("Настройте покупателя, контактное лицо и телефон для заказа Rossko.", 503);
  }
  const allowed = allowedRosskoOrderChoices(options);
  const companies = allowed.companies.filter((item) => sameText(item.label, buyerName));
  if (companies.length !== 1) throw new SupplierIntegrationError("Rossko buyer is missing or ambiguous", {
    publicMessage: "Rossko не подтвердил заданного покупателя. Заказ не отправлен.",
  });
  const payments = allowed.payments.filter((item) => /через\s+банк/iu.test(item.label));
  const bankPayments = payments.length ? payments : allowed.payments;
  if (bankPayments.length !== 1) throw new SupplierIntegrationError("Rossko bank payment is ambiguous", {
    publicMessage: "Rossko предложил несколько вариантов оплаты через банк. Заказ не отправлен.",
  });
  const deliveries = config.deliveryAddressId
    ? allowed.deliveries.filter((item) => item.addressId === config.deliveryAddressId)
    : allowed.deliveries;
  if (deliveries.length !== 1) throw new SupplierIntegrationError("Rossko delivery address is ambiguous", {
    publicMessage: "Rossko предложил несколько адресов доставки. Укажите адрес для заказа.",
  });
  return { deliveryId: deliveries[0].id, addressId: deliveries[0].addressId, paymentId: bankPayments[0].id,
    companyId: companies[0].id, name, phone, deliveryParts: false };
}

function configuredRosskoOrderDefaults(options: RosskoOrderChoices): NonNullable<CheckoutDetails["rossko"]> {
  return resolveRosskoOrderDefaults(options, {
    buyerName: process.env.ROSSKO_ORDER_BUYER_NAME,
    contactName: process.env.ROSSKO_ORDER_CONTACT_NAME,
    contactPhone: process.env.ROSSKO_ORDER_CONTACT_PHONE,
    deliveryAddressId: process.env.ROSSKO_ORDER_DELIVERY_ADDRESS_ID,
  });
}

function selectedRosskoOrderDetails(options: RosskoOrderChoices, settings: RosskoOrderSettings): NonNullable<CheckoutDetails["rossko"]> {
  const allowed = allowedRosskoOrderChoices(options);
  if (!allowed.companies.some((item) => item.id === settings.companyId)
    || !allowed.deliveries.some((item) => item.id === settings.deliveryId && item.addressId === settings.addressId)
    || !allowed.payments.some((item) => item.id === settings.paymentId)) {
    throw new RosskoOrderSettingsValidationError("Rossko больше не подтверждает выбранного покупателя, адрес или оплату. Обновите настройки Rossko.");
  }
  return { deliveryId: settings.deliveryId, addressId: settings.addressId, paymentId: settings.paymentId,
    companyId: settings.companyId, name: settings.contactName, phone: settings.contactPhone, deliveryParts: false };
}

function sameOffer(current: PurchaseLine, fresh: { result: PurchaseLine["result"]; reference: PurchaseReference }): boolean {
  if (!sameArticle(current.result.article, fresh.result.article) || !sameText(current.result.brand, fresh.result.brand)
    || current.reference.supplier !== fresh.reference.supplier) return false;
  const old = current.reference;
  const next = fresh.reference;
  if (old.supplier === "armtek" && next.supplier === "armtek") return old.keyzak === next.keyzak;
  if (old.supplier === "part-kom" && next.supplier === "part-kom") return old.makerId === next.makerId && old.providerId === next.providerId;
  if (old.supplier === "forum-auto" && next.supplier === "forum-auto") {
    return old.gid ? old.gid === next.gid : old.warehouse === next.warehouse;
  }
  return old.supplier === "rossko" && next.supplier === "rossko" && old.stockId === next.stockId
    && old.partGuid === next.partGuid;
}

export class RealOrderApplicationService implements RealOrderGateway {
  private readonly sessions: SupplierSessionManager;
  private readonly search: (query: SupplierSearchQuery, emit: (event: SearchStreamEvent) => void, signal: AbortSignal) => Promise<void>;
  private readonly credentialRepository: SupplierCredentialRepository | null;

  constructor(sessions: SupplierSessionManager,
    search: (query: SupplierSearchQuery, emit: (event: SearchStreamEvent) => void, signal: AbortSignal) => Promise<void>,
    credentialRepository: SupplierCredentialRepository | null = null) {
    this.sessions = sessions;
    this.search = search;
    this.credentialRepository = credentialRepository;
  }

  private rosskoCredentialsRecord(credentials: RosskoApiCredentials): StoredSupplierCredentials | null {
    const stored = this.credentialRepository?.get("rossko") ?? null;
    const keys = decodeRosskoApiCredentials(stored);
    return keys?.key1 === credentials.key1 && keys.key2 === credentials.key2 ? stored : null;
  }

  private rosskoOrderDetails(options: RosskoOrderChoices, credentials: RosskoApiCredentials): NonNullable<CheckoutDetails["rossko"]> {
    const settings = this.rosskoCredentialsRecord(credentials)?.rosskoOrder;
    if (!settings) return configuredRosskoOrderDefaults(options);
    try { return selectedRosskoOrderDetails(options, settings); }
    catch (error) {
      if (error instanceof RosskoOrderSettingsValidationError) throw new CartError(error.message, 409);
      throw error;
    }
  }

  private async rosskoSettings(signal: AbortSignal, update?: RosskoOrderSettings): Promise<RosskoOrderSettingsState> {
    const parsed = update ?? null;
    const operation = this.sessions.beginOperation("rossko", signal);
    try {
      operation.signal.throwIfAborted();
      const credentials = this.sessions.getRosskoApiCredentials();
      if (!credentials || !this.sessions.getSession("rossko").authorized) throw new SupplierAuthError("Rossko API keys are missing");
      const choices = allowedRosskoOrderChoices(await getRosskoOrderChoices(credentials, operation.signal));
      if (!choices.companies.length) throw new SupplierIntegrationError("Rossko returned no buyers", {
        publicMessage: "Rossko не вернул покупателей. Заполните реквизиты в личном кабинете Rossko и обновите данные.",
      });
      operation.signal.throwIfAborted();
      if (!operation.isCurrent()) throw new SupplierAuthError("Rossko session changed");
      const stored = this.rosskoCredentialsRecord(credentials);
      if (parsed) {
        selectedRosskoOrderDetails(choices, parsed);
        if (!stored || !this.credentialRepository) throw new CartError("Повторно подключите Rossko перед сохранением настроек заказа.", 409);
        this.credentialRepository.set("rossko", { ...stored, rosskoOrder: parsed });
      }
      return { choices, settings: parsed ?? stored?.rosskoOrder ?? null, persistent: this.credentialRepository?.persistent() ?? false };
    } finally { operation.dispose(); }
  }

  getRosskoOrderSettings(signal: AbortSignal): Promise<RosskoOrderSettingsState> { return this.rosskoSettings(signal); }
  saveRosskoOrderSettings(settings: unknown, signal: AbortSignal): Promise<RosskoOrderSettingsState> {
    return this.rosskoSettings(signal, parseRosskoOrderSettings(settings));
  }

  async partKomOrderHistory(archive: boolean, signal: AbortSignal) {
    signal.throwIfAborted();
    const credentials = this.sessions.getPartKomCredentials();
    if (!credentials) throw new SupplierAuthError("PartKOM API credentials are missing");
    return listPartKomOrderHistory(credentials, archive, signal);
  }

  async supplierOrderHistory(query: SupplierOrderHistoryQuery, signal: AbortSignal): Promise<OrderHistory> {
    signal.throwIfAborted();
    const bounded = createBoundedAbortSignal(signal, 35_000, "Supplier order history timed out");
    try {
      if (query.supplier === "armtek") {
        const credentials = this.sessions.getArmtekCredentials();
        if (!credentials) throw new SupplierAuthError("Armtek API credentials are missing");
        return await listArmtekOrderHistory(credentials, query.from, query.to, bounded.signal);
      }
      if (query.supplier === "forum-auto") {
        const credentials = this.sessions.getForumAutoCredentials();
        if (!credentials) throw new SupplierAuthError("Forum-Auto API credentials are missing");
        return await listForumAutoOrderHistory(credentials, bounded.signal);
      }
      const credentials = this.sessions.getRosskoApiCredentials();
      if (!credentials) throw new SupplierAuthError("Rossko API credentials are missing");
      return await listRosskoOrderHistory(credentials, bounded.signal);
    } catch (error) {
      if (bounded.signal.aborted) throw bounded.signal.reason;
      throw error;
    } finally { bounded.dispose(); }
  }

  async refresh(lines: PurchaseLine[], signal: AbortSignal): Promise<RefreshedPurchaseLine[]> {
    const found = new Map<string, { offers: Array<{ result: PurchaseLine["result"]; reference: PurchaseReference }>; issue?: CartRefreshIssue }>();
    for (const line of lines) {
      const key = JSON.stringify([line.reference.supplier, line.result.article]);
      if (found.has(key)) continue;
      const offers: Array<{ result: PurchaseLine["result"]; reference: PurchaseReference }> = [];
      let status: string | null = null;
      const failed = (message: string): void => { found.set(key, { offers: [], issue: { reason: "check_failed", message } }); };
      try {
        await this.search({ article: line.result.article, suppliers: [line.reference.supplier] }, (event) => {
          if (event.type === "result") {
            const reference = getPurchaseReference(event.result);
            if (reference) offers.push({ result: event.result, reference });
          } else if (event.type === "supplier_status" && event.supplier === line.reference.supplier) status = event.status;
        }, signal);
        signal.throwIfAborted();
        if (status === "completed") found.set(key, { offers });
        else if (status === "auth_error") failed(`Не удалось проверить товар: требуется авторизация ${supplierNames[line.reference.supplier]}.`);
        else if (status === "timeout") failed("Не удалось проверить товар: поставщик не ответил вовремя.");
        else failed("Не удалось проверить товар у поставщика.");
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof SupplierAuthError) failed(`Не удалось проверить товар: требуется авторизация ${supplierNames[line.reference.supplier]}.`);
        else if (error instanceof SupplierTimeoutError) failed("Не удалось проверить товар: поставщик не ответил вовремя.");
        else if (error instanceof SupplierIntegrationError) failed("Не удалось проверить товар у поставщика.");
        else throw error;
      }
    }
    return lines.map((line) => {
      const lookup = found.get(JSON.stringify([line.reference.supplier, line.result.article]));
      if (!lookup) throw new Error("Cart offer refresh result is missing");
      if (lookup.issue) return { ...line, refreshIssue: lookup.issue };
      const matches = lookup.offers.filter((offer) => sameOffer(line, offer));
      if (matches.length !== 1) return { ...line, refreshIssue: matches.length
        ? { reason: "check_failed", message: "Найдено несколько подходящих предложений. Товар недоступен для заказа." }
        : { reason: "not_found", message: "Товара больше нет у поставщика." } };
      const offer = matches[0];
      if (typeof offer.result.quantity !== "number" || !Number.isSafeInteger(offer.result.quantity)
        || offer.result.quantity < line.quantity) {
        return { ...line, refreshIssue: { reason: "insufficient_stock", message: "У поставщика недостаточно товара для этого количества." } };
      }
      return { id: line.id, quantity: line.quantity, result: offer.result, reference: offer.reference };
    });
  }

  async choices(suppliers: OrderSupplier[], signal: AbortSignal): Promise<OrderChoices> {
    signal.throwIfAborted();
    const result: OrderChoices = {};
    if (suppliers.includes("rossko")) {
      const credentials = this.sessions.getRosskoApiCredentials();
      if (!credentials) throw new SupplierAuthError("Rossko API keys are missing");
      result.rossko = allowedRosskoOrderChoices(await getRosskoOrderChoices(credentials, signal));
      this.rosskoOrderDetails(result.rossko, credentials);
    }
    if (suppliers.includes("part-kom")) {
      const credentials = this.sessions.getPartKomCredentials();
      if (!credentials) throw new SupplierAuthError("PartKOM API credentials are missing");
      result.partKom = getPartKomOrderChoices();
    }
    return result;
  }

  async prepare(supplier: OrderSupplier, lines: PurchaseLine[], details: CheckoutDetails, signal: AbortSignal) {
    signal.throwIfAborted();
    if (supplier === "armtek") {
      const credentials = this.sessions.getArmtekCredentials();
      if (!credentials) throw new SupplierAuthError("Armtek credentials are missing");
      if (lines.some((line) => line.reference.supplier !== supplier || !line.reference.keyzak)) {
        throw new SupplierIntegrationError("Armtek order reference is invalid");
      }
      await resolveArmtekConfig(credentials, signal);
      return (_attemptId: string, orderSignal: AbortSignal) => placeArmtekOrder(lines, credentials, orderSignal);
    }
    if (supplier === "forum-auto") {
      const credentials = this.sessions.getForumAutoCredentials();
      if (!credentials) throw new SupplierAuthError("Forum-Auto credentials are missing");
      if (lines.length !== 1 || lines[0].reference.supplier !== supplier || !lines[0].reference.gid) {
        throw new SupplierIntegrationError("Forum-Auto order reference is invalid");
      }
      await verifyForumAutoCredentials(credentials, undefined, signal);
      return (attemptId: string, orderSignal: AbortSignal) => placeForumAutoOrder(lines[0], credentials, orderSignal, attemptId);
    }
    if (supplier === "part-kom") {
      const credentials = this.sessions.getPartKomCredentials();
      if (!credentials) throw new SupplierAuthError("PartKOM credentials are missing");
      if (lines.length !== 1 || lines[0].reference.supplier !== supplier
        || !Number.isFinite(lines[0].result.price) || lines[0].result.price <= 0) {
        throw new SupplierIntegrationError("PartKOM order reference or price is invalid");
      }
      if (details.partKom?.deliveryId !== "regular") {
        throw new SupplierIntegrationError("PartKOM delivery settings are invalid");
      }
      return (attemptId: string, orderSignal: AbortSignal) => placePartKomOrder(lines[0], credentials, details, attemptId, orderSignal);
    }
    const credentials = this.sessions.getRosskoApiCredentials();
    if (!credentials) throw new SupplierAuthError("Rossko API keys are missing");
    if (lines.some((line) => line.reference.supplier !== supplier || !line.reference.stockId)) {
      throw new SupplierIntegrationError("Rossko order reference is invalid");
    }
    const options = allowedRosskoOrderChoices(await getRosskoOrderChoices(credentials, signal));
    const selected = this.rosskoOrderDetails(options, credentials);
    return (_attemptId: string, orderSignal: AbortSignal) => placeRosskoOrder(lines, credentials, { ...details, rossko: selected }, orderSignal);
  }
}
