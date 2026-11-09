import assert from "node:assert/strict";
import { test } from "node:test";
import { getVideoScanRegion } from "../src/frontend/nomenclature-scan-region.js";

const rect = (left, top, width, height) => ({ left, top, width, height });

test("camera frame mapping accounts for horizontal and vertical cover cropping", () => {
  const video = rect(0, 0, 400, 400);
  const frame = rect(100, 100, 200, 200);
  assert.deepEqual(getVideoScanRegion(1000, 500, video, frame), { x: 375, y: 125, width: 250, height: 250 });
  assert.deepEqual(getVideoScanRegion(500, 1000, video, frame), { x: 125, y: 375, width: 250, height: 250 });
  assert.deepEqual(getVideoScanRegion(1000, 500, rect(40, 60, 400, 400), rect(140, 160, 200, 200)),
    { x: 375, y: 125, width: 250, height: 250 });
});

test("camera frame mapping rounds inward and intersects the visible video", () => {
  assert.deepEqual(getVideoScanRegion(640, 480, rect(0, 0, 320, 240), rect(101.2, 61.2, 98.4, 78.4)),
    { x: 203, y: 123, width: 196, height: 156 });
  assert.deepEqual(getVideoScanRegion(1000, 500, rect(0, 0, 400, 400), rect(-50, 100, 150, 200)),
    { x: 250, y: 125, width: 125, height: 250 });
});

test("an empty, unavailable or out-of-view frame never selects the full camera image", () => {
  const video = rect(0, 0, 400, 400);
  for (const frame of [rect(100, 100, 0, 200), rect(0, 0, 0, 0), rect(500, 0, 200, 200), rect(NaN, 0, 100, 100)]) {
    assert.equal(getVideoScanRegion(1000, 500, video, frame), null);
  }
  assert.equal(getVideoScanRegion(0, 0, video, rect(100, 100, 200, 200)), null);
  assert.equal(getVideoScanRegion(1000, 500, rect(0, 0, 0, 0), rect(100, 100, 200, 200)), null);
});
