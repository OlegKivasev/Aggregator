import type { RealOrderGateway } from "../purchasing/cart-application-service.ts";
import type { CheckoutDetails, OrderChoices, OrderSupplier, RosskoOrderChoices } from "../purchasing/order-contract.ts";
import { getPurchaseReference, type PurchaseLine, type PurchaseReference } from "../purchasing/purchase-offer.ts";
import type { SupplierSessionManager } from "../session/session-manager.ts";
import type { SearchStreamEvent, SupplierSearchQuery } from "../types.ts";
import { SupplierAuthError, SupplierIntegrationError, SupplierTimeoutError } from "../suppliers/errors.ts";
import { placeArmtekOrder } from "../suppliers/armtek/armtek-order.ts";
import { resolveArmtekConfig } from "../suppliers/armtek/armtek-api-adapter.ts";
import { placeForumAutoOrder, verifyForumAutoCredentials } from "../suppliers/forum-auto/forum-auto-api-adapter.ts";
import { getPartKomOrderChoices, placePartKomOrder } from "../suppliers/part-kom/part-kom-order.ts";
import { getRosskoOrderChoices, placeRosskoOrder } from "../suppliers/rossko/rossko-api-adapter.ts";

const validPhone = (value: unknown): value is string => typeof value === "string" && /^[+\d()\s-]{6,40}$/.test(value);
const sameText = (left: string, right: string): boolean => left.trim().toLocaleUpperCase() === right.trim().toLocaleUpperCase();
const sameArticle = (left: string, right: string): boolean => left.replace(/[^\p{L}\p{N}]/gu, "").toLocaleUpperCase()
  === right.replace(/[^\p{L}\p{N}]/gu, "").toLocaleUpperCase();

export function allowedRosskoOrderChoices(options: RosskoOrderChoices): RosskoOrderChoices {
  const deliveries = options.deliveries.filter((item) => item.addressId !== null);
  const payments = options.payments.filter((item) => /безнал|банковск\S*\s+(?:плат[её]ж|перевод)|перечислен|расч[её]тн\S*\s+сч[её]т/i.test(item.label)
    && !/(?:^|[^\p{L}])наличн|карт|эквайр|онлайн/iu.test(item.label));
  if (!deliveries.length) throw new SupplierIntegrationError("Rossko has no delivery address", {
    publicMessage: "Rossko не предложил доставку по адресу. Заказ не отправлен.",
  });
  if (!payments.length) throw new SupplierIntegrationError("Rossko has no bank transfer payment", {
    publicMessage: "Rossko не предложил оплату банковским переводом. Заказ не отправлен.",
  });
  return { ...options, deliveries, payments };
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

  constructor(sessions: SupplierSessionManager,
    search: (query: SupplierSearchQuery, emit: (event: SearchStreamEvent) => void, signal: AbortSignal) => Promise<void>) {
    this.sessions = sessions;
    this.search = search;
  }

  async refresh(lines: PurchaseLine[], signal: AbortSignal): Promise<PurchaseLine[]> {
    const found = new Map<string, Array<{ result: PurchaseLine["result"]; reference: PurchaseReference }>>();
    for (const line of lines) {
      const key = JSON.stringify([line.reference.supplier, line.result.article]);
      if (found.has(key)) continue;
      const offers: Array<{ result: PurchaseLine["result"]; reference: PurchaseReference }> = [];
      let status: string | null = null;
      await this.search({ article: line.result.article, suppliers: [line.reference.supplier] }, (event) => {
        if (event.type === "result") {
          const reference = getPurchaseReference(event.result);
          if (reference) offers.push({ result: event.result, reference });
        } else if (event.type === "supplier_status" && event.supplier === line.reference.supplier) status = event.status;
      }, signal);
      signal.throwIfAborted();
      if (status === "auth_error") throw new SupplierAuthError("Supplier authorization is unavailable for order refresh");
      if (status === "timeout") throw new SupplierTimeoutError("Supplier order refresh timed out");
      if (status !== "completed") throw new SupplierIntegrationError("Supplier offer refresh failed", {
        publicMessage: "Не удалось обновить предложение у поставщика. Заказ не отправлен.",
      });
      found.set(key, offers);
    }
    return lines.map((line) => {
      const offers = found.get(JSON.stringify([line.reference.supplier, line.result.article])) ?? [];
      const matches = offers.filter((offer) => sameOffer(line, offer));
      if (matches.length !== 1) throw new SupplierIntegrationError("Supplier offer is missing or ambiguous", {
        publicMessage: matches.length ? "Найдено несколько подходящих предложений. Заказ не отправлен."
          : "Предложение больше не найдено у поставщика. Заказ не отправлен.",
      });
      const offer = matches[0];
      if (typeof offer.result.quantity !== "number" || !Number.isSafeInteger(offer.result.quantity)
        || offer.result.quantity < line.quantity) {
        throw new SupplierIntegrationError("Supplier offer has insufficient confirmed stock", {
          publicMessage: "Остаток у поставщика меньше количества в корзине. Заказ не отправлен.",
        });
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
      return (_attemptId: string, orderSignal: AbortSignal) => placeForumAutoOrder(lines[0], credentials, orderSignal);
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
    const selected = details.rossko;
    const options = allowedRosskoOrderChoices(await getRosskoOrderChoices(credentials, signal));
    const delivery = options.deliveries.find((item) => item.id === selected?.deliveryId && item.addressId === selected.addressId);
    const payment = options.payments.find((item) => item.id === selected?.paymentId);
    if (!delivery || !payment || typeof selected?.name !== "string" || !selected.name.trim() || selected.name.length > 100
      || !validPhone(selected.phone) || typeof selected.deliveryParts !== "boolean"
      || selected.companyId !== null && !options.companies.some((item) => item.id === selected.companyId)) {
      throw new SupplierIntegrationError("Rossko checkout settings are invalid");
    }
    return (_attemptId: string, orderSignal: AbortSignal) => placeRosskoOrder(lines, credentials, details, orderSignal);
  }
}
