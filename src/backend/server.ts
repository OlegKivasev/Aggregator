import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readPort } from "./config.ts";
import { createAggregatorServer, type AggregatorApplication } from "./http/create-server.ts";
import {
  authorizeArmtek,
  addApplicabilityFallbackApiKey,
  authorizeForumAuto,
  authorizeMotorDetal,
  authorizeMladov,
  authorizePartKom,
  authorizeRossko,
  authorizeStparts,
  deleteApplicabilityApiKey,
  deleteApplicabilityFallbackApiKey,
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
  selectApplicabilityActiveApiKey,
  searchApplicability,
  shutdownSearchService,
  streamSearch,
  validateSupplierSessions,
} from "./search-service.ts";

const rootDir = fileURLToPath(new URL("../..", import.meta.url));
const publicDir = join(rootDir, "src", "frontend");
const host = "127.0.0.1";

const port = readPort();

const application: AggregatorApplication = {
  authorizeArmtek,
  addApplicabilityFallbackApiKey,
  authorizeForumAuto,
  authorizeMotorDetal,
  authorizeMladov,
  authorizePartKom,
  authorizeRossko,
  authorizeStparts,
  deleteApplicabilityApiKey,
  deleteApplicabilityFallbackApiKey,
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
  selectApplicabilityActiveApiKey,
  searchApplicability,
  streamSearch,
  validateSupplierSessions,
};

const server = createAggregatorServer({ application, publicDir });

server.listen(port, host, () => {
  console.log(`Aggregator server started at http://${host}:${port}`);
});

function shutdown(): void {
  server.close(() => {
    shutdownSearchService().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
