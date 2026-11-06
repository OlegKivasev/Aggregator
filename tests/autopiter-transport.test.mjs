import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { mock, test } from "node:test";
import { autopiterSoapRequest } from "../src/backend/suppliers/autopiter/autopiter-api-adapter.ts";
import { supplierMaxResponseBytes } from "../src/backend/config.ts";
import { SupplierIntegrationError } from "../src/backend/errors.ts";

test("Autopiter SOAP transport uses a fixed HTTPS origin, escapes credentials and bounds responses", async () => {
  const calls = [];
  let oversized = false;
  const replacement = mock.method(https, "request", (url, options, callback) => {
    const request = new EventEmitter();
    const call = { url: url.href, options, body: "" };
    calls.push(call);
    request.write = (chunk) => { call.body += chunk; };
    request.end = () => queueMicrotask(() => {
      const response = new PassThrough();
      response.statusCode = 200;
      response.headers = { "content-type": "text/xml", "set-cookie": ["AuthCoocies=fixture"],
        ...(oversized ? { "content-length": String(supplierMaxResponseBytes + 1) } : {}) };
      callback(response);
      if (!oversized) response.end("<result/>");
    });
    return request;
  });
  syncBuiltinESMExports();
  try {
    const response = await autopiterSoapRequest("Authorization", { UserID: "123456", Password: ' <test>&"\' ', Save: "false" }, new AbortController().signal);
    assert.equal(calls[0].url, "https://service.autopiter.ru/v2/price");
    assert.equal(calls[0].options.method, "POST");
    assert.equal(calls[0].options.headers.SOAPAction, '"http://www.autopiter.ru/Authorization"');
    assert.equal(calls[0].options.headers["Content-Type"], "text/xml; charset=utf-8");
    assert.ok(calls[0].options.signal instanceof AbortSignal);
    assert.match(calls[0].body, /<Password> &lt;test&gt;&amp;&quot;&apos; <\/Password>/);
    assert.equal(calls[0].options.headers.Cookie, undefined);
    assert.deepEqual(response.setCookie, ["AuthCoocies=fixture"]);
    await autopiterSoapRequest("IsAuthorization", {}, new AbortController().signal, "AuthCoocies=fixture");
    assert.equal(calls[1].options.headers.Cookie, "AuthCoocies=fixture");
    oversized = true;
    await assert.rejects(autopiterSoapRequest("FindCatalog", { Number: "A1" }, new AbortController().signal, "AuthCoocies=fixture"), SupplierIntegrationError);
    const aborted = new AbortController();
    aborted.abort(new Error("cancelled before request"));
    await assert.rejects(autopiterSoapRequest("FindCatalog", { Number: "A1" }, aborted.signal), /cancelled before request/);
    assert.equal(calls.length, 3);
  } finally {
    replacement.mock.restore(); syncBuiltinESMExports();
  }
});
