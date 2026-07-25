import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { createBoundedAbortSignal } from "../src/backend/abort.ts";
import { SupplierIntegrationError, SupplierTimeoutError } from "../src/backend/errors.ts";
import { readBoundedJsonResponse } from "../src/backend/suppliers/fetch-json.ts";

test("bounded JSON reader accepts JSON media types", async () => {
  const response = new Response(JSON.stringify({ status: "ok" }), {
    headers: { "Content-Type": "application/problem+json; charset=utf-8" },
  });

  assert.deepEqual(await readBoundedJsonResponse(response, 1024, "Test API"), { status: "ok" });
});

test("bounded JSON reader rejects unexpected and oversized responses", async () => {
  await assert.rejects(
    readBoundedJsonResponse(new Response("{}", { headers: { "Content-Type": "text/html" } }), 1024, "Test API"),
    (error) => error instanceof SupplierIntegrationError && /content type/.test(error.message),
  );

  const oversizedStream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(700));
      controller.enqueue(new Uint8Array(700));
      controller.close();
    },
  });
  await assert.rejects(
    readBoundedJsonResponse(new Response(oversizedStream, { headers: { "Content-Type": "application/json" } }), 1024, "Test API"),
    (error) => error instanceof SupplierIntegrationError && /too large/.test(error.message),
  );
});

test("bounded abort signal preserves parent abort and typed timeout reasons", async () => {
  const parent = new AbortController();
  const forwarded = createBoundedAbortSignal(parent.signal, 1000, "request timed out");
  const parentReason = new Error("client disconnected");
  parent.abort(parentReason);
  assert.equal(forwarded.signal.reason, parentReason);
  forwarded.dispose();

  const timed = createBoundedAbortSignal(new AbortController().signal, 10, "request timed out");
  await once(timed.signal, "abort");
  assert.ok(timed.signal.reason instanceof SupplierTimeoutError);
  assert.equal(timed.signal.reason.message, "request timed out");
  timed.dispose();
});
