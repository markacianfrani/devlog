import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface RawConfig {
  archiveDir?: string;
  excludeProjects?: string[];
  dbPath?: string;
}

export interface ResolvedConfig {
  archiveDir: string;
  excludeProjects: string[];
  dbPath: string;
}

export const CONFIG_PATH = path.join(os.homedir(), ".config", "devlog", "config.json");

export const DEFAULTS: ResolvedConfig = {
  archiveDir: path.join(os.homedir(), ".config", "devlog"),
  excludeProjects: [],
  dbPath: path.join(os.homedir(), ".local", "state", "devlog", "index.db"),
};

export function loadConfig(): ResolvedConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    return DEFAULTS;
  }

  try {
    const content = fs.readFileSync(CONFIG_PATH, "utf-8");
    const config: RawConfig = JSON.parse(content);

    return {
      archiveDir: config.archiveDir ?? DEFAULTS.archiveDir,
      excludeProjects: config.excludeProjects ?? DEFAULTS.excludeProjects,
      dbPath: config.dbPath ?? DEFAULTS.dbPath,
    };
  } catch {
    return DEFAULTS;
  }
}
