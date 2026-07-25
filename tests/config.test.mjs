import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";

const configurationVariables = [
  "NODE_ENV",
  "PORT",
  "STATE_DIR",
  "SUPPLIER_CREDENTIALS_ENCRYPTION_KEY",
  "ARMTEK_API_BASE_URL",
  "ARMTEK_LOGIN",
  "ARMTEK_PASSWORD",
  "ARMTEK_VKORG",
  "ARMTEK_KUNNR_RG",
  "ARMTEK_KUNNR_ZA",
  "ARMTEK_INCOTERMS",
  "ARMTEK_VBELN",
  "ARMTEK_PROGRAM",
  "ARMTEK_QUERY_TYPE",
  "ARMTEK_REQUEST_TIMEOUT_MS",
  "ARMTEK_SEARCH_TIMEOUT_MS",
  "SUPPLIER_AUTHORIZATION_TIMEOUT_MS",
  "ROSSKO_BASE_URL",
  "ROSSKO_BROWSER_PATH",
  "ROSSKO_NAVIGATION_TIMEOUT_MS",
  "ROSSKO_NAVIGATION_ATTEMPTS",
  "ROSSKO_POST_COMMIT_DELAY_MS",
  "ROSSKO_RETRY_DELAY_MS",
  "ROSSKO_SETTLED_TIMEOUT_MS",
  "ROSSKO_SETTLED_FALLBACK_DELAY_MS",
  "ROSSKO_LOGIN_FIELD_VISIBLE_TIMEOUT_MS",
  "ROSSKO_AUTH_COOKIE_WAIT_TIMEOUT_MS",
  "ROSSKO_AUTH_COOKIE_POLL_INTERVAL_MS",
  "ROSSKO_AUTH_RESPONSE_TIMEOUT_MS",
  "ROSSKO_API_REQUEST_ATTEMPTS",
  "ROSSKO_API_HEDGE_DELAY_MS",
  "ROSSKO_API_REQUEST_TIMEOUT_MS",
  "ROSSKO_SEARCH_TIMEOUT_MS",
  "MLADOV_BASE_URL",
  "MLADOV_BROWSER_PATH",
  "MLADOV_NAVIGATION_TIMEOUT_MS",
  "MLADOV_SEARCH_TIMEOUT_MS",
  "MOTORDETAL_BASE_URL",
  "MOTORDETAL_REQUEST_TIMEOUT_MS",
  "MOTORDETAL_SEARCH_TIMEOUT_MS",
  "PARTKOM_SEARCH_TIMEOUT_MS",
  "STPARTS_API_URL",
  "STPARTS_API_LOGIN",
  "STPARTS_API_PASSWORD",
  "STPARTS_BASE_URL",
  "STPARTS_BROWSER_PATH",
  "STPARTS_SEARCH_TIMEOUT_MS",
  "STPARTS_NAVIGATION_TIMEOUT_MS",
  "STPARTS_SETTLED_TIMEOUT_MS",
  "STPARTS_POST_COMMIT_DELAY_MS",
  "STPARTS_SESSION_PROBE_TIMEOUT_MS",
];

function runConfig(script, overrides = {}, cwd = process.cwd()) {
  const env = { ...process.env };
  for (const variable of configurationVariables) {
    delete env[variable];
  }
  Object.assign(env, overrides);

  return spawnSync(process.execPath, [
    "--input-type=module",
    "--eval",
    script,
  ], {
    cwd,
    env,
    encoding: "utf8",
  });
}

test("configuration exposes validated defaults", () => {
  const execution = runConfig(`
    import { mladovConfig, readPort, rosskoConfig, stpartsConfig } from "./src/backend/config.ts";
    console.log(JSON.stringify({
      port: readPort(),
      rosskoUrl: rosskoConfig.businessUrl,
      rosskoAttempts: rosskoConfig.apiRequestAttempts,
      mladovTimeout: mladovConfig.searchTimeoutMs,
      stpartsUrl: stpartsConfig.apiUrl.toString(),
    }));
  `);

  assert.equal(execution.status, 0, execution.stderr);
  assert.deepEqual(JSON.parse(execution.stdout), {
    port: 3000,
    rosskoUrl: "https://samara.rossko.ru/",
    rosskoAttempts: 3,
    mladovTimeout: 20000,
    stpartsUrl: "https://stpartsru.public.api.abcp.ru/",
  });
});

test("configuration rejects unapproved supplier origins", () => {
  const execution = runConfig(
    'await import("./src/backend/config.ts");',
    { ARMTEK_API_BASE_URL: "https://credentials.invalid/api" },
  );

  assert.notEqual(execution.status, 0);
  assert.match(execution.stderr, /ARMTEK_API_BASE_URL must use HTTPS and an approved supplier hostname/);
});

test("configuration rejects invalid timeout and attempt values", () => {
  const invalidTimeout = runConfig(
    'await import("./src/backend/config.ts");',
    { MOTORDETAL_SEARCH_TIMEOUT_MS: "NaN" },
  );
  assert.notEqual(invalidTimeout.status, 0);
  assert.match(invalidTimeout.stderr, /MOTORDETAL_SEARCH_TIMEOUT_MS must be an integer/);

  const excessiveAttempts = runConfig(
    'await import("./src/backend/config.ts");',
    { ROSSKO_API_REQUEST_ATTEMPTS: "1000" },
  );
  assert.notEqual(excessiveAttempts.status, 0);
  assert.match(excessiveAttempts.stderr, /ROSSKO_API_REQUEST_ATTEMPTS must be an integer between 1 and 5/);
});

test("configuration validates the supplier credential encryption key", () => {
  const invalidKey = runConfig(
    'await import("./src/backend/config.ts");',
    { SUPPLIER_CREDENTIALS_ENCRYPTION_KEY: "not-a-32-byte-key" },
  );
  assert.notEqual(invalidKey.status, 0);
  assert.match(invalidKey.stderr, /SUPPLIER_CREDENTIALS_ENCRYPTION_KEY must be a base64-encoded 32-byte key/);

  const validKey = runConfig(`
    const { supplierCredentialsEncryptionKey } = await import("./src/backend/config.ts");
    process.stdout.write(String(supplierCredentialsEncryptionKey?.length));
  `, { SUPPLIER_CREDENTIALS_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" });
  assert.equal(validKey.status, 0, validKey.stderr);
  assert.equal(validKey.stdout.trim(), "32");
});

test("production state must be explicitly outside the checkout", () => {
  const missingStateDir = runConfig(`
    const { getStateFilePath } = await import("./src/backend/config.ts");
    getStateFilePath("session.json");
  `, { NODE_ENV: "production" });
  assert.notEqual(missingStateDir.status, 0);
  assert.match(missingStateDir.stderr, /STATE_DIR is required in production/);

  const checkoutStateDir = runConfig(`
    const { getStateFilePath } = await import("./src/backend/config.ts");
    getStateFilePath("session.json");
  `, { NODE_ENV: "production", STATE_DIR: resolve(process.cwd(), ".state") });
  assert.notEqual(checkoutStateDir.status, 0);
  assert.match(checkoutStateDir.stderr, /STATE_DIR must be outside the application checkout/);

  const checkoutStateFromAnotherWorkingDirectory = runConfig(`
    const { getStateFilePath } = await import(${JSON.stringify(new URL("../src/backend/config.ts", import.meta.url).href)});
    getStateFilePath("session.json");
  `, {
    NODE_ENV: "production",
    STATE_DIR: resolve(process.cwd(), ".state"),
  }, tmpdir());
  assert.notEqual(checkoutStateFromAnotherWorkingDirectory.status, 0);
  assert.match(checkoutStateFromAnotherWorkingDirectory.stderr, /STATE_DIR must be outside the application checkout/);
});

test("NODE_ENV is trimmed and rejects unsupported values", () => {
  const productionWithWhitespace = runConfig(`
    const { getStateFilePath } = await import("./src/backend/config.ts");
    getStateFilePath("session.json");
  `, { NODE_ENV: " production " });
  assert.notEqual(productionWithWhitespace.status, 0);
  assert.match(productionWithWhitespace.stderr, /STATE_DIR is required in production/);

  const misspelledEnvironment = runConfig(
    'await import("./src/backend/config.ts");',
    { NODE_ENV: "prodution" },
  );
  assert.notEqual(misspelledEnvironment.status, 0);
  assert.match(misspelledEnvironment.stderr, /NODE_ENV must be development, test, or production/);
});

test("environment credentials preserve password whitespace", () => {
  const execution = runConfig(`
    const { getArmtekApiConfig } = await import("./src/backend/config.ts");
    console.log(JSON.stringify(getArmtekApiConfig()));
  `, { ARMTEK_LOGIN: " api-user ", ARMTEK_PASSWORD: " secret " });

  assert.equal(execution.status, 0, execution.stderr);
  assert.deepEqual(JSON.parse(execution.stdout), {
    login: "api-user",
    password: " secret ",
    queryType: "1",
  });
});
