import test from "node:test";
import assert from "node:assert/strict";
import { addDays, applySourcePolicy, assertTimezone, civilDateInTimezone, normalizeMetric, trend } from "../src/analytics.js";

test("analytics validates timezones and computes civil dates", () => {
  assert.equal(assertTimezone("America/Detroit"), "America/Detroit");
  assert.equal(civilDateInTimezone("UTC", new Date("2026-08-01T23:30:00Z")), "2026-08-01");
  assert.equal(civilDateInTimezone("America/Detroit", new Date("2026-08-02T03:30:00Z")), "2026-08-01");
  assert.equal(addDays("2026-08-01", 7), "2026-08-08");
  assert.throws(() => assertTimezone("not/a-timezone"), /Invalid IANA timezone/);
});

test("trend returns stable summary statistics", () => {
  assert.deepEqual(trend([10, 15, 20]), { records: 3, average: 15, minimum: 10, maximum: 20, first: 10, last: 20, percentChange: 100 });
  assert.deepEqual(trend([]), { records: 0 });
});

test("normalization preserves raw structure while adding useful units", () => {
  assert.deepEqual(normalizeMetric("distance", { distance: { millimetersSum: "1609344" } }), { distance: { millimetersSum: { value: 1609344, kilometers: 1.609344, miles: 1 } } });
  assert.deepEqual(normalizeMetric("weight", { weightGramsAvg: 62778 }), { weightGramsAvg: { grams: 62778, kilograms: 62.778, pounds: 138.40179895442245 } });
});

test("source policy filters, deduplicates, and reports cross-source conflicts", () => {
  const records = [
    { dataSource: { platform: "FITBIT" }, dailyHeartRateVariability: { date: { year: 2026, month: 8, day: 1 }, average: 50 } },
    { dataSource: { platform: "HEALTH_KIT" }, dailyHeartRateVariability: { date: { year: 2026, month: 8, day: 1 }, average: 60 } },
    { dataSource: { platform: "FITBIT" }, dailyHeartRateVariability: { date: { year: 2026, month: 7, day: 31 }, average: 48 } }
  ];
  const all = applySourcePolicy(records);
  assert.equal(all.value instanceof Array ? all.value.length : -1, 2);
  assert.equal(all.analysis.conflicts.length, 1);
  assert.deepEqual(all.analysis.coverage.map((item) => item.source), ["FITBIT", "HEALTH_KIT"]);
  const apple = applySourcePolicy(records, { source: "HEALTH_KIT" });
  assert.equal((apple.value as unknown[]).length, 1);
  assert.equal((apple.value as any[])[0].dataSource.platform, "HEALTH_KIT");
});
