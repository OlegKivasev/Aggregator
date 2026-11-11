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
    await autopiterSoapRequest("GetPriceId", { ArticleId: "101", Currency: "РУБ", SearchCross: "1", MinSalesRating: "0", MinRealTimeInProc: "0" }, new AbortController().signal, "AuthCoocies=fixture");
    assert.equal(calls[2].options.headers.SOAPAction, '"http://www.autopiter.ru/GetPriceId"');
    assert.match(calls[2].body, /<ArticleId>101<\/ArticleId><Currency>РУБ<\/Currency><SearchCross>1<\/SearchCross>/);
    await autopiterSoapRequest("MakeOrderByItems", { Items: { ItemAddCartModel: [
      { DetailUid: 'fixture<&"', Comment: "", SalePrice: "125.5", Quantity: "2" },
      { DetailUid: "second", Comment: "", SalePrice: "100", Quantity: "1" },
    ] } }, new AbortController().signal, "AuthCoocies=fixture");
    assert.equal(calls[3].options.headers.SOAPAction, '"http://www.autopiter.ru/MakeOrderByItems"');
    assert.equal(calls[3].options.headers.Cookie, "AuthCoocies=fixture");
    assert.match(calls[3].body, /<Items><ItemAddCartModel><DetailUid>fixture&lt;&amp;&quot;<\/DetailUid><Comment><\/Comment><SalePrice>125.5<\/SalePrice><Quantity>2<\/Quantity><\/ItemAddCartModel><ItemAddCartModel>/);
    assert.equal((calls[3].body.match(/<ItemAddCartModel>/g) ?? []).length, 2);
    oversized = true;
    await assert.rejects(autopiterSoapRequest("FindCatalog", { Number: "A1" }, new AbortController().signal, "AuthCoocies=fixture"), SupplierIntegrationError);
    const aborted = new AbortController();
    aborted.abort(new Error("cancelled before request"));
    await assert.rejects(autopiterSoapRequest("FindCatalog", { Number: "A1" }, aborted.signal), /cancelled before request/);
    assert.equal(calls.length, 5);
  } finally {
    replacement.mock.restore(); syncBuiltinESMExports();
  }
});
