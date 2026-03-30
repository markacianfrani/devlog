import * as p from "@clack/prompts";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

type Harness = "claude" | "opencode" | "pi";

function resolvePath(input: string): string {
  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return path.resolve(input);
}

function readJsonFile(filePath: string): Record<string, unknown> | undefined {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    // Strip single-line comments for JSONC compat
    const stripped = content.replace(/^\s*\/\/.*$/gm, "");
    return JSON.parse(stripped);
  } catch {
    return undefined;
  }
}

function writeJsonFile(filePath: string, data: Record<string, unknown>) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, undefined, 2) + "\n");
}

function installClaude(devlogBin: string): void {
  const configPath = path.join(os.homedir(), ".claude.json");
  const config = readJsonFile(configPath) ?? {};
  const mcpServers = (config["mcpServers"] as Record<string, unknown>) ?? {};

  mcpServers["devlog"] = { command: devlogBin, args: ["mcp"] };
  config["mcpServers"] = mcpServers;

  writeJsonFile(configPath, config);
  p.log.success(`Claude Code: wrote MCP config to ${configPath}`);
}

function installOpencode(devlogBin: string): void {
  const configDir = path.join(os.homedir(), ".config", "opencode");
  const candidates = ["opencode.jsonc", "opencode.json", "config.json"];

  let configPath = path.join(configDir, "opencode.jsonc");
  for (const candidate of candidates) {
    const candidatePath = path.join(configDir, candidate);
    if (fs.existsSync(candidatePath)) {
      configPath = candidatePath;
      break;
    }
  }

  const config = readJsonFile(configPath) ?? {};
  const mcp = (config["mcp"] as Record<string, unknown>) ?? {};

  mcp["devlog"] = {
    type: "local",
    command: [devlogBin, "mcp"],
  };
  config["mcp"] = mcp;

  writeJsonFile(configPath, config);
  p.log.success(`opencode: wrote MCP config to ${configPath}`);
}

function installPi(devlogBin: string): void {
  const configPath = path.join(os.homedir(), ".pi", "agent", "mcp.json");
  const config = readJsonFile(configPath) ?? {};
  const mcpServers = (config["mcpServers"] as Record<string, unknown>) ?? {};

  mcpServers["devlog"] = { command: devlogBin, args: ["mcp"] };
  config["mcpServers"] = mcpServers;

  writeJsonFile(configPath, config);
  p.log.success(`pi: wrote MCP config to ${configPath}`);
  p.log.info("pi requires the pi-mcp-adapter extension: pi install npm:pi-mcp-adapter");
}

function compactPath(absolutePath: string): string {
  const home = os.homedir();
  if (absolutePath === home) {
    return "~";
  }
  if (absolutePath.startsWith(home + "/")) {
    return "~/" + absolutePath.slice(home.length + 1);
  }
  return absolutePath;
}

function hasDevlogMcp(config: Record<string, unknown> | undefined, key: string): boolean {
  if (!config) {
    return false;
  }
  const section = config[key] as Record<string, unknown> | undefined;
  return section?.["devlog"] !== undefined;
}

function getInstalledHarnesses(): Harness[] {
  const installed: Harness[] = [];

  const claude = readJsonFile(path.join(os.homedir(), ".claude.json"));
  if (hasDevlogMcp(claude, "mcpServers")) {
    installed.push("claude");
  }

  const opencodeDir = path.join(os.homedir(), ".config", "opencode");
  for (const name of ["opencode.jsonc", "opencode.json", "config.json"]) {
    const oc = readJsonFile(path.join(opencodeDir, name));
    if (oc && hasDevlogMcp(oc, "mcp")) {
      installed.push("opencode");
      break;
    }
  }

  const pi = readJsonFile(path.join(os.homedir(), ".pi", "agent", "mcp.json"));
  if (hasDevlogMcp(pi, "mcpServers")) {
    installed.push("pi");
  }

  return installed;
}

export async function initMain(): Promise<void> {
  const configDir = path.join(os.homedir(), ".config", "devlog");
  const configPath = path.join(configDir, "config.json");
  const existingConfig = readJsonFile(configPath);

  const currentArchiveDir = existingConfig?.["archiveDir"] as string | undefined;
  const defaultDir = currentArchiveDir ? compactPath(currentArchiveDir) : "~/devlog";

  p.intro("devlog");

  const archiveDir = await p.text({
    message: "Where should devlog store session logs?",
    placeholder: defaultDir,
    defaultValue: defaultDir,
  });

  if (p.isCancel(archiveDir)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const installedHarnesses = getInstalledHarnesses();

  const harnesses = await p.multiselect<Harness>({
    message: "Install the devlog MCP server for:",
    options: [
      { value: "claude" as const, label: "Claude Code", hint: "~/.claude.json" },
      { value: "opencode" as const, label: "opencode", hint: "~/.config/opencode/" },
      { value: "pi" as const, label: "pi", hint: "~/.pi/agent/mcp.json" },
    ],
    initialValues: installedHarnesses,
    required: false,
  });

  if (p.isCancel(harnesses)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const resolvedDir = resolvePath(archiveDir);
  fs.mkdirSync(resolvedDir, { recursive: true });

  fs.mkdirSync(configDir, { recursive: true });
  const updatedConfig = existingConfig ?? {};
  updatedConfig["archiveDir"] = resolvedDir;
  writeJsonFile(configPath, updatedConfig);
  p.log.success(`Config saved to ${configPath}`);

  if (harnesses.length > 0) {
    const devlogBin = Bun.which("devlog") ?? path.resolve(process.argv[1]);

    for (const harness of harnesses) {
      switch (harness) {
        case "claude":
          installClaude(devlogBin);
          break;
        case "opencode":
          installOpencode(devlogBin);
          break;
        case "pi":
          installPi(devlogBin);
          break;
      }
    }
  }

  p.outro("You're all set!");
}
