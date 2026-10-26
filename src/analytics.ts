import { metric } from "./catalog.js";

export type TrendSummary = {
  records: number;
  average?: number;
  minimum?: number;
  maximum?: number;
  first?: number;
  last?: number;
  percentChange?: number | null;
};

export type HealthSource = "FITBIT" | "HEALTH_KIT" | "all";
export type SourceOptions = {
  source?: HealthSource;
  sourcePriority?: Array<"FITBIT" | "HEALTH_KIT">;
  deduplicate?: boolean;
};
export type SourceCoverage = { source: string; records: number; first?: string; last?: string };
export type SourceConflict = { timestamp: string; sources: string[]; records: number };
export type SourceAnalysis = {
  requestedSource: HealthSource;
  priority: string[];
  rawRecords: number;
  returnedRecords: number;
  duplicateRecordsRemoved: number;
  coverage: SourceCoverage[];
  conflicts: SourceConflict[];
};

export function assertTimezone(timezone: string): string {
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(); }
  catch { throw new Error(`Invalid IANA timezone: ${timezone}`); }
  return timezone;
}

export function civilDateInTimezone(timezone = "UTC", now = new Date()): string {
  assertTimezone(timezone);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function extractNumbers(value: unknown, prefix = ""): Record<string, number> {
  if (typeof value === "number" && Number.isFinite(value)) return { [prefix || "value"]: value };
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return { [prefix || "value"]: Number(value) };
  if (!value || typeof value !== "object") return {};
  return Object.entries(value).reduce<Record<string, number>>((result, [key, child]) => {
    if (["civilStartTime", "civilEndTime", "interval", "date", "time", "startTime", "endTime", "createTime", "updateTime"].includes(key)) return result;
    return { ...result, ...extractNumbers(child, prefix ? `${prefix}.${key}` : key) };
  }, {});
}

export function trend(values: number[]): TrendSummary {
  if (!values.length) return { records: 0 };
  const first = values[0];
  const last = values.at(-1)!;
  return {
    records: values.length,
    average: values.reduce((sum, value) => sum + value, 0) / values.length,
    minimum: Math.min(...values), maximum: Math.max(...values), first, last,
    percentChange: first === 0 ? null : ((last - first) / Math.abs(first)) * 100
  };
}

function replaceNumbers(value: unknown, transform: (key: string, value: number) => unknown, key = ""): unknown {
  if (typeof value === "number") return transform(key, value);
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return transform(key, Number(value));
  if (Array.isArray(value)) return value.map((item) => replaceNumbers(item, transform, key));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, replaceNumbers(child, transform, childKey)]));
}

export function normalizeMetric(dataType: string, raw: unknown): unknown {
  metric(dataType);
  return replaceNumbers(raw, (key, value) => {
    if (key === "millimetersSum" || key === "millimeters") return { value, kilometers: value / 1_000_000, miles: value / 1_609_344 };
    if (key === "weightGrams" || key === "weightGramsAvg") return { grams: value, kilograms: value / 1_000, pounds: value / 453.59237 };
    if (key === "kcalSum") return { kilocalories: value };
    if (key === "minutesAsleep" || key === "minutesAwake" || key === "minutesInSleepPeriod") return { minutes: value, hours: value / 60 };
    return value;
  });
}

function recordsFor(raw: unknown): { records: unknown[]; wrapper?: Record<string, unknown> } {
  if (Array.isArray(raw)) return { records: raw };
  if (raw && typeof raw === "object" && Array.isArray((raw as { rollupDataPoints?: unknown[] }).rollupDataPoints)) {
    return { records: (raw as { rollupDataPoints: unknown[] }).rollupDataPoints, wrapper: raw as Record<string, unknown> };
  }
  return { records: [], wrapper: raw && typeof raw === "object" ? raw as Record<string, unknown> : undefined };
}

function sourceOf(record: unknown): string {
  const source = (record as { dataSource?: { platform?: string; application?: { packageName?: string } } })?.dataSource;
  return source?.platform?.toUpperCase() ?? source?.application?.packageName ?? "unknown";
}

function timestampOf(record: unknown): string | undefined {
  function find(value: unknown, depth = 0): string | undefined {
    if (!value || typeof value !== "object" || depth > 4) return undefined;
    const root = value as Record<string, any>;
    const candidates = [root.interval?.startTime, root.interval?.civilStartTime, root.sampleTime?.physicalTime, root.sampleTime?.civilTime, root.civilStartTime, root.date];
    for (const candidate of candidates) {
      if (typeof candidate === "string") return candidate;
      if (candidate?.year) {
        const date = candidate;
        return date.year + "-" + String(date.month).padStart(2, "0") + "-" + String(date.day).padStart(2, "0") + "T00:00:00";
      }
      if (candidate?.date?.year) {
        const date = candidate.date;
        const time = candidate.time ?? {};
        return date.year + "-" + String(date.month).padStart(2, "0") + "-" + String(date.day).padStart(2, "0") + "T" + String(time.hours ?? 0).padStart(2, "0") + ":" + String(time.minutes ?? 0).padStart(2, "0") + ":" + String(time.seconds ?? 0).padStart(2, "0");
      }
    }
    for (const [key, child] of Object.entries(root)) if (key !== "dataSource") {
      const found = find(child, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  const found = find(record);
  if (found) return found;
  return record && typeof record === "object" && typeof (record as { name?: unknown }).name === "string" ? (record as { name: string }).name : undefined;
}

function stableValue(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stableValue).sort().join(",") + "]";
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return "{" + Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !["dataSource", "name", "createTime", "updateTime"].includes(key))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => JSON.stringify(key) + ":" + stableValue(child)).join(",") + "}";
}

function sourceRank(source: string, priority: string[]): number {
  const index = priority.findIndex((item) => item.toUpperCase() === source.toUpperCase());
  return index === -1 ? priority.length : index;
}

export function applySourcePolicy(raw: unknown, options: SourceOptions = {}): { value: unknown; analysis: SourceAnalysis } {
  const requestedSource = options.source ?? "all";
  const priority = options.sourcePriority ?? ["FITBIT", "HEALTH_KIT"];
  const { records, wrapper } = recordsFor(raw);
  const coverageMap = new Map<string, SourceCoverage>();
  for (const record of records) {
    const source = sourceOf(record);
    const timestamp = timestampOf(record);
    const current = coverageMap.get(source) ?? { source, records: 0 };
    current.records += 1;
    if (timestamp && (!current.first || timestamp < current.first)) current.first = timestamp;
    if (timestamp && (!current.last || timestamp > current.last)) current.last = timestamp;
    coverageMap.set(source, current);
  }
  const conflictsByTimestamp = new Map<string, Set<string>>();
  const fingerprintsByTimestamp = new Map<string, Set<string>>();
  for (const record of records) {
    const timestamp = timestampOf(record) ?? "unknown";
    const sources = conflictsByTimestamp.get(timestamp) ?? new Set<string>();
    sources.add(sourceOf(record)); conflictsByTimestamp.set(timestamp, sources);
    const fingerprints = fingerprintsByTimestamp.get(timestamp) ?? new Set<string>();
    fingerprints.add(stableValue(record)); fingerprintsByTimestamp.set(timestamp, fingerprints);
  }
  const conflicts: SourceConflict[] = [...conflictsByTimestamp]
    .filter(([timestamp, sources]) => sources.size > 1 && (fingerprintsByTimestamp.get(timestamp)?.size ?? 0) > 1)
    .map(([timestamp, sources]) => ({ timestamp, sources: [...sources], records: records.filter((record) => (timestampOf(record) ?? "unknown") === timestamp).length }));
  let selected = requestedSource === "all" ? [...records] : records.filter((record) => sourceOf(record).toUpperCase() === requestedSource);
  let duplicateRecordsRemoved = 0;
  const groups = new Map<string, unknown[]>();
  for (const record of selected) {
    const key = (timestampOf(record) ?? "unknown") + "|" + stableValue(record);
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  selected = [...groups.values()].map((group) => {
    duplicateRecordsRemoved += group.length - 1;
    return group.sort((a, b) => sourceRank(sourceOf(a), priority) - sourceRank(sourceOf(b), priority))[0];
  });
  if (requestedSource === "all") {
    const byTimestamp = new Map<string, unknown[]>();
    for (const record of selected) {
      const timestamp = timestampOf(record) ?? "unknown";
      byTimestamp.set(timestamp, [...(byTimestamp.get(timestamp) ?? []), record]);
    }
    selected = [...byTimestamp.values()].flatMap((group) => {
      if (new Set(group.map(sourceOf)).size > 1 && new Set(group.map(stableValue)).size > 1) {
        duplicateRecordsRemoved += group.length - 1;
        return [group.sort((a, b) => sourceRank(sourceOf(a), priority) - sourceRank(sourceOf(b), priority))[0]];
      }
      return group;
    });
  }
  const value = wrapper ? { ...wrapper, rollupDataPoints: selected } : Array.isArray(raw) ? selected : raw;
  return { value, analysis: { requestedSource, priority, rawRecords: records.length, returnedRecords: selected.length, duplicateRecordsRemoved, coverage: [...coverageMap.values()], conflicts } };
}

export function provenance(dataType: string, raw: unknown): { dataType: string; recordCount: number; sources: string[]; normalizedUnit: string } {
  const records = Array.isArray(raw) ? raw : ((raw as { rollupDataPoints?: unknown[] })?.rollupDataPoints ?? []);
  const sources = [...new Set(records.map((record) => {
    const source = (record as { dataSource?: { platform?: string; application?: { packageName?: string } } }).dataSource;
    return source?.platform ?? source?.application?.packageName ?? "unknown";
  }))];
  return { dataType, recordCount: records.length, sources, normalizedUnit: metric(dataType).unit };
}

export function sleepTotals(records: unknown[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const record of records) {
    const stages = (record as { sleep?: { summary?: { stagesSummary?: Array<{ type?: string; minutes?: string | number }> } } }).sleep?.summary?.stagesSummary ?? [];
    for (const stage of stages) if (stage.type && stage.minutes != null) totals[stage.type] = (totals[stage.type] ?? 0) + Number(stage.minutes);
  }
  return totals;
}
