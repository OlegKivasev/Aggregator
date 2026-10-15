import type { RealOrderGateway } from "../purchasing/cart-application-service.ts";
import type { CheckoutDetails, OrderChoices, OrderSupplier } from "../purchasing/order-contract.ts";
import type { PurchaseLine } from "../purchasing/purchase-offer.ts";
import type { SupplierSessionManager } from "../session/session-manager.ts";
import { SupplierAuthError, SupplierIntegrationError } from "../suppliers/errors.ts";
import { placeArmtekOrder } from "../suppliers/armtek/armtek-order.ts";
import { resolveArmtekConfig } from "../suppliers/armtek/armtek-api-adapter.ts";
import { placeForumAutoOrder, verifyForumAutoCredentials } from "../suppliers/forum-auto/forum-auto-api-adapter.ts";
import { getPartKomOrderChoices, placePartKomOrder } from "../suppliers/part-kom/part-kom-order.ts";
import { getRosskoOrderChoices, placeRosskoOrder } from "../suppliers/rossko/rossko-api-adapter.ts";

const validPhone = (value: unknown): value is string => typeof value === "string" && /^[+\d()\s-]{6,40}$/.test(value);

export class RealOrderApplicationService implements RealOrderGateway {
  private readonly sessions: SupplierSessionManager;

  constructor(sessions: SupplierSessionManager) { this.sessions = sessions; }

  async choices(suppliers: OrderSupplier[], signal: AbortSignal): Promise<OrderChoices> {
    const result: OrderChoices = {};
    if (suppliers.includes("rossko")) {
      const credentials = this.sessions.getRosskoApiCredentials();
      if (!credentials) throw new SupplierAuthError("Rossko API keys are missing");
      result.rossko = await getRosskoOrderChoices(credentials, signal);
    }
    if (suppliers.includes("part-kom")) {
      const credentials = this.sessions.getPartKomCredentials();
      if (!credentials) throw new SupplierAuthError("PartKOM API credentials are missing");
      result.partKom = await getPartKomOrderChoices(credentials, signal);
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
      if (lines.length !== 1 || lines[0].reference.supplier !== supplier || !Number.isSafeInteger(lines[0].result.price)) {
        throw new SupplierIntegrationError("PartKOM order reference or price is invalid");
      }
      const options = await getPartKomOrderChoices(credentials, signal);
      const choice = options.deliveries.find((item) => item.id === details.partKom?.deliveryId);
      if (!choice || choice.type === "pickup" && (typeof details.partKom?.name !== "string" || !details.partKom.name.trim()
        || details.partKom.name.length > 100 || !validPhone(details.partKom.phone))) {
        throw new SupplierIntegrationError("PartKOM delivery settings are invalid");
      }
      return (attemptId: string, orderSignal: AbortSignal) => placePartKomOrder(lines[0], credentials, details, choice, attemptId, orderSignal);
    }
    const credentials = this.sessions.getRosskoApiCredentials();
    if (!credentials) throw new SupplierAuthError("Rossko API keys are missing");
    if (lines.some((line) => line.reference.supplier !== supplier || !line.reference.stockId)) {
      throw new SupplierIntegrationError("Rossko order reference is invalid");
    }
    const selected = details.rossko;
    const options = await getRosskoOrderChoices(credentials, signal);
    const delivery = options.deliveries.find((item) => item.id === selected?.deliveryId && item.addressId === selected.addressId);
    const payment = options.payments.find((item) => item.id === selected?.paymentId);
    if (!delivery || !payment || typeof selected?.name !== "string" || !selected.name.trim() || selected.name.length > 100
      || !validPhone(selected.phone) || typeof selected.deliveryParts !== "boolean"
      || selected.companyId !== null && !options.companies.some((item) => item.id === selected.companyId)
      || /карт/i.test(payment.label) && delivery.addressId !== null && selected.companyId === null) {
      throw new SupplierIntegrationError("Rossko checkout settings are invalid");
    }
    return (_attemptId: string, orderSignal: AbortSignal) => placeRosskoOrder(lines, credentials, details, orderSignal);
  }
}
