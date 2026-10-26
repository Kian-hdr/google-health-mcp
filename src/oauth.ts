import { OAuth2Client, type Credentials } from "google-auth-library";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { GoogleHealthClient, requiredScopes } from "./google-health.js";
import { ConnectionError } from "./connection-error.js";

export function tokenPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.GOOGLE_HEALTH_TOKEN_PATH ?? join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "google-health-mcp", "tokens.json"));
}

async function rejectSymlink(path: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new ConnectionError("SETUP_REQUIRED", 503);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function loadTokens(path = tokenPath()): Promise<Credentials | undefined> {
  await rejectSymlink(path);
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const result = value as Credentials;
    if (typeof result.refresh_token !== "string" && typeof result.access_token !== "string") throw new Error();
    return result;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ConnectionError("SETUP_REQUIRED", 503);
  }
}

export async function saveTokens(tokens: Credentials, path = tokenPath()): Promise<void> {
  const parent = dirname(path);
  await rejectSymlink(parent);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await rejectSymlink(path);
  const temporary = path + "." + randomBytes(12).toString("hex") + ".tmp";
  try {
    await writeFile(temporary, JSON.stringify(tokens), { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

export function oauthClient(env: NodeJS.ProcessEnv = process.env): OAuth2Client {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) throw new ConnectionError("SETUP_REQUIRED", 503);
  const port = Number(env.GOOGLE_HEALTH_PORT ?? 42813);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new ConnectionError("SETUP_REQUIRED", 503);
  return new OAuth2Client(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, `http://127.0.0.1:${port}/oauth/callback`);
}

/** Confirm Google Health linkage before persisting credentials or reporting success. */
export async function verifyAndSaveTokens(tokens: Credentials, path = tokenPath(), fetcher?: typeof fetch): Promise<void> {
  const token = tokens.access_token;
  if (!token) throw new ConnectionError("INVALID_TOKEN_RESPONSE", 502);
  await new GoogleHealthClient(async () => token, { fetch: fetcher }).identity();
  await saveTokens(tokens, path);
}

export function oauthFailure(error: unknown): ConnectionError {
  if (error instanceof ConnectionError) return error;
  const root = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const response = root.response && typeof root.response === "object" ? root.response as Record<string, unknown> : {};
  const data = response.data && typeof response.data === "object" ? response.data as Record<string, unknown> : {};
  if (data.error === "invalid_grant") return new ConnectionError("RECONNECT_REQUIRED");
  if (data.error === "invalid_client" || data.error === "unauthorized_client") return new ConnectionError("GOOGLE_CLIENT_CONFIGURATION_ERROR", 503);
  if (["ENOTFOUND", "ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN"].includes(String(root.code))) return new ConnectionError("GOOGLE_NETWORK_UNAVAILABLE", 502);
  if ([400,401,403,429,500,502,503,504].includes(Number(response.status))) return new ConnectionError(`GOOGLE_HTTP_${response.status}`, 502);
  return new ConnectionError("TOKEN_PROVIDER_ERROR", 502);
}

export function createTokenProvider(env: NodeJS.ProcessEnv = process.env): () => Promise<string> {
  let initialization: Promise<OAuth2Client> | undefined;
  let persistence: Promise<void> = Promise.resolve();
  async function initialize(): Promise<OAuth2Client> {
    const saved = await loadTokens(tokenPath(env));
    if (!saved) throw new ConnectionError("CONNECT_GOOGLE_REQUIRED");
    const configured = oauthClient(env);
    configured.setCredentials(saved);
    configured.on("tokens", (tokens) => {
      persistence = persistence.then(() => saveTokens({ ...configured.credentials, ...tokens }, tokenPath(env))).catch(() => { throw new ConnectionError("SETUP_REQUIRED", 503); });
      void persistence.catch(() => {});
    });
    return configured;
  }
  return async () => {
    try {
      const auth = await (initialization ??= initialize());
      const result = await auth.getAccessToken();
      await persistence;
      if (!result.token) throw new ConnectionError("INVALID_TOKEN_RESPONSE", 502);
      return result.token;
    } catch (error) { throw oauthFailure(error); }
  };
}

export { requiredScopes };
