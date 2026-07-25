import assert from "node:assert/strict";
import { test } from "node:test";
import { ArmtekApiAdapter } from "../src/backend/suppliers/armtek/armtek-api-adapter.ts";
import { MladovWebAdapter } from "../src/backend/suppliers/mladov/mladov-web-adapter.ts";
import { MotorDetalApiAdapter } from "../src/backend/suppliers/motordetal/motordetal-api-adapter.ts";
import { PartKomApiAdapter } from "../src/backend/suppliers/part-kom/part-kom-api-adapter.ts";
import { RosskoSiteApiAdapter } from "../src/backend/suppliers/rossko/rossko-site-api-adapter.ts";
import { StpartsApiAdapter } from "../src/backend/suppliers/stparts/stparts-api-adapter.ts";

test("every supplier adapter provides dedicated session validation", () => {
  const adapters = [
    new RosskoSiteApiAdapter(),
    new ArmtekApiAdapter(),
    new PartKomApiAdapter(),
    new StpartsApiAdapter(),
    new MotorDetalApiAdapter(),
    new MladovWebAdapter(),
  ];

  assert.deepEqual(adapters.map((adapter) => adapter.id), [
    "rossko",
    "armtek",
    "part-kom",
    "stparts",
    "motordetal",
    "mladov",
  ]);
  assert.ok(adapters.every((adapter) => typeof adapter.validateSession === "function"));
});
