import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { METRICS, metric } from "./catalog.js";
import { GoogleHealthClient, GoogleHealthApiError } from "./google-health.js";
import { addDays, applySourcePolicy, assertTimezone, civilDateInTimezone, extractNumbers, normalizeMetric, provenance, sleepTotals, trend, type HealthSource, type SourceAnalysis } from "./analytics.js";

function json(value: unknown) {
  const structured = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : { items: value };
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], structuredContent: structured };
}

export function createServer(health: GoogleHealthClient): McpServer {
const server = new McpServer({ name: "google-health-mcp", version: "0.2.0" });

const CORE_METRICS = ["steps", "distance", "total-calories", "active-energy-burned", "heart-rate", "sleep", "weight", "body-fat"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SOURCE_VALUES = ["FITBIT", "HEALTH_KIT", "all"] as const;
const SOURCE_PRIORITY_VALUES = ["FITBIT", "HEALTH_KIT"] as const;
const sourceInputSchema = {
  source: z.enum(SOURCE_VALUES).optional().default("all").describe("Source filter: FITBIT, HEALTH_KIT, or all"),
  source_priority: z.array(z.enum(SOURCE_PRIORITY_VALUES)).min(1).max(2).optional().default(["FITBIT", "HEALTH_KIT"]).describe("Priority used when sources conflict"),
  deduplicate: z.boolean().optional().default(true).describe("Remove exact duplicates and resolve same-time cross-source conflicts using source_priority")
};

function validateRange(start: string, end: string, maxDays = 90): void {
  if (!DATE_RE.test(start.slice(0, 10)) || !DATE_RE.test(end.slice(0, 10))) throw new Error("start and end must be ISO dates such as 2026-08-01");
  const startDate = new Date(`${start.slice(0, 10)}T00:00:00Z`);
  const endDate = new Date(`${end.slice(0, 10)}T00:00:00Z`);
  const days = (endDate.getTime() - startDate.getTime()) / 86_400_000;
  if (!Number.isFinite(days) || days <= 0) throw new Error("end must be after start");
  if (days > maxDays) throw new Error(`date range cannot exceed ${maxDays} days`);
}

function isoDateDaysAgo(days: number, timezone = "UTC"): { start: string; end: string; timezone: string } {
  assertTimezone(timezone);
  const end = civilDateInTimezone(timezone);
  return { start: addDays(end, -days), end, timezone };
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function hasRecords(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (!value || typeof value !== "object") return value != null;
  const candidate = value as { dataPoints?: unknown[]; rollupDataPoints?: unknown[] };
  if (Array.isArray(candidate.dataPoints)) return candidate.dataPoints.length > 0;
  if (Array.isArray(candidate.rollupDataPoints)) return candidate.rollupDataPoints.length > 0;
  return Object.keys(value).length > 0;
}

type MetricRead = { value: unknown; source: SourceAnalysis };

async function readMetric(dataType: string, start: string, end: string, aggregateDaily: boolean, source: HealthSource = "all", sourcePriority: Array<"FITBIT" | "HEALTH_KIT"> = ["FITBIT", "HEALTH_KIT"], deduplicate = true): Promise<MetricRead> {
  const definition = metric(dataType);
  let raw: unknown;
  if (aggregateDaily && definition.dailyRollup && source === "all") {
    raw = await health.dailyRollup(dataType, start, end);
  } else {
    try {
      raw = await health.listDataPoints(dataType, start, end);
    } catch (error) {
      if (definition.dailyRollup && error instanceof GoogleHealthApiError && error.code === "FILTER_NOT_SUPPORTED") raw = await health.dailyRollup(dataType, start, end);
      else throw error;
    }
  }
  const policy = applySourcePolicy(raw, { source, sourcePriority, deduplicate });
  return { value: policy.value, source: policy.analysis };
}

function summarizeSleep(records: unknown): unknown {
  if (!Array.isArray(records)) return records;
  return records.map((record) => {
    const sleep = (record as { sleep?: { interval?: unknown; summary?: unknown } }).sleep;
    return { interval: sleep?.interval, summary: sleep?.summary };
  });
}

server.registerTool("list_available_metrics", {
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  description: "List Google Health API v4 data types available through this Fitbit-synced Google Health integration. This is not a direct Fitbit Web API catalog.",
  inputSchema: {}
}, async () => json(METRICS));

server.registerTool("get_data_source_info", {
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  description: "Explain exactly where this server gets health data, which API it uses, its read-only boundaries, and known availability limitations. Call this before interpreting metric results.",
  inputSchema: {}
}, async () => json({
  integration: "Fitbit-synced Google Health MCP",
  server: "google-health-mcp",
  deviceProvider: "Fitbit, when Fitbit data is synced into the connected Google Health account",
  apiProvider: "Google Health API v4",
  directFitbitWebApi: false,
  transport: "stdio",
  access: "read-only",
  writes: false,
  dataPath: "Fitbit device/app -> connected Google Health account -> this MCP",
  sourceMetadata: "Each returned record may identify its actual source platform, such as FITBIT_WEB_API or HEALTH_KIT.",
  limitations: [
    "Metric availability depends on device, account, country, permissions, and recent sync.",
    "Some daily HRV, resting-heart-rate, oxygen-saturation, respiratory-rate, temperature, ECG, and nutrition types may be exposed in the catalog but rejected by Google Health filters.",
    "Unavailable metrics are returned explicitly and must not be interpreted as zero.",
    "This server does not call the direct Fitbit Web API yet."
  ],
  agentGuidance: "Describe results as Fitbit-sourced or Fitbit-synced Google Health data according to each record's source metadata; do not claim that every metric came directly from Fitbit's Web API.",
  checkedAt: new Date().toISOString()
}));

server.registerTool("get_metrics", {
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  description: "Read one or more Google Health API v4 metric types for a date/time range. Use list_available_metrics for supported names. Returns raw normalized API records and source metadata.",
  inputSchema: {
    data_types: z.array(z.string()).min(1).describe("Google Health data type names, for example steps, heart-rate, sleep, oxygen-saturation"),
    start: z.string().describe("ISO-8601 start date/time, for example 2026-07-01"),
    end: z.string().describe("ISO-8601 exclusive end date/time, for example 2026-07-02"),
    aggregate_daily: z.boolean().optional().default(false).describe("Use daily rollups where supported instead of raw points"),
    ...sourceInputSchema
  }
}, async ({ data_types, start, end, aggregate_daily, source, source_priority, deduplicate }) => {
  validateRange(start, end);
  const result: Record<string, unknown> = {};
  const metadata: Record<string, unknown> = {};
  for (const dataType of data_types) {
    try {
      const read = await readMetric(dataType, start, end, aggregate_daily, source, source_priority, deduplicate);
      result[dataType] = read.value;
      metadata[dataType] = { ...provenance(dataType, read.value), sourceAnalysis: read.source };
    } catch (error) {
      result[dataType] = { unavailable: errorText(error) };
      metadata[dataType] = { dataType, available: false, error: errorText(error) };
    }
  }
  return json({ start, end, source: "Fitbit via Google Health API v4", metrics: result, metadata });
});

server.registerTool("get_recent_metrics", {
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  description: "Read recent Fitbit metrics with a safe default 7-day range. Each metric is isolated so unsupported or unavailable types do not fail the whole response.",
  inputSchema: {
    days: z.number().int().min(1).max(90).optional().default(7).describe("Number of recent days"),
    data_types: z.array(z.string()).min(1).max(39).optional().default(CORE_METRICS).describe("Metric types; defaults to the core health snapshot set"),
    aggregate_daily: z.boolean().optional().default(true).describe("Use daily rollups where supported"),
    timezone: z.string().optional().default("UTC").describe("IANA timezone used to determine the civil date range"),
    ...sourceInputSchema
  }
}, async ({ days, data_types, aggregate_daily, timezone, source, source_priority, deduplicate }) => {
  const { start, end } = isoDateDaysAgo(days, timezone);
  const metrics: Record<string, unknown> = {};
  const metadata: Record<string, unknown> = {};
  for (const dataType of data_types) {
    try {
      const read = await readMetric(dataType, start, end, aggregate_daily, source, source_priority, deduplicate);
      metrics[dataType] = read.value;
      metadata[dataType] = { ...provenance(dataType, read.value), sourceAnalysis: read.source };
    } catch (error) { metrics[dataType] = { unavailable: errorText(error) }; metadata[dataType] = { dataType, available: false, error: errorText(error) }; }
  }
  return json({ start, end, days, timezone, source: "Fitbit via Google Health API v4", metrics, metadata });
});

server.registerTool("get_health_snapshot", {
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  description: "Return a compact current-day Fitbit snapshot including activity, heart rate, body composition, sleep, freshness, and unavailable metrics.",
  inputSchema: {
    date: z.string().optional().describe("Civil date in YYYY-MM-DD format; defaults to today"),
    timezone: z.string().optional().default("UTC").describe("IANA timezone used when date is omitted"),
    ...sourceInputSchema
  }
}, async ({ date, timezone, source, source_priority, deduplicate }) => {
  if (date && !DATE_RE.test(date)) throw new Error("date must be an ISO date such as 2026-08-01");
  const target = date ?? civilDateInTimezone(timezone);
  const next = new Date(`${target}T00:00:00Z`); next.setUTCDate(next.getUTCDate() + 1);
  const end = next.toISOString().slice(0, 10);
  validateRange(target, end, 1);
  const metrics: Record<string, unknown> = {};
  for (const dataType of CORE_METRICS) {
    try {
      const read = await readMetric(dataType, target, end, true, source, source_priority, deduplicate);
      metrics[dataType] = { raw: dataType === "sleep" ? summarizeSleep(read.value) : read.value, normalized: normalizeMetric(dataType, read.value), provenance: provenance(dataType, read.value), sourceAnalysis: read.source };
    } catch (error) { metrics[dataType] = { unavailable: errorText(error) }; }
  }
  return json({ date: target, timezone, checkedAt: new Date().toISOString(), source: "Fitbit via Google Health API v4", metrics });
});

server.registerTool("get_trends", {
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  description: "Calculate numeric trend summaries for recent Fitbit metrics: count, average, minimum, maximum, first value, last value, and percent change where possible.",
  inputSchema: {
    days: z.number().int().min(2).max(90).optional().default(7),
    data_types: z.array(z.string()).min(1).max(10).default(["steps", "distance", "active-energy-burned", "heart-rate", "weight"]),
    timezone: z.string().optional().default("UTC"),
    ...sourceInputSchema
  }
}, async ({ days, data_types, timezone, source, source_priority, deduplicate }) => {
  const { start, end } = isoDateDaysAgo(days, timezone);
  const trends: Record<string, unknown> = {};
  for (const dataType of data_types) {
    try {
      const read = await readMetric(dataType, start, end, true, source, source_priority, deduplicate);
      const raw = read.value;
      const points = Array.isArray(raw) ? raw : (raw as { rollupDataPoints?: unknown[] }).rollupDataPoints ?? [];
      const values = points.flatMap((point) => Object.values(extractNumbers(point))).filter((value) => Number.isFinite(value));
      trends[dataType] = { ...trend(values), provenance: provenance(dataType, raw), sourceAnalysis: read.source, normalizedUnit: metric(dataType).unit };
    } catch (error) { trends[dataType] = { unavailable: errorText(error) }; }
  }
  return json({ start, end, days, timezone, trends });
});

server.registerTool("get_sleep_summary", {
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  description: "Return normalized sleep sessions and stage totals for a recent date range.",
  inputSchema: { days: z.number().int().min(1).max(90).optional().default(7), timezone: z.string().optional().default("UTC"), ...sourceInputSchema }
}, async ({ days, timezone, source, source_priority, deduplicate }) => {
  const { start, end } = isoDateDaysAgo(days, timezone);
  try {
    const read = await readMetric("sleep", start, end, false, source, source_priority, deduplicate);
    const records = read.value as unknown[];
    const sessions = summarizeSleep(records) as Array<{ summary?: { minutesAsleep?: string; minutesAwake?: string; stagesSummary?: Array<{ type: string; minutes: string }> } }>;
    const totals = sleepTotals(records);
    return json({ start, end, timezone, sessions, totals, sessionCount: sessions.length, sourceAnalysis: read.source, informationalOnly: true });
  } catch (error) { return json({ start, end, timezone, sessions: [], unavailable: errorText(error) }); }
});

server.registerTool("compare_periods", {
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  description: "Compare a recent period with the immediately preceding period using daily numeric values and percent changes.",
  inputSchema: {
    days: z.number().int().min(2).max(90).optional().default(7),
    data_types: z.array(z.string()).min(1).max(10).default(["steps", "distance", "active-energy-burned", "heart-rate", "weight"]),
    timezone: z.string().optional().default("UTC"),
    ...sourceInputSchema
  }
}, async ({ days, data_types, timezone, source, source_priority, deduplicate }) => {
  const current = isoDateDaysAgo(days, timezone);
  const previous = { start: addDays(current.start, -days), end: current.start };
  const comparison: Record<string, unknown> = {};
  for (const dataType of data_types) {
    try {
      const [currentRead, previousRead] = await Promise.all([readMetric(dataType, current.start, current.end, true, source, source_priority, deduplicate), readMetric(dataType, previous.start, previous.end, true, source, source_priority, deduplicate)]);
      const currentRaw = currentRead.value;
      const previousRaw = previousRead.value;
      const currentPoints = Array.isArray(currentRaw) ? currentRaw : (currentRaw as { rollupDataPoints?: unknown[] }).rollupDataPoints ?? [];
      const previousPoints = Array.isArray(previousRaw) ? previousRaw : (previousRaw as { rollupDataPoints?: unknown[] }).rollupDataPoints ?? [];
      const currentTrend = trend(currentPoints.flatMap((point) => Object.values(extractNumbers(point))));
      const previousTrend = trend(previousPoints.flatMap((point) => Object.values(extractNumbers(point))));
      comparison[dataType] = { current: currentTrend, previous: previousTrend, averageChange: currentTrend.average != null && previousTrend.average ? ((currentTrend.average - previousTrend.average) / Math.abs(previousTrend.average)) * 100 : null, normalizedUnit: metric(dataType).unit, sourceAnalysis: { current: currentRead.source, previous: previousRead.source } };
    } catch (error) { comparison[dataType] = { unavailable: errorText(error) }; }
  }
  return json({ current, previous, timezone, comparison, informationalOnly: true });
});

server.registerTool("get_data_quality", {
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  description: "Diagnose recent Fitbit data coverage, missing records, source provenance, and API-limited metrics without treating missing data as zero.",
  inputSchema: {
    days: z.number().int().min(1).max(90).optional().default(7),
    data_types: z.array(z.string()).min(1).max(39).optional().default(METRICS.map(({ dataType }) => dataType)),
    timezone: z.string().optional().default("UTC"),
    ...sourceInputSchema
  }
}, async ({ days, data_types, timezone, source, source_priority, deduplicate }) => {
  const { start, end } = isoDateDaysAgo(days, timezone);
  const report: Record<string, unknown> = {};
  let available = 0; let empty = 0; let unavailable = 0;
  for (const dataType of data_types) {
    try {
      const read = await readMetric(dataType, start, end, true, source, source_priority, deduplicate);
      const raw = read.value;
      const info = provenance(dataType, raw);
      if (info.recordCount > 0) available += 1; else empty += 1;
      report[dataType] = { status: info.recordCount > 0 ? "ok" : "no-data", ...info, sourceAnalysis: read.source };
    } catch (error) { unavailable += 1; report[dataType] = { status: "unavailable", dataType, error: errorText(error) }; }
  }
  return json({ start, end, days, timezone, summary: { requested: data_types.length, available, noData: empty, unavailable }, metrics: report });
});

async function groupedSummary(name: string, data_types: string[], days: number, timezone: string, source: HealthSource, sourcePriority: Array<"FITBIT" | "HEALTH_KIT">, deduplicate: boolean) {
  const range = isoDateDaysAgo(days, timezone);
  const metrics: Record<string, unknown> = {};
  for (const dataType of data_types) {
    try {
      const read = await readMetric(dataType, range.start, range.end, true, source, sourcePriority, deduplicate);
      const raw = read.value;
      const points = Array.isArray(raw) ? raw : (raw as { rollupDataPoints?: unknown[] }).rollupDataPoints ?? [];
      metrics[dataType] = { raw, normalized: normalizeMetric(dataType, raw), trend: trend(points.flatMap((point) => Object.values(extractNumbers(point)))), provenance: provenance(dataType, raw), sourceAnalysis: read.source };
    } catch (error) { metrics[dataType] = { unavailable: errorText(error) }; }
  }
  return { name, ...range, timezone, metrics, informationalOnly: true };
}

server.registerTool("get_activity_summary", {
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  description: "Summarize recent movement, distance, calories, floors, and heart-rate-zone activity.",
  inputSchema: { days: z.number().int().min(1).max(90).optional().default(7), timezone: z.string().optional().default("UTC"), ...sourceInputSchema }
}, async ({ days, timezone, source, source_priority, deduplicate }) => json(await groupedSummary("activity", ["steps", "distance", "total-calories", "active-energy-burned", "floors", "active-minutes", "active-zone-minutes", "heart-rate"], days, timezone, source, source_priority, deduplicate)));

server.registerTool("get_recovery_summary", {
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  description: "Summarize sleep, heart rate, HRV, oxygen saturation, and respiratory-rate data for informational recovery context.",
  inputSchema: { days: z.number().int().min(1).max(90).optional().default(7), timezone: z.string().optional().default("UTC"), ...sourceInputSchema }
}, async ({ days, timezone, source, source_priority, deduplicate }) => json(await groupedSummary("recovery", ["sleep", "heart-rate", "heart-rate-variability", "daily-heart-rate-variability", "daily-resting-heart-rate", "oxygen-saturation", "daily-oxygen-saturation", "daily-respiratory-rate"], days, timezone, source, source_priority, deduplicate)));

server.registerTool("get_body_metrics", {
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  description: "Summarize recent weight, body-fat, temperature, height, and blood-glucose records with normalized units and source metadata.",
  inputSchema: { days: z.number().int().min(1).max(90).optional().default(30), timezone: z.string().optional().default("UTC"), ...sourceInputSchema }
}, async ({ days, timezone, source, source_priority, deduplicate }) => json(await groupedSummary("body", ["weight", "body-fat", "core-body-temperature", "daily-sleep-temperature-derivations", "height", "blood-glucose"], days, timezone, source, source_priority, deduplicate)));

server.registerTool("get_sync_status", {
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  description: "Check connected Fitbit/Google Health account metadata, paired devices, and whether core metrics have recent data.",
  inputSchema: sourceInputSchema
}, async ({ source, source_priority, deduplicate }) => {
  const { start, end } = isoDateDaysAgo(2);
  const availability: Record<string, unknown> = {};
  for (const dataType of ["steps", "heart-rate", "sleep", "weight", "body-fat"]) {
    try {
      const read = await readMetric(dataType, start, end, true, source, source_priority, deduplicate);
      availability[dataType] = { available: Array.isArray(read.value) ? read.value.length > 0 : Object.keys(read.value as object).length > 0, sourceAnalysis: read.source };
    } catch (error) { availability[dataType] = { available: false, error: errorText(error) }; }
  }
  const [profile, devices] = await Promise.allSettled([health.profile(), health.pairedDevices()]);
  return json({ checkedAt: new Date().toISOString(), range: { start, end }, profile: profile.status === "fulfilled" ? profile.value : { unavailable: errorText(profile.reason) }, devices: devices.status === "fulfilled" ? devices.value : { unavailable: errorText(devices.reason) }, availability });
});

server.registerTool("get_profile", {
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  description: "Read the connected Google Health/Fitbit profile and identity metadata.", inputSchema: {}
}, async () => json({ profile: await health.profile(), identity: await health.identity() }));

server.registerTool("get_devices", {
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  description: "List devices paired with the connected Google Health account, including the Fitbit Air when exposed by the account.", inputSchema: {}
}, async () => json(await health.pairedDevices()));

server.registerTool("get_settings", {
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  description: "Read connected Fitbit/Google Health settings and configured preferences.", inputSchema: {}
}, async () => json(await health.settings()));

server.registerTool("get_daily_summary", {
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  description: "Read the most useful daily Fitbit metrics in one call: steps, calories, distance, active minutes, active zone minutes, resting heart rate, HRV, oxygen saturation, respiratory rate, sleep, and weight where available.",
  inputSchema: { date: z.string().describe("Civil date in YYYY-MM-DD format"), ...sourceInputSchema }
}, async ({ date, source, source_priority, deduplicate }) => {
  if (!DATE_RE.test(date)) throw new Error("date must be an ISO date such as 2026-08-01");
  const start = `${date}T00:00:00Z`;
  const next = new Date(`${date}T00:00:00Z`); next.setUTCDate(next.getUTCDate() + 1);
  validateRange(date, next.toISOString().slice(0, 10), 1);
  const end = next.toISOString();
  const types = ["steps", "total-calories", "distance", "active-minutes", "active-zone-minutes", "daily-resting-heart-rate", "daily-heart-rate-variability", "daily-oxygen-saturation", "daily-respiratory-rate", "sleep", "weight"];
  const metrics: Record<string, unknown> = {};
  const metadata: Record<string, unknown> = {};
  for (const dataType of types) {
    try {
      const read = await readMetric(dataType, start, end, true, source, source_priority, deduplicate);
      metrics[dataType] = hasRecords(read.value) ? read.value : { noData: true };
      metadata[dataType] = { ...provenance(dataType, read.value), sourceAnalysis: read.source };
    } catch (error) {
      metrics[dataType] = { unavailable: errorText(error) };
      metadata[dataType] = { dataType, available: false, error: errorText(error) };
    }
  }
  return json({ date, source: "Fitbit via Google Health API v4", metrics, metadata });
});

return server;
}
