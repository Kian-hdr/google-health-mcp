/** Safe application-owned failure codes. Never place provider response text here. */
export class ConnectionError extends Error {
  constructor(public code: string, public status = 401) {
    super(code);
  }
}

const publicCodes = new Set([
  "RECONNECT_REQUIRED", "CONNECT_GOOGLE_REQUIRED", "CONNECTION_CHANGED",
  "INCOMPLETE_OR_UNEXPECTED_SCOPE", "SETUP_REQUIRED",
  "GOOGLE_NETWORK_UNAVAILABLE", "GOOGLE_CLIENT_CONFIGURATION_ERROR",
  "GOOGLE_REDIRECT_REFUSED", "INVALID_TOKEN_RESPONSE",
  "GOOGLE_HTTP_400", "GOOGLE_HTTP_401", "GOOGLE_HTTP_403", "GOOGLE_HTTP_429",
  "GOOGLE_HTTP_500", "GOOGLE_HTTP_502", "GOOGLE_HTTP_503", "GOOGLE_HTTP_504",
]);

/** Preserve actionable diagnostics without exposing arbitrary exception content. */
export function publicConnectionFailure(error: unknown): { code: string; status?: number } {
  if (error instanceof ConnectionError && publicCodes.has(error.code)) {
    return {
      code: error.code,
      ...(Number.isInteger(error.status) && error.status >= 400 && error.status <= 599
        ? { status: error.status } : {}),
    };
  }
  return { code: "TOKEN_PROVIDER_ERROR" };
}
