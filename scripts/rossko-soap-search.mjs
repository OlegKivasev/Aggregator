import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

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
  ROSSKO_KEY1=... ROSSKO_KEY2=... pnpm rossko:search -- <article> --delivery-id <id> [--address-id <id>]
  ROSSKO_KEY1=... ROSSKO_KEY2=... pnpm rossko:search -- --checkout

Environment variables:
  ROSSKO_KEY1, ROSSKO_KEY2   Required API keys.
  ROSSKO_DELIVERY_ID         Optional default for --delivery-id.
  ROSSKO_ADDRESS_ID          Optional default for --address-id.

--checkout prints the complete GetCheckoutDetails response. Choose delivery_id and
address_id assigned to your account, then run an article search. For pickup, the
address ID may be omitted only when Rossko returns a pickup delivery method.`);
}

function xmlEscape(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} must be set in the environment`);
  }
  return value;
}

async function prompt(question) {
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    return (await readline.question(question)).trim();
  } finally {
    readline.close();
  }
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

if (values.help) {
  usage();
  process.exitCode = 0;
} else {
  try {
    const key1 = requiredEnvironment("ROSSKO_KEY1");
    const key2 = requiredEnvironment("ROSSKO_KEY2");

    if (values.checkout) {
      console.log(await callRossko("GetCheckoutDetails", { KEY1: key1, KEY2: key2 }));
    } else {
      const article = positionals[0]?.trim() || await prompt("Article: ");
      if (!article) {
        throw new Error("Article must not be empty");
      }

      const deliveryId = values["delivery-id"] || process.env.ROSSKO_DELIVERY_ID?.trim() || await prompt("delivery_id: ");
      if (!deliveryId) {
        throw new Error("delivery_id is required; run with --checkout to retrieve account settings");
      }

      const addressId = values["address-id"] || process.env.ROSSKO_ADDRESS_ID?.trim() || await prompt("address_id (blank for pickup): ");
      const fields = { KEY1: key1, KEY2: key2, text: article, delivery_id: deliveryId };
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
