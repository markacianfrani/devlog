#!/usr/bin/env bun

import { type CliOptions } from "./progress.ts";

const HELP_TEXT = `Usage: devlog [archive|index|mcp|init] [options]

Commands:
  archive    Archive Claude Code, opencode, and pi sessions (default)
  index      Index archived sessions into SQLite database
  mcp        Start the MCP server (stdio)
  init       Set up devlog and install MCP servers

Options:
  --rebuild  (index only) Re-index all sessions, ignoring cache
  --verbose  Show per-project and per-session details
  --debug    Include noisy debug logs
  --help     Show this help message

Config: ~/.config/devlog/config.json
  excludeSources    Sources to skip (e.g. ["opencode"])
  excludeProjects   Project slugs to skip (e.g. ["my-private-repo"])
  archiveDir        Custom archive directory
  dbPath            Custom database path`;

const USAGE_TEXT = `Usage: devlog [archive|index|mcp|init] [--rebuild] [--verbose] [--debug]

Commands:
  archive    Archive Claude Code, opencode, and pi sessions (default)
  index      Index archived sessions into SQLite database
  mcp        Start the MCP server (stdio)
  init       Set up devlog and install MCP servers

Options:
  --rebuild  Re-index all sessions, ignoring cache
  --verbose  Show per-project and per-session details
  --debug    Include noisy debug logs

Config: ~/.config/devlog/config.json
  excludeSources    Sources to skip (e.g. ["opencode"])
  excludeProjects   Project slugs to skip (e.g. ["my-private-repo"])
  archiveDir        Custom archive directory
  dbPath            Custom database path`;

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP_TEXT);
    return;
  }

  const command = args.find((arg) => !arg.startsWith("--")) ?? "archive";
  const options: CliOptions = {
    verbose: args.includes("--verbose"),
    debug: args.includes("--debug"),
  };

  switch (command) {
    case "archive": {
      const { archiveMain } = await import("./archive.ts");
      await archiveMain(options);
      break;
    }
    case "index": {
      const { indexMain } = await import("./archive.ts");
      const rebuild = args.includes("--rebuild");
      await indexMain(rebuild, options);
      break;
    }
    case "mcp": {
      const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
      const { createServer } = await import("./mcp-server.ts");
      const transport = new StdioServerTransport();
      const server = createServer();
      await server.connect(transport);
      break;
    }
    case "init": {
      const { initMain } = await import("./init.ts");
      await initMain();
      break;
    }
    default:
      console.log(USAGE_TEXT);
      process.exit(1);
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error("❌ Error:", error.message);
    process.exit(1);
  });
}
