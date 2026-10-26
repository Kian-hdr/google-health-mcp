/** Manual local OAuth consent only; not run by MCP startup or tests. */
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { CodeChallengeMethod } from "google-auth-library";
import { oauthClient, requiredScopes, verifyAndSaveTokens } from "./oauth.js";

export function callbackHandler(state: string, exchange: (code: string) => Promise<void>, finish: () => void) {
  let used = false;
  return async (request: IncomingMessage, response: ServerResponse) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.setHeader("Content-Security-Policy", "default-src 'none'");
    const host = `127.0.0.1:${request.socket.localPort}`;
    if (request.headers.host !== host || request.method !== "GET" || (request.url?.length ?? 0) > 8192) {
      response.writeHead(400).end("Invalid callback request."); return;
    }
    const url = new URL(request.url ?? "/", `http://${host}`);
    if (url.pathname !== "/oauth/callback") { response.writeHead(404).end(); return; }
    const received = Buffer.from(url.searchParams.get("state") ?? "");
    const expected = Buffer.from(state);
    if (used || received.length !== expected.length || !timingSafeEqual(received, expected)) {
      response.writeHead(400).end("Invalid or expired authorization state."); return;
    }
    const code = url.searchParams.get("code");
    if (!code) { response.writeHead(400).end("Authorization was not completed."); return; }
    used = true;
    try {
      await exchange(code);
      response.end("Google Health connected. You can close this window.");
    } catch {
      response.writeHead(400).end("Authorization failed. Restart setup and try again.");
    } finally { finish(); }
  };
}

export async function main(): Promise<void> {
  const auth = oauthClient();
  const state = randomBytes(32).toString("base64url");
  const verifier = await auth.generateCodeVerifierAsync();
  const server = http.createServer();
  const timer = setTimeout(() => { console.error("Authorization timed out. Run setup again."); server.close(); }, 300_000);
  timer.unref();
  server.on("request", callbackHandler(state, async (code) => {
    const { tokens } = await auth.getToken({ code, codeVerifier: verifier.codeVerifier });
    await verifyAndSaveTokens(tokens);
  }, () => { clearTimeout(timer); server.close(); }));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(process.env.GOOGLE_HEALTH_PORT ?? 42813), "127.0.0.1", resolve);
  });
  const url = auth.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: requiredScopes(), state,
    code_challenge: verifier.codeChallenge, code_challenge_method: CodeChallengeMethod.S256 });
  console.log("Open this Google authorization URL locally:\n\n" + url + "\n\nWaiting up to five minutes for the loopback callback.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error("Setup failed. Check OAuth configuration and the local callback port."); process.exitCode = 1; });
}
