import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createHttpsServer, request as httpsRequest } from "node:https";
import { connect } from "node:net";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { test } from "node:test";
import { requestPartsApiViaProxy } from "../src/backend/applicability/partsapi-proxy-request.ts";
import { PartsApiApplicabilityClient } from "../src/backend/applicability/partsapi-client.ts";
import { SupplierIntegrationError } from "../src/backend/errors.ts";

// Self-signed TLS fixture and credentials are fictional and used only on loopback.
const key = readFileSync(new URL("./fixtures/partsapi-proxy-test-key.pem", import.meta.url));
const cert = readFileSync(new URL("./fixtures/partsapi-proxy-test-cert.pem", import.meta.url));
const targetUrl = new URL("https://api.partsapi.ru/?method=getApplicability&key=fictional-key&sku=TEST1&brand=FORD");
const proxyConfig = (port, protocol = "http") => ({ protocol, host: "127.0.0.1", port, login: "fictional+proxy", password: " fictional:p@ss%word " });
const trustedRequest = (url, options, callback) => httpsRequest(url, { ...options, ca: cert }, callback);

async function listen(t, server) {
  const sockets = new Set();
  server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return server.address().port;
}

for (const protocol of ["http", "https"]) test(`PartsAPI uses authenticated ${protocol.toUpperCase()} CONNECT and never sends proxy credentials to the target`, { timeout: 5000 }, async (t) => {
  if (protocol === "https") {
    const original = getCACertificates("default");
    setDefaultCACertificates([...original, cert.toString()]);
    t.after(() => setDefaultCACertificates(original));
  }
  let received;
  const target = createHttpsServer({ key, cert }, (request, response) => {
    received = { url: request.url, headers: request.headers };
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify([{ carId: 1, carName: "Test", carType: "PC", makeName: "FORD", modelName: "Test", yearEnd: null, yearStart: null }]));
  });
  const targetPort = await listen(t, target);
  let connected;
  const proxy = protocol === "https" ? createHttpsServer({ key, cert }) : createServer();
  proxy.on("connect", (request, client, head) => {
    connected = { url: request.url, authorization: request.headers["proxy-authorization"] };
    const upstream = connect(targetPort, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
    client.once("close", () => upstream.destroy());
  });
  const port = await listen(t, proxy);
  const response = await requestPartsApiViaProxy(targetUrl, proxyConfig(port, protocol), new AbortController().signal, trustedRequest);
  assert.equal(response.status, 200);
  assert.equal((await response.json())[0].carId, 1);
  assert.equal(connected.url, "api.partsapi.ru:443");
  assert.equal(connected.authorization, `Basic ${Buffer.from("fictional+proxy: fictional:p@ss%word ").toString("base64")}`);
  assert.equal(received.url, targetUrl.pathname + targetUrl.search);
  assert.equal(received.headers["proxy-authorization"], undefined);
  assert.equal(received.headers.authorization, undefined);
});

test("an authenticated proxy rejection is a safe error and cannot fall back to direct", { timeout: 5000 }, async (t) => {
  const proxy = createServer();
  proxy.on("connect", (_request, socket) => socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n"));
  const port = await listen(t, proxy);
  let directCalls = 0;
  const client = new PartsApiApplicabilityClient(async () => { directCalls += 1; throw new Error("Direct request must never happen"); });
  await assert.rejects(client.search({ sku: "TEST1", brand: "FORD", apiKey: "fictional-key" }, new AbortController().signal, proxyConfig(port)), (error) => {
    assert.ok(error instanceof SupplierIntegrationError);
    assert.match(error.publicMessage, /прокси PartsAPI/);
    assert.ok(!error.publicMessage.includes("fictional"));
    return true;
  });
  assert.equal(directCalls, 0);
});

test("cancelling a pending proxy CONNECT closes its socket", { timeout: 5000 }, async (t) => {
  const proxy = createServer();
  const port = await listen(t, proxy);
  const connecting = once(proxy, "connect");
  const controller = new AbortController();
  const pending = requestPartsApiViaProxy(targetUrl, proxyConfig(port), controller.signal);
  const [, socket] = await connecting;
  // CONNECT hands ownership to the proxy; observe the client's EOF before closing our half.
  const ended = once(socket, "end");
  socket.resume();
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  await ended;
  socket.end();
});

test("unapproved target origins are rejected before a proxy can see credentials", () => {
  assert.throws(() => requestPartsApiViaProxy(new URL("https://unapproved.invalid/"), proxyConfig(8000), new AbortController().signal), SupplierIntegrationError);
});
