import type { AggregatorApplication } from "../http/create-server.ts";
import { getGarageDatabasePath, getStateFilePath, supplierCredentialsEncryptionKey } from "../config.ts";
import { EncryptedVkSettings } from "./encrypted-vk-settings.ts";
import { SqliteNotificationRepository } from "./sqlite-notification-repository.ts";
import { OrderNotificationService } from "./order-notification-service.ts";
import { VkClient } from "./vk-client.ts";
import { OrderCancellationService } from "../purchasing/order-cancellation-service.ts";
import { SqliteOrderCancellationRepository } from "../purchasing/sqlite-order-cancellation-repository.ts";

export function createOrderNotifications(application: AggregatorApplication): { service: OrderNotificationService; close(): Promise<void> } {
  const settings = new EncryptedVkSettings(getStateFilePath("vk-order-notifications.enc.json"), supplierCredentialsEncryptionKey);
  const repository = new SqliteNotificationRepository(getGarageDatabasePath());
  const cancellations = new OrderCancellationService(new SqliteOrderCancellationRepository(getGarageDatabasePath()));
  const service = new OrderNotificationService(settings, repository, new VkClient(), {
    available: (supplier) => application.listSupplierSessions().some((session) => session.supplier === supplier && session.authorized),
    load: async (supplier, signal, now) => {
      if (supplier === "part-kom") {
        if (!application.partKomOrderHistory) throw new Error("Order history is not configured");
        const current = await application.partKomOrderHistory(false, signal);
        const archive = await application.partKomOrderHistory(true, signal);
        return [current, archive];
      }
      if (!application.supplierOrderHistory) throw new Error("Order history is not configured");
      const history = await application.supplierOrderHistory(supplier === "armtek"
        ? { supplier, from: new Date(now - 92 * 86_400_000).toISOString().slice(0, 10), to: new Date(now).toISOString().slice(0, 10) }
        : { supplier }, signal);
      return [history];
    },
    observe: (supplier, history) => cancellations.observe(supplier, history),
  });
  return { service, async close() { await service.close(); cancellations.close(); } };
}
