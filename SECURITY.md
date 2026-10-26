# Security and privacy

This template is read-only and local stdio. It contains no hosted account, secret, measurement archive, automatic collection schedule or arbitrary request tool. OAuth credentials belong to each person using the template; keep them outside version control. Runtime tokens are stored separately from source.

The OAuth helper binds to loopback, validates Host/state/method, uses PKCE and a single-use callback, and verifies Google Health linkage before persisting tokens. API redirects are refused; errors use safe codes rather than arbitrary provider responses. Network access still reveals ordinary metadata to Google, and tools return health data to the MCP host you choose. Review that host's access and data handling.

Use a system browser for Google authorization. This local template is not a ready-made public HTTP service. A hosted adaptation needs its own authenticated transport, per-user isolation and secure credential storage. Never expose the callback or a personal token store through a reverse proxy.

Tests use synthetic tokens/records only. They do not certify medical accuracy or regulatory compliance. For public bug reports, use a synthetic reproduction and a safe error code, without account identifiers, tokens or health records.

The template pins the patched MCP SDK1.32.2 and Zod4.6.7. CI checks runtime dependencies for high-severity advisories; keep the lockfile and supported maintenance releases current.
