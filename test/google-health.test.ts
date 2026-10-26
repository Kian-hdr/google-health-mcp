import test from "node:test";
import assert from "node:assert/strict";
import { GoogleHealthClient, GoogleHealthApiError, filterBoundary, filterDataPointsByRange, requiredScopes } from "../src/google-health.js";

const json = (body: unknown, status = 200, headers?: HeadersInit) => new Response(JSON.stringify(body), { status, headers });
const client = (fetcher: typeof fetch, options = {}) => new GoogleHealthClient(async () => "private-test-token", { fetch: fetcher, sleep: async () => {}, ...options });
const failure = (code: string) => (error: unknown) => error instanceof GoogleHealthApiError && error.code === code;

test("eight read-only scopes, ordinary offsets and intraday civil boundaries", () => {
  assert.equal(requiredScopes().length, 8);
  assert.ok(requiredScopes().every((scope) => scope.endsWith(".readonly")));
  assert.equal(filterBoundary("2026-07-30", "sample", "heart-rate"), "2026-07-30T00:00:00Z");
  assert.equal(filterBoundary("2026-07-30T10:15:00+02:00", "sample", "heart-rate"), "2026-07-30T10:15:00+02:00");
  assert.equal(filterBoundary("2026-07-30T10:15:00+02:00", "log", "sleep"), "2026-07-30T10:15:00");
  assert.equal(filterBoundary("2026-07-30", "log", "exercise"), "2026-07-30T00:00:00");
  assert.throws(() => filterBoundary("2026-02-30", "daily"), failure("INVALID_DATE_RANGE"));
});

test("range filtering honors intraday windows, offsets and exclusive end", () => {
  const points = [8, 9, 10].map((hour) => ({ heartRate: { sampleTime: { physicalTime: `2026-07-30T${String(hour).padStart(2, "0")}:00:00Z` } } }));
  assert.deepEqual(filterDataPointsByRange("heart-rate", "sample", points, "2026-07-30T11:00:00+02:00", "2026-07-30T12:00:00+02:00"), [points[1]]);
  assert.throws(() => filterDataPointsByRange("heart-rate", "sample", [{}], "2026-07-30", "2026-07-31"), failure("INCOMPLETE_TEMPORAL_COVERAGE"));
});

test("sleep civil end and daily date fallback retain correct records", () => {
  const points = [8, 9, 10].map((hour) => ({ sleep: { interval: { civilEndTime: { date: { year: 2026, month: 7, day: 30 }, time: { hours: hour } } } } }));
  assert.deepEqual(filterDataPointsByRange("sleep", "log", points, "2026-07-30T09:00:00+02:00", "2026-07-30T10:00:00+02:00"), [points[1]]);
  const daily = [{ dailyVo2Max: { date: { year: 2026, month: 8, day: 1 } } }, { dailyVo2Max: { date: { year: 2026, month: 8, day: 2 } } }];
  assert.deepEqual(filterDataPointsByRange("daily-vo2-max", "daily", daily, "2026-08-01", "2026-08-02"), [daily[0]]);
});

test("request injects token, refuses redirects and does not expose injected auth", async () => {
  const calls: string[] = [];
  const api = client(async (url, init) => {
    calls.push(String(url));
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer private-test-token");
    assert.equal(init?.redirect, "manual");
    assert.ok(init?.signal instanceof AbortSignal);
    return json({ okay: true });
  });
  await api.profile(); await api.identity(); await api.settings(); await api.pairedDevices();
  assert.deepEqual(calls.map((url) => new URL(url).pathname), ["profile", "identity", "settings", "pairedDevices"].map((name) => `/v4/users/me/${name}`));
  await assert.rejects(api.request("//evil.example"), failure("INVALID_API_PATH"));
  await assert.rejects(api.request("/users/me/../../other"), failure("INVALID_API_PATH"));
  await assert.rejects(api.request("/users/me/profile", { method: "POST" }), failure("READ_ONLY_ENDPOINT_REQUIRED"));
  await assert.rejects(api.request("/users/me/profile", { method: "DELETE" }), failure("READ_ONLY_ENDPOINT_REQUIRED"));
});

test("filtered queries paginate to completion preserving provenance", async () => {
  const calls: URL[] = [];
  const api = client(async (url) => {
    const parsed = new URL(String(url)); calls.push(parsed);
    return parsed.searchParams.has("page_token") ? json({ dataPoints: [{ source: "second" }] }) : json({ dataPoints: [{ source: "first" }], nextPageToken: "page2" });
  });
  assert.deepEqual(await api.listDataPoints("steps", "2026-07-30T10:00:00Z", "2026-07-30T12:00:00Z"), [{ source: "first" }, { source: "second" }]);
  assert.equal(calls[1].searchParams.get("page_token"), "page2");
  assert.ok(calls[0].searchParams.get("filter")?.includes('"2026-07-30T10:00:00Z"'));
});

test("unsupported filters fall back through all pages then apply intraday range", async () => {
  const calls: URL[] = [];
  const api = client(async (url) => {
    const parsed = new URL(String(url)); calls.push(parsed);
    if (parsed.searchParams.has("filter")) return json({ error: { message: "INVALID_DATA_POINT_FILTER sensitive private data" } }, 400);
    const hour = parsed.searchParams.has("page_token") ? 11 : 9;
    return json({ dataPoints: [{ heartRate: { sampleTime: { physicalTime: `2026-07-30T${hour.toString().padStart(2, "0")}:00:00Z` } } }], ...(hour === 9 ? { nextPageToken: "next" } : {}) });
  });
  const points = await api.listDataPoints("heart-rate", "2026-07-30T10:00:00Z", "2026-07-30T12:00:00Z");
  assert.equal(points.length, 1); assert.equal(calls.length, 3);
});

test("pagination never silently truncates cycles, page/point limits or malformed pages", async () => {
  const cycle = client(async () => json({ dataPoints: [{}], nextPageToken: "same" }));
  await assert.rejects(cycle.listDataPoints("steps", "2026-07-30", "2026-07-31"), failure("PAGINATION_CYCLE"));
  let page = 0;
  const bounded = client(async () => json({ dataPoints: [{}], nextPageToken: String(++page) }), { maxPages: 2 });
  await assert.rejects(bounded.listDataPoints("steps", "2026-07-30", "2026-07-31"), failure("PAGE_LIMIT_EXCEEDED"));
  const points = client(async () => json({ dataPoints: [{}, {}] }), { maxPoints: 1 });
  await assert.rejects(points.listDataPoints("steps", "2026-07-30", "2026-07-31"), failure("POINT_LIMIT_EXCEEDED"));
  const invalid = client(async () => json({ dataPoints: "private body" }));
  await assert.rejects(invalid.listDataPoints("steps", "2026-07-30", "2026-07-31"), failure("INVALID_PROVIDER_RESPONSE"));
});

test("daily rollup uses read-only POST, civil dates and rejects unsupported operation", async () => {
  const api = client(async (url, init) => {
    assert.ok(String(url).endsWith("/steps/dataPoints:dailyRollUp")); assert.equal(init?.method, "POST");
    assert.deepEqual(JSON.parse(String(init?.body)), { range: { start: { date: { year: 2026, month: 7, day: 30 } }, end: { date: { year: 2026, month: 8, day: 1 } } }, windowSizeDays: 1 });
    return json({ summaries: [] });
  });
  await api.dailyRollup("steps", "2026-07-30", "2026-08-01");
  await assert.rejects(api.dailyRollup("sleep", "2026-07-30", "2026-08-01"), failure("DAILY_ROLLUP_NOT_SUPPORTED"));
});

test("429 and 5xx retry at most three times with bounded delay", async () => {
  let attempts = 0; const delays: number[] = [];
  const api = client(async () => ++attempts < 3 ? json({ secret: "never log" }, attempts === 1 ? 429 : 503, { "Retry-After": "99999" }) : json({ okay: true }), { sleep: async (ms: number) => { delays.push(ms); } });
  await api.profile(); assert.equal(attempts, 3); assert.deepEqual(delays, [2000, 2000]);
  attempts = 0;
  const always = client(async () => { attempts++; return json({ secret: "never log" }, 429); });
  await assert.rejects(always.profile(), failure("RATE_LIMITED")); assert.equal(attempts, 3);
});

test("provider bodies, token-provider errors and network exceptions remain redacted", async () => {
  for (const status of [400, 401, 403, 500]) {
    const api = client(async () => json({ error: { message: "private-token secret-owner-health" } }, status));
    await assert.rejects(api.profile(), (error: unknown) => {
      assert.ok(error instanceof GoogleHealthApiError);
      assert.doesNotMatch(error.message, /private-token|secret-owner-health|https:/);
      return true;
    });
  }
  const denied = new GoogleHealthClient(async () => { throw new Error("secret refresh token"); });
  await assert.rejects(denied.profile(), failure("TOKEN_PROVIDER_ERROR"));
  const network = client(async () => { throw new Error("private health request URL secret"); });
  await assert.rejects(network.profile(), failure("NETWORK_ERROR"));
});

test("request times out and oversized body is rejected without parsing", async () => {
  const timed = client(async (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("private timeout details")))), { timeoutMs: 10 });
  await assert.rejects(timed.profile(), failure("REQUEST_TIMEOUT"));
  const huge = client(async () => json({}, 200, { "content-length": String(9 * 1024 * 1024) }));
  await assert.rejects(huge.profile(), failure("RESPONSE_LIMIT_EXCEEDED"));
});
test('default API transport preserves the native global fetch receiver',async()=>{const previous=globalThis.fetch;globalThis.fetch=(async function(this:typeof globalThis){assert.equal(this,globalThis);return Response.json({pairedDevices:[]});}) as typeof fetch;try{const api=new GoogleHealthClient(async()=> 'synthetic');assert.deepEqual(await api.pairedDevices(),{pairedDevices:[]});}finally{globalThis.fetch=previous;}});

test("provider redirects fail closed without forwarding bearer credentials", async()=> { const api=client(async()=>new Response(null,{status:302,headers:{Location:"https://unexpected.example.test"}})); await assert.rejects(api.profile(),failure("PROVIDER_REDIRECT_REFUSED")); });

test("token refresh failures preserve safe actionable codes without requesting needless consent", async () => {
  const { ConnectionError } = await import("../src/connection-error.js");
  for (const [code, status] of [["GOOGLE_NETWORK_UNAVAILABLE", 502], ["GOOGLE_CLIENT_CONFIGURATION_ERROR", 503], ["SETUP_REQUIRED", 503], ["INVALID_TOKEN_RESPONSE", 502], ["GOOGLE_HTTP_429", 502]] as const) {
    let calls = 0;
    const api = new GoogleHealthClient(async () => { throw new ConnectionError(code, status); }, { fetch: async () => { calls++; return json({}); } });
    await assert.rejects(api.profile(), (error: unknown) => {
      assert.ok(error instanceof GoogleHealthApiError);
      assert.equal(error.code, code);
      assert.equal(error.status, status);
      assert.doesNotMatch(error.message, /Reconnect/);
      return true;
    });
    assert.equal(calls, 0);
  }
});

test("token authorization failures remain explicit and unrecognized errors are redacted", async () => {
  const { ConnectionError } = await import("../src/connection-error.js");
  for (const code of ["RECONNECT_REQUIRED", "CONNECT_GOOGLE_REQUIRED", "CONNECTION_CHANGED", "INCOMPLETE_OR_UNEXPECTED_SCOPE"]) {
    const api = new GoogleHealthClient(async () => { throw new ConnectionError(code); });
    await assert.rejects(api.profile(), failure(code));
  }
  for (const error of [new Error("private token secret"), new ConnectionError("private token secret"), { code: "GOOGLE_NETWORK_UNAVAILABLE", message: "private token secret" }]) {
    const api = new GoogleHealthClient(async () => { throw error; });
    await assert.rejects(api.profile(), (result: unknown) => {
      assert.ok(result instanceof GoogleHealthApiError);
      assert.equal(result.code, "TOKEN_PROVIDER_ERROR");
      assert.doesNotMatch(result.message, /private|secret|Reconnect/);
      return true;
    });
  }
});
