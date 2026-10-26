import test from "node:test";
import assert from "node:assert/strict";
import { METRICS, SCOPE_URLS, metric } from "../src/catalog.js";

test("catalog includes Fitbit Air health metrics exposed by Google Health v4", () => {
  for (const dataType of [
    "steps", "heart-rate", "sleep", "daily-heart-rate-variability",
    "daily-oxygen-saturation", "daily-respiratory-rate", "daily-vo2-max",
    "electrocardiogram", "irregular-rhythm-notification", "weight", "height"
  ]) assert.equal(metric(dataType).dataType, dataType);
  assert.ok(METRICS.length >= 35);
});

test("every catalog metric has a read-only scope", () => {
  for (const item of METRICS) assert.match(SCOPE_URLS[item.scope], /\.readonly$/);
});

test("daily rollup is limited to metrics for which Google documents it", () => {
  assert.equal(metric("steps").dailyRollup, true);
  assert.equal(metric("oxygen-saturation").dailyRollup, false);
  assert.equal(metric("daily-heart-rate-variability").dailyRollup, false);
  assert.equal(metric("electrocardiogram").dailyRollup, false);
});
