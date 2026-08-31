import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readPort } from "./config.ts";
import { createAggregatorServer, type AggregatorApplication } from "./http/create-server.ts";
import {
  authorizeArmtek,
  authorizeForumAuto,
  authorizeMotorDetal,
  authorizeMladov,
  authorizePartKom,
  authorizeRossko,
  authorizeStparts,
  listSupplierSessions,
  logoutArmtek,
  logoutForumAuto,
  logoutMotorDetal,
  logoutMladov,
  logoutPartKom,
  logoutRossko,
  logoutStparts,
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
  authorizeForumAuto,
  authorizeMotorDetal,
  authorizeMladov,
  authorizePartKom,
  authorizeRossko,
  authorizeStparts,
  listSupplierSessions,
  logoutArmtek,
  logoutForumAuto,
  logoutMotorDetal,
  logoutMladov,
  logoutPartKom,
  logoutRossko,
  logoutStparts,
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
