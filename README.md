# Google Health MCP template

An unofficial, reusable starting point for connecting your own Google Health account to an MCP client or TypeScript application. One repository contains the shared API client, 17 read-only MCP tools, local OAuth setup, analytics, and synthetic tests.

**[Use this template](https://github.com/Kian-hdr/google-health-mcp/generate)** · [Setup](docs/SETUP.md) · [Security and privacy](SECURITY.md) · [Upstream attribution](ATTRIBUTION.md)

## Start here

Requires Node.js 22.13 or newer and npm. Use your own Google Cloud project, OAuth client and Google Health account. The template includes no working credentials or personal health records.

```sh
npm ci --ignore-scripts
npm run build
cp .env.example .env
# Fill in your own OAuth client ID and secret, following docs/SETUP.md.
npm run auth
```

OAuth setup prints a Google authorization URL for your system browser. It uses state, PKCE and a loopback callback, checks Google Health account linkage, then saves tokens outside the repository. MFA/passkeys and consent stay with the person authorizing the account.

Configure your MCP client to run Node directly, using absolute paths:

```json
{
  "mcpServers": {
    "google-health": {
      "command": "node",
      "args": [
        "--env-file=/absolute/path/to/google-health-mcp/.env",
        "/absolute/path/to/google-health-mcp/dist/src/index.js"
      ]
    }
  }
}
```

Adapt the surrounding configuration to your MCP host. Discovery works before authorization; account-dependent tools return an actionable connection error until setup is complete. Use `get_data_source_info` before interpreting results.

## Shared client and tools

`src/google-health.ts` is the single HTTP client used by the server. `src/client.ts` exports that client for direct application use; `src/mcp.ts` builds the MCP server around it. `src/oauth.ts` and `src/auth.ts` supply local authorization. There is no independently maintained client repository to keep in sync.

The 17 tools cover source information, metric discovery, profile/devices/settings, metric reads, daily/recent summaries, trends, sleep summaries, sync availability, period comparisons, data quality, activity, recovery and body metrics. All tools are read-only. Daily aggregation uses a read-only POST; the server exposes no create/update/delete or arbitrary HTTP tool.

The client bounds request time, response size, retries and pagination; refuses redirects and unsupported endpoints; and reports safe error codes. Missing, unavailable and zero values remain distinct. Provider data can differ by account, device, scope and synchronization state.

## Validate without an account

```sh
npm test
```

Tests use fake responses and temporary files, including actual MCP protocol and stdio sessions, OAuth callback rejection/replay handling, token-file permissions, account linkage, request bounds and analytics. No real provider calls or account authorization are performed by these checks. Passing tests does not establish live Google API access, device parity or medical validity.

This is a local stdio template. Remote ChatGPT integrations need a separately secured HTTPS MCP deployment and authentication flow; those are not supplied as a hosted service. Personal deployments, dashboards, schedules, private configuration and health data remain separate.

## License and provenance

MIT. Adapted from [rickygarim/fitbit-google-health-mcp](https://github.com/rickygarim/fitbit-google-health-mcp), preserving Rithvik Garimella's attribution, with client/error-handling and template improvements by Kian Konrad Tajbakhsh. Not affiliated with Google or Fitbit. See [ATTRIBUTION.md](ATTRIBUTION.md).
