import { providerFetch } from "./provider-fetch.js";
import { metric, SCOPE_URLS } from "./catalog.js";
import { publicConnectionFailure } from "./connection-error.js";

const API_ROOT = "https://health.googleapis.com/v4";
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
type RecordKind = "interval" | "sample" | "daily" | "log" | "unknown";
type JsonObject = Record<string, unknown>;
export type AccessTokenProvider = () => Promise<string>;
export type GoogleHealthClientOptions = {
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
  maxPages?: number;
  maxPoints?: number;
};

/** Deliberately excludes provider bodies, URLs, tokens and underlying exceptions. */
export class GoogleHealthApiError extends Error {
  constructor(public readonly code: string, public readonly status?: number) {
    super(code === "RECONNECT_REQUIRED"
      ? "Reconnect Google Health to restore read-only access."
      : `Google Health request failed (${code}${status ? `; HTTP ${status}` : ""}).`);
    this.name = "GoogleHealthApiError";
  }
}

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}
function string(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function camelDataType(dataType: string): string {
  return dataType.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}
function civilMetric(dataType?: string): boolean { return dataType === "sleep" || dataType === "exercise"; }
function buildFilterField(dataType: string, recordKind: RecordKind): string {
  const apiName = camelDataType(dataType);
  if (recordKind === "daily") return `${apiName}.date`;
  if (recordKind === "sample") return `${apiName}.sample_time.physical_time`;
  if (dataType === "sleep") return `${apiName}.interval.civil_end_time`;
  if (recordKind === "log") return `${apiName}.interval.civil_start_time`;
  return `${apiName}.interval.start_time`;
}
function validBoundary(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(value)) {
    throw new GoogleHealthApiError("INVALID_DATE_RANGE");
  }
  const day = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== value.slice(0, 10)) {
    throw new GoogleHealthApiError("INVALID_DATE_RANGE");
  }
  const timestamp = value.length === 10 ? `${value}T00:00:00Z` : value.replace(/(?:Z|[+-]\d{2}:\d{2})?$/, (suffix) => suffix || "Z");
  if (!Number.isFinite(Date.parse(timestamp))) throw new GoogleHealthApiError("INVALID_DATE_RANGE");
}

export function filterBoundary(value: string, recordKind: string, dataType?: string): string {
  validBoundary(value);
  if (recordKind === "daily") return value.slice(0, 10);
  if (civilMetric(dataType)) return value.length === 10 ? `${value}T00:00:00` : value.replace(/(?:Z|[+-]\d{2}:\d{2})$/, "");
  return value.length === 10 ? `${value}T00:00:00Z` : /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? value : `${value}Z`;
}
function boundaryEpoch(value: string, recordKind: RecordKind, dataType: string): number {
  const boundary = filterBoundary(value, recordKind, dataType);
  return Date.parse(recordKind === "daily" ? `${boundary}T00:00:00Z` : civilMetric(dataType) ? `${boundary}Z` : boundary);
}
function civilTimeToIso(value: unknown): string | undefined {
  const root = object(value);
  const date = object(root?.date);
  if (typeof date?.year !== "number" || typeof date.month !== "number" || typeof date.day !== "number") return undefined;
  const time = object(root?.time);
  return `${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}T${String(time?.hours ?? 0).padStart(2, "0")}:${String(time?.minutes ?? 0).padStart(2, "0")}:${String(time?.seconds ?? 0).padStart(2, "0")}Z`;
}
function pointDateTime(dataType: string, recordKind: RecordKind, point: unknown): string | undefined {
  const root = object(object(point)?.[camelDataType(dataType)]);
  if (!root) return undefined;
  if (recordKind === "daily") return civilTimeToIso({ date: root.date });
  if (recordKind === "sample") {
    const sample = object(root.sampleTime);
    return string(sample?.physicalTime) ?? civilTimeToIso(sample?.civilTime);
  }
  const interval = object(root.interval);
  if (dataType === "sleep") return civilTimeToIso(interval?.civilEndTime) ?? string(interval?.endTime);
  if (dataType === "exercise") return civilTimeToIso(interval?.civilStartTime) ?? string(interval?.startTime);
  return string(interval?.startTime) ?? civilTimeToIso(interval?.civilStartTime) ?? string(interval?.endTime);
}
export function filterDataPointsByRange(dataType: string, recordKind: RecordKind, points: unknown[], start: string, end: string): unknown[] {
  const startTime = boundaryEpoch(start, recordKind, dataType);
  const endTime = boundaryEpoch(end, recordKind, dataType);
  if (endTime <= startTime) throw new GoogleHealthApiError("INVALID_DATE_RANGE");
  // Food catalog entries have no temporal value, and are explicitly catalog records.
  const timeless = ["food", "food-measurement-unit"].includes(dataType);
  return points.filter((point) => {
    if (timeless) return true;
    const pointTime = pointDateTime(dataType, recordKind, point);
    if (!pointTime) throw new GoogleHealthApiError("INCOMPLETE_TEMPORAL_COVERAGE");
    const timestamp = Date.parse(pointTime);
    if (!Number.isFinite(timestamp)) throw new GoogleHealthApiError("INCOMPLETE_TEMPORAL_COVERAGE");
    return timestamp >= startTime && timestamp < endTime;
  });
}
export function requiredScopes(): string[] {
  return [...new Set([...Object.values(SCOPE_URLS),
    "https://www.googleapis.com/auth/googlehealth.profile.readonly",
    "https://www.googleapis.com/auth/googlehealth.settings.readonly"])];
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new GoogleHealthApiError("RESPONSE_LIMIT_EXCEEDED");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new GoogleHealthApiError("INVALID_PROVIDER_RESPONSE");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new GoogleHealthApiError("RESPONSE_LIMIT_EXCEEDED");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new GoogleHealthApiError("INVALID_PROVIDER_RESPONSE"); }
}
function positiveInteger(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > max) throw new GoogleHealthApiError("INVALID_CLIENT_LIMIT");
  return value;
}

export class GoogleHealthClient {
  private readonly fetcher: typeof fetch;
  private readonly delay: (milliseconds: number) => Promise<void>;
  private readonly timeout: number;
  private readonly maxPages: number;
  private readonly maxPoints: number;
  constructor(private readonly accessToken: AccessTokenProvider, options: GoogleHealthClientOptions = {}) {
    this.fetcher = options.fetch ?? providerFetch();
    this.delay = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.timeout = positiveInteger(options.timeoutMs, 20_000, 20_000);
    this.maxPages = positiveInteger(options.maxPages, 50, 50);
    this.maxPoints = positiveInteger(options.maxPoints, 50_000, 50_000);
  }
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    // Prevent an API caller from sending owner authorization to any other origin or write endpoint.
    if (!/^\/users\/me\//.test(path) || path.includes("#") || path.includes("\\") || /(?:^|\/)\.\.(?:\/|\?|$)/.test(path)) {
      throw new GoogleHealthApiError("INVALID_API_PATH");
    }
    const url = new URL(`${API_ROOT}${path}`);
    const method = (init.method ?? "GET").toUpperCase();
    if (url.origin !== "https://health.googleapis.com" || !url.pathname.startsWith("/v4/users/me/") ||
      !(method === "GET" || method === "POST" && /^\/v4\/users\/me\/dataTypes\/[a-z-]+\/dataPoints:dailyRollUp$/.test(url.pathname))) {
      throw new GoogleHealthApiError("READ_ONLY_ENDPOINT_REQUIRED");
    }
    let token: string;
    try { token = await this.accessToken(); }
    catch (error) {
      const failure = publicConnectionFailure(error);
      throw new GoogleHealthApiError(failure.code, failure.status);
    }
    if (!token || /[\r\n]/.test(token)) throw new GoogleHealthApiError("RECONNECT_REQUIRED");
    for (let attempt = 0; attempt < 3; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeout);
      try {
        const headers = new Headers(init.headers);
        headers.set("Accept", "application/json");
        headers.set("Authorization", `Bearer ${token}`);
        if (init.body) headers.set("Content-Type", "application/json");
        const response = await this.fetcher(url.toString(), { ...init, method, headers, signal: controller.signal, redirect: "manual" });
        if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new GoogleHealthApiError("PROVIDER_REDIRECT_REFUSED", response.status); }
        if (response.ok) return await readBoundedJson(response) as T;
        if ([429, 500, 502, 503, 504].includes(response.status) && attempt < 2) {
          await response.body?.cancel();
          clearTimeout(timer);
          const retryAfter = Number(response.headers.get("retry-after"));
          await this.delay(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 2000) : 250 * 2 ** attempt);
          continue;
        }
        if (response.status === 401) { await response.body?.cancel(); throw new GoogleHealthApiError("RECONNECT_REQUIRED", 401); }
        // Compatibility fallback is limited to these documented provider markers.
        let compatibility = false;
        if (response.status === 400) {
          try {
            const payload = await readBoundedJson(response);
            const message = string(object(object(payload)?.error)?.message) ?? "";
            if (message.includes("ACCOUNT_NOT_LINKED")) throw new GoogleHealthApiError("ACCOUNT_NOT_LINKED", 400);
            compatibility = message.includes("INVALID_DATA_POINT_FILTER") || message.includes("List is not supported for data type");
          } catch (error) { if (error instanceof GoogleHealthApiError) throw error; /* Malformed provider text is never disclosed. */ }
        } else { await response.body?.cancel(); }
        throw new GoogleHealthApiError(compatibility ? "FILTER_NOT_SUPPORTED" : response.status === 403 ? "ACCESS_DENIED" : response.status === 429 ? "RATE_LIMITED" : "PROVIDER_ERROR", response.status);
      } catch (error) {
        if (error instanceof GoogleHealthApiError) throw error;
        throw new GoogleHealthApiError(controller.signal.aborted ? "REQUEST_TIMEOUT" : "NETWORK_ERROR");
      } finally { clearTimeout(timer); }
    }
    throw new GoogleHealthApiError("PROVIDER_ERROR");
  }
  profile(): Promise<unknown> { return this.request("/users/me/profile"); }
  identity(): Promise<unknown> { return this.request("/users/me/identity"); }
  settings(): Promise<unknown> { return this.request("/users/me/settings"); }
  pairedDevices(): Promise<unknown> { return this.request("/users/me/pairedDevices"); }
  async listDataPoints(dataType: string, start: string, end: string, pageSize = 1000): Promise<unknown[]> {
    const definition = metric(dataType);
    const size = positiveInteger(pageSize, 1000, 1000);
    const startBoundary = filterBoundary(start, definition.recordKind, dataType);
    const endBoundary = filterBoundary(end, definition.recordKind, dataType);
    if (boundaryEpoch(end, definition.recordKind, dataType) <= boundaryEpoch(start, definition.recordKind, dataType)) throw new GoogleHealthApiError("INVALID_DATE_RANGE");
    const field = buildFilterField(dataType, definition.recordKind);
    try { return await this.listPages(dataType, `${field} >= "${startBoundary}" AND ${field} < "${endBoundary}"`, size); }
    catch (error) {
      if (!(error instanceof GoogleHealthApiError) || error.code !== "FILTER_NOT_SUPPORTED") throw error;
      return filterDataPointsByRange(dataType, definition.recordKind, await this.listPages(dataType, undefined, size), start, end);
    }
  }
  private async listPages(dataType: string, filter: string | undefined, pageSize: number): Promise<unknown[]> {
    const points: unknown[] = [];
    let retainedBytes=0;
    const seen = new Set<string>();
    let pageToken = "";
    for (let page = 0; page < this.maxPages; page++) {
      const params = new URLSearchParams({ page_size: String(pageSize) });
      if (filter) params.set("filter", filter);
      if (pageToken) params.set("page_token", pageToken);
      const result = await this.request<unknown>(`/users/me/dataTypes/${dataType}/dataPoints?${params}`);
      const payload = object(result);
      if (!payload || (payload.dataPoints !== undefined && !Array.isArray(payload.dataPoints)) ||
        (payload.nextPageToken !== undefined && typeof payload.nextPageToken !== "string")) throw new GoogleHealthApiError("INVALID_PROVIDER_RESPONSE");
      const pagePoints = payload.dataPoints as unknown[] | undefined ?? [];
      if (points.length + pagePoints.length > this.maxPoints) throw new GoogleHealthApiError("POINT_LIMIT_EXCEEDED");
      retainedBytes += new TextEncoder().encode(JSON.stringify(pagePoints)).byteLength;
      if (retainedBytes > 8 * 1024 * 1024) throw new GoogleHealthApiError("RESULT_LIMIT_EXCEEDED");
      points.push(...pagePoints);
      pageToken = string(payload.nextPageToken) ?? "";
      if (!pageToken) return points;
      if (seen.has(pageToken)) throw new GoogleHealthApiError("PAGINATION_CYCLE");
      seen.add(pageToken);
    }
    throw new GoogleHealthApiError("PAGE_LIMIT_EXCEEDED");
  }
  async dailyRollup(dataType: string, start: string, end: string): Promise<unknown> {
    if (!metric(dataType).dailyRollup) throw new GoogleHealthApiError("DAILY_ROLLUP_NOT_SUPPORTED");
    const first = filterBoundary(start, "daily", dataType);
    const last = filterBoundary(end, "daily", dataType);
    if (first >= last) throw new GoogleHealthApiError("INVALID_DATE_RANGE");
    const [sy, sm, sd] = first.split("-").map(Number);
    const [ey, em, ed] = last.split("-").map(Number);
    return this.request(`/users/me/dataTypes/${dataType}/dataPoints:dailyRollUp`, { method: "POST", body: JSON.stringify({
      range: { start: { date: { year: sy, month: sm, day: sd } }, end: { date: { year: ey, month: em, day: ed } } }, windowSizeDays: 1
    }) });
  }
}
