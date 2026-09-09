import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { decodeRosskoApiCredentials } from "../src/backend/application/supplier-session-service.ts";
import { getStateFilePath, supplierCredentialsEncryptionKey } from "../src/backend/config.ts";
import { EncryptedSupplierCredentialStore } from "../src/backend/session/encrypted-credential-store.ts";
import { parseRosskoCheckoutDetails } from "../src/backend/suppliers/rossko/rossko-api-adapter.ts";

const API_ORIGIN = "https://api.rossko.ru";
const API_VERSION = "v2.1";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

const { values, positionals } = parseArgs({
  options: {
    checkout: { type: "boolean", default: false },
    "delivery-id": { type: "string" },
    "address-id": { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: true,
});

function usage() {
  console.log(`Usage:
  pnpm rossko:search -- <article>
  pnpm rossko:search -- --checkout

Environment variables:
  ROSSKO_KEY1, ROSSKO_KEY2   Optional complete API-key pair, used instead of saved keys.

The command reads the authorized Rossko keys from the application's encrypted
credential store and obtains the compatible delivery and address automatically.
--delivery-id and --address-id are optional overrides. --checkout prints the
complete GetCheckoutDetails response.`);
}

function xmlEscape(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

export function resolveRosskoCredentials(environment, storedCredentials) {
  const key1 = environment.ROSSKO_KEY1?.trim();
  const key2 = environment.ROSSKO_KEY2?.trim();
  if (key1 || key2) {
    if (!key1 || !key2) {
      throw new Error("ROSSKO_KEY1 and ROSSKO_KEY2 must be set together");
    }
    return { key1, key2 };
  }

  const savedCredentials = decodeRosskoApiCredentials(storedCredentials);
  if (!savedCredentials) {
    throw new Error("No saved Rossko API keys are available for diagnostics");
  }
  return savedCredentials;
}

function envelope(method, fields) {
  const body = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => `      <ros:${name}>${xmlEscape(value)}</ros:${name}>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ros="${API_ORIGIN}/">
  <soapenv:Body>
    <ros:${method}>
${body}
    </ros:${method}>
  </soapenv:Body>
</soapenv:Envelope>`;
}

async function readResponse(response) {
  if (!response.body) {
    throw new Error("Rossko returned an empty response body");
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_RESPONSE_BYTES) {
      throw new Error(`Rossko response exceeds ${MAX_RESPONSE_BYTES} bytes`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function callRossko(method, fields) {
  const response = await fetch(`${API_ORIGIN}/service/${API_VERSION}/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      SOAPAction: `"${API_ORIGIN}/service/${API_VERSION}/${method}"`,
    },
    body: envelope(method, fields),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await readResponse(response);

  if (!response.ok) {
    throw new Error(`Rossko returned HTTP ${response.status}`);
  }
  if (!/<(?:[A-Za-z_][\w.-]*:)?Envelope\b/.test(body)) {
    throw new Error("Rossko returned a non-SOAP response");
  }
  return body;
}

async function main() {
  if (values.help) {
    usage();
    return;
  }

  try {
    const credentialStore = new EncryptedSupplierCredentialStore(
      getStateFilePath("supplier-credentials.enc.json"),
      supplierCredentialsEncryptionKey,
    );
    const credentials = resolveRosskoCredentials(process.env, credentialStore.get("rossko"));

    if (values.checkout) {
      console.log(await callRossko("GetCheckoutDetails", { KEY1: credentials.key1, KEY2: credentials.key2 }));
    } else {
      const article = positionals[0]?.trim();
      if (!article) {
        throw new Error("Article must be provided as a command argument");
      }

      const checkout = await callRossko("GetCheckoutDetails", {
        KEY1: credentials.key1,
        KEY2: credentials.key2,
      });
      const delivery = parseRosskoCheckoutDetails(checkout);
      const fields = {
        KEY1: credentials.key1,
        KEY2: credentials.key2,
        text: article,
        delivery_id: values["delivery-id"] || delivery.deliveryId,
      };
      const addressId = values["address-id"] || delivery.addressId;
      if (addressId) {
        fields.address_id = addressId;
      }
      console.log(await callRossko("GetSearch", fields));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Rossko request failure";
    console.error(`Rossko diagnostic failed: ${message}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
