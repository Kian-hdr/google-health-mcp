#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./mcp.js";
import { GoogleHealthClient } from "./google-health.js";
import { createTokenProvider } from "./oauth.js";

const server = createServer(new GoogleHealthClient(createTokenProvider()));
await server.connect(new StdioServerTransport());
