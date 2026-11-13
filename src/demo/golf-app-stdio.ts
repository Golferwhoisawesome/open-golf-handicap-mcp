#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createDemoGolfAppServer } from "./golf-app-server.js";

// Synthetic standalone application fixture. It never connects to a real golf app.
await createDemoGolfAppServer().connect(new StdioServerTransport());
