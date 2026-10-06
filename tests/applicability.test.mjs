import assert from "node:assert/strict";
import { test } from "node:test";
import { SupplierAuthError, SupplierIntegrationError } from "../src/backend/errors.ts";
import { PartsApiApplicabilityClient } from "../src/backend/applicability/partsapi-client.ts";

const vehicle = {
  carId: 31251,
  carName: "1.4 16V",
  carType: "PC",
  makeName: "LADA",
  modelName: "KALINA Saloon (1118)",
  yearEnd: "12.2013",
  yearStart: "09.2006",
};

test("PartsAPI applicability client uses the documented endpoint and validates records", async () => {
  let requestedUrl;
  const client = new PartsApiApplicabilityClient(async (url) => {
    requestedUrl = url;
    return new Response(JSON.stringify([vehicle]), { headers: { "Content-Type": "application/json" } });
  });

  const results = await client.search({ sku: "11182905003", apiKey: "test-key" }, new AbortController().signal);

  assert.equal(requestedUrl.origin, "https://api.partsapi.ru");
  assert.equal(requestedUrl.searchParams.get("method"), "getApplicability2");
  assert.equal(requestedUrl.searchParams.get("sku"), "11182905003");
  assert.equal(requestedUrl.searchParams.get("key"), "test-key");
  assert.equal(requestedUrl.searchParams.has("brand"), false);
  assert.deepEqual(results, [vehicle]);
});

test("PartsAPI applicability client rejects malformed data and rejected API keys", async () => {
  const malformedClient = new PartsApiApplicabilityClient(async () => new Response(JSON.stringify([{ ...vehicle, carId: "31251" }]), {
    headers: { "Content-Type": "application/json" },
  }));
  await assert.rejects(
    malformedClient.search({ sku: "11182905003", apiKey: "test-key" }, new AbortController().signal),
    SupplierIntegrationError,
  );

  const rejectedClient = new PartsApiApplicabilityClient(async () => new Response(null, { status: 403 }));
  await assert.rejects(
    rejectedClient.search({ sku: "11182905003", apiKey: "test-key" }, new AbortController().signal),
    SupplierAuthError,
  );
});
