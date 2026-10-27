import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RealOrderApplicationService } from "../src/backend/application/real-order-application-service.ts";
import { SupplierSessionService, encodeRosskoApiCredentials } from "../src/backend/application/supplier-session-service.ts";
import { SupplierSessionManager } from "../src/backend/session/session-manager.ts";
import { EncryptedSupplierCredentialStore } from "../src/backend/session/encrypted-credential-store.ts";
import { parseRosskoOrderSettings } from "../src/backend/purchasing/rossko-order-settings.ts";
import { SupplierAuthError } from "../src/backend/errors.ts";

// Fictional account and SOAP fixtures; these tests never contact Rossko.
const keys = { key1: "fixture-key-one", key2: "fixture-key-two" };
const settings = { companyId: "buyer-2", deliveryId: "delivery", addressId: "address-2", paymentId: "bank-2",
  contactName: "Тестовый контакт & отдел", contactPhone: "+7 (000) 123-45-67" };
const detailsXml = `<Envelope><CheckoutDetailsResult><success>true</success>
  <DeliveryType><delivery><id>delivery</id><name>Доставка</name></delivery><delivery><id>pickup</id><name>Самовывоз</name></delivery></DeliveryType>
  <DeliveryAddress>${[1, 2].map((id) => `<address><id>address-${id}</id><city>Тестовый город</city><street>Улица ${id}</street><house>1</house><Delivery><ids><id>delivery</id></ids></Delivery></address>`).join("")}</DeliveryAddress>
  <PaymentType><payment><id>cash</id><name>Наличными</name></payment>${[1, 2].map((id) => `<payment><id>bank-${id}</id><name>Через банк ${id}</name></payment>`).join("")}</PaymentType>
  <CompanyList>${[1, 2].map((id) => `<company><id>buyer-${id}</id><name>Тестовый покупатель ${id}</name></company>`).join("")}</CompanyList>
  </CheckoutDetailsResult></Envelope>`;
const xmlResponse = (xml) => new Response(xml, { headers: { "content-type": "text/xml" } });

async function withService(check, { encrypted = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "rossko-settings-test-"));
  const path = join(directory, "credentials.enc.json");
  const key = encrypted ? Buffer.alloc(32, 7) : null;
  const store = new EncryptedSupplierCredentialStore(path, key);
  store.set("rossko", encodeRosskoApiCredentials(keys));
  const sessions = new SupplierSessionManager();
  sessions.setRosskoApiCredentials(keys); sessions.markAuthorized("rossko");
  const service = new RealOrderApplicationService(sessions, async () => {}, store);
  const signal = new AbortController().signal;
  try { await check({ service, store, sessions, signal, path, key }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test("Rossko settings validate contact fields, identifiers and malformed input", () => {
  assert.deepEqual(parseRosskoOrderSettings({ ...settings, contactName: ` ${settings.contactName} ` }), settings);
  for (const value of [null, [], {}, { ...settings, companyId: "" }, { ...settings, contactName: "x".repeat(101) },
    { ...settings, contactName: "name\nheader" }, { ...settings, contactPhone: "------" }, { ...settings, contactPhone: "wrong phone" }]) {
    assert.throws(() => parseRosskoOrderSettings(value));
  }
});

test("Rossko settings persist encrypted, use live choices and supply the saved buyer and contact to checkout", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url: String(url), body: options.body });
    if (String(url).endsWith("/GetCheckoutDetails")) return xmlResponse(detailsXml);
    assert.equal(String(url).endsWith("/GetCheckout"), true);
    return xmlResponse("<Envelope><CheckoutResult><success>false</success></CheckoutResult></Envelope>");
  });
  await withService(async ({ service, store, sessions, signal, path, key }) => {
    const initial = await service.getRosskoOrderSettings(signal);
    assert.equal(initial.settings, null);
    assert.equal(initial.choices.deliveries.length, 2);
    assert.deepEqual(initial.choices.payments.map((item) => item.id), ["bank-1", "bank-2"]);
    assert.equal(JSON.stringify(initial).includes(keys.key1), false);
    const saved = await service.saveRosskoOrderSettings(settings, signal);
    assert.deepEqual(saved.settings, settings);
    assert.equal(saved.persistent, true);
    const ciphertext = await readFile(path, "utf8");
    for (const secret of [keys.key1, keys.key2, settings.contactName, settings.contactPhone, settings.companyId]) assert.equal(ciphertext.includes(secret), false);
    const restored = new EncryptedSupplierCredentialStore(path, key);
    const afterRestart = new RealOrderApplicationService(sessions, async () => {}, restored);
    assert.deepEqual((await afterRestart.getRosskoOrderSettings(signal)).settings, settings);
    assert.deepEqual((await afterRestart.choices(["rossko"], signal)).rossko.companies, saved.choices.companies);
    const line = { id: "line-1", quantity: 1, reference: { supplier: "rossko", partGuid: "fixture-guid", stockId: "fixture-stock" },
      result: { supplier: "rossko", article: "A1", brand: "TEST", price: 100 } };
    const send = await afterRestart.prepare("rossko", [line], { rossko: { companyId: "untrusted-buyer" } }, signal);
    assert.equal(calls.some((call) => call.url.endsWith("/GetCheckout")), false);
    await send("test-attempt", signal);
    const order = calls.find((call) => call.url.endsWith("/GetCheckout")).body;
    assert.match(order, /<ros:requisite_id>buyer-2<\/ros:requisite_id>/);
    assert.match(order, /<ros:address_id>address-2<\/ros:address_id>/);
    assert.match(order, /<ros:payment_id>bank-2<\/ros:payment_id>/);
    assert.match(order, /Тестовый контакт &amp; отдел/);
    assert.match(order, /<ros:phone>\+7 \(000\) 123-45-67<\/ros:phone>/);
    assert.match(order, /<ros:delivery_parts>false<\/ros:delivery_parts>/);
    assert.doesNotMatch(order, /untrusted-buyer/);
    const copy = store.get("rossko"); copy.rosskoOrder.contactName = "Изменённая копия";
    assert.deepEqual(store.get("rossko").rosskoOrder, settings);
  });
});

test("Rossko settings reject forged or expired choices without replacing the saved profile or placing orders", async (t) => {
  let xml = detailsXml;
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    assert.equal(String(url).endsWith("/GetCheckoutDetails"), true); calls++;
    return xmlResponse(xml);
  });
  await withService(async ({ service, store, signal }) => {
    await service.saveRosskoOrderSettings(settings, signal);
    for (const invalid of [{ companyId: "unknown" }, { paymentId: "cash" }, { deliveryId: "pickup" }, { addressId: "foreign-address" }]) {
      await assert.rejects(service.saveRosskoOrderSettings({ ...settings, ...invalid }, signal), /Rossko больше не подтверждает/);
      assert.deepEqual(store.get("rossko").rosskoOrder, settings);
    }
    xml = detailsXml.replace("<id>buyer-2</id>", "<id>replacement-buyer</id>");
    await assert.rejects(service.choices(["rossko"], signal), (error) => error.statusCode === 409);
    assert.equal(calls, 6);
    xml = detailsXml.replace(/<CompanyList>.*<\/CompanyList>/s, "<CompanyList/>");
    await assert.rejects(service.getRosskoOrderSettings(signal), (error) => /Rossko не вернул покупателей/.test(error.publicMessage));
  });
});

test("Rossko settings remain memory-only without encryption and are cleared on logout or credential rotation", async (t) => {
  t.mock.method(globalThis, "fetch", async () => xmlResponse(detailsXml));
  await withService(async ({ service, store, sessions, signal, path }) => {
    assert.equal((await service.saveRosskoOrderSettings(settings, signal)).persistent, false);
    assert.equal(existsSync(path), false);
    const sessionService = new SupplierSessionService([], sessions, { verifyRosskoApiCredentials: async () => {}, clearRosskoApiState() {} }, store);
    await sessionService.authorizeRossko(keys, signal);
    assert.deepEqual(store.get("rossko").rosskoOrder, settings);
    await sessionService.authorizeRossko({ key1: "new-fixture-key", key2: "new-fixture-secret" }, signal);
    assert.equal(store.get("rossko").rosskoOrder, undefined);
    await assert.rejects(service.saveRosskoOrderSettings({ ...settings, companyId: "old-account-buyer" }, signal));
    sessionService.logoutRossko();
    assert.equal(store.get("rossko"), null);
    await assert.rejects(service.getRosskoOrderSettings(signal), SupplierAuthError);
  }, { encrypted: false });
});

test("logout and request cancellation prevent late Rossko settings saves", async (t) => {
  let started;
  let release;
  let upstreamSignal;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    upstreamSignal = options.signal; started();
    await new Promise((resolve) => { release = resolve; });
    return xmlResponse(detailsXml);
  });
  for (const logout of [true, false]) {
    await withService(async ({ service, store, sessions }) => {
      const entered = new Promise((resolve) => { started = resolve; });
      const controller = new AbortController();
      const pending = service.saveRosskoOrderSettings(settings, controller.signal);
      const rejected = assert.rejects(pending);
      await entered;
      if (logout) {
        new SupplierSessionService([], sessions, { clearRosskoApiState() {} }, store).logoutRossko();
      } else controller.abort(new Error("fixture disconnect"));
      assert.equal(upstreamSignal.aborted, true);
      release(); await rejected;
      assert.equal(store.get("rossko")?.rosskoOrder, undefined);
    });
  }
});
