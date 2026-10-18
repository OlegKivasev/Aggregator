import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readPort } from "./config.ts";
import { createAggregatorServer, type AggregatorApplication } from "./http/create-server.ts";
import { createOrderNotifications } from "./notifications/create-order-notifications.ts";
import {
  authorizeArmtek,
  authorizeForumAuto,
  authorizeMotorDetal,
  authorizeMladov,
  authorizePartKom,
  authorizeRossko,
  authorizeStparts,
  addApplicabilityProxy,
  importApplicabilityProxies,
  deleteApplicabilityProxy,
  getApplicabilityProxyState,
  selectApplicabilityProxy,
  resetApplicabilityProxyUsage,
  deleteApplicabilityApiKey,
  getApplicabilityApiKeyState,
  getApplicabilityCachedBrands,
  listApplicabilitySavedArticles,
  getApplicabilitySavedArticle,
  deleteApplicabilitySavedArticle,
  listSupplierSessions,
  logoutArmtek,
  logoutForumAuto,
  logoutMotorDetal,
  logoutMladov,
  logoutPartKom,
  logoutRossko,
  logoutStparts,
  saveApplicabilityApiKey,
  searchApplicability,
  shutdownSearchService,
  streamSearch,
  testCartOrder,
  realCartOrder,
  validateSupplierSessions,
} from "./search-service.ts";

const rootDir = fileURLToPath(new URL("../..", import.meta.url));
const publicDir = join(rootDir, "src", "frontend");
const host = "127.0.0.1";

const port = readPort();

const application: AggregatorApplication = {
  addApplicabilityProxy,
  importApplicabilityProxies,
  deleteApplicabilityProxy,
  getApplicabilityProxyState,
  selectApplicabilityProxy,
  resetApplicabilityProxyUsage,
  authorizeArmtek,
  authorizeForumAuto,
  authorizeMotorDetal,
  authorizeMladov,
  authorizePartKom,
  authorizeRossko,
  authorizeStparts,
  deleteApplicabilityApiKey,
  getApplicabilityApiKeyState,
  getApplicabilityCachedBrands,
  listApplicabilitySavedArticles,
  getApplicabilitySavedArticle,
  deleteApplicabilitySavedArticle,
  listSupplierSessions,
  logoutArmtek,
  logoutForumAuto,
  logoutMotorDetal,
  logoutMladov,
  logoutPartKom,
  logoutRossko,
  logoutStparts,
  saveApplicabilityApiKey,
  searchApplicability,
  streamSearch,
  testCartOrder,
  realCartOrder,
  partKomOrderHistory: (archive, signal) => realCartOrder.partKomOrderHistory(archive, signal),
  supplierOrderHistory: (query, signal) => realCartOrder.supplierOrderHistory(query, signal),
  validateSupplierSessions,
};

const notifications = createOrderNotifications(application);
const server = createAggregatorServer({ application, publicDir, notifications: notifications.service });

server.listen(port, host, () => {
  notifications.service.start();
  console.log(`Aggregator server started at http://${host}:${port}`);
});

function shutdown(): void {
  notifications.service.stop();
  server.close(() => {
    notifications.close().then(() => shutdownSearchService()).then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
