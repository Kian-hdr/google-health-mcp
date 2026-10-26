# Set up your own Google Health connection

## 1. Create your own repository and build

Use GitHub's **Use this template** button, then clone your new repository. Install Node.js 22.13+ and run `npm ci --ignore-scripts`, then `npm run build`. Use a separate development project rather than changing an existing production account or deployment.

## 2. Prepare Google Health and Google Cloud

Follow Google's current [Google Cloud and OAuth setup guide](https://developers.google.com/health/setup). First link your Google account to Google Health through its mobile app. API availability and developer requirements are controlled by Google.

Create a Google Cloud project, enable Google Health API, configure the consent screen/test users, and create your own Web application OAuth client. Register this exact development redirect URI:

```text
http://127.0.0.1:42813/oauth/callback
```

If you change the port, update both `GOOGLE_HEALTH_PORT` and the registered URI. This template deliberately accepts loopback callbacks only. Configure the read-only scopes shown by `requiredScopes()` in `src/oauth.ts`; no write scopes are requested.

Copy `.env.example` to `.env` and enter your own client ID/secret. Keep `.env` private and untracked; on macOS/Linux run `chmod 600 .env`. Never copy another person's OAuth client, token file, private deployment configuration or health data into the template.

## 3. Authorize locally

Run `npm run auth` and open the printed Google URL in your normal system browser. Complete Google's own consent and any required identity verification. The local callback uses a random single-use state and PKCE; setup expires after five minutes. Credentials are persisted only after `users/me/identity` succeeds. No identity response or health measurement is stored.

Default token storage is `$XDG_CONFIG_HOME/google-health-mcp/tokens.json`, or `~/.config/google-health-mcp/tokens.json` when that variable is unset. Set `GOOGLE_HEALTH_TOKEN_PATH` to another private absolute path if needed. The process writes token files atomically with owner-only permissions and rejects symlink token destinations. This is not protection against an unrestricted process running as the same OS user.

Google's Testing publishing status can expire refresh tokens after seven days. A public GitHub template does not publish or verify your OAuth application. Follow Google's current verification/developer requirements for broader or production use; no long-lived grant is guaranteed by this template.

## 4. Connect an MCP host

Use the direct Node configuration in the root README. Do not configure `npm start` as the stdio command: npm can add non-protocol output. Different hosts use different configuration wrappers; retain the command, environment file and absolute entry-point paths.

List the tools, call `get_data_source_info`, then make a small account-authorized query. Prefer bounded date windows. Data absent from the API is unavailable, not a zero measurement. The template never writes health records or starts a background collection schedule.

## Troubleshooting

- `CONNECT_GOOGLE_REQUIRED`: run local authorization with your own account.
- `SETUP_REQUIRED`: inspect local environment and private token-file permissions/configuration.
- `ACCOUNT_NOT_LINKED`: link that Google account to Google Health in the mobile app before authorizing again.
- `GOOGLE_NETWORK_UNAVAILABLE` or `GOOGLE_HTTP_429`: address connectivity/rate limits; do not repeatedly create new consent flows.
- `RECONNECT_REQUIRED`: an existing grant may be invalid or revoked; reauthorize deliberately.
- Missing metrics or filtering limits: inspect the tool's provenance/availability fields and Google's current API documentation.

Report bugs using synthetic examples and safe error codes. Never attach OAuth codes, tokens, request URLs containing credentials or real health records.
