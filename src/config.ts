import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Source } from "./parsers/types.ts";
import type { RedactionStep, RedactHookStep, TruffleHogStep } from "./redaction-steps.ts";

export type { Source };

export interface RawConfig {
  archiveDir?: string;
  excludeProjects?: string[];
  excludeSources?: Source[];
  dbPath?: string;
  redaction?: unknown;
}

export interface ResolvedConfig {
  archiveDir: string;
  excludeProjects: string[];
  excludeSources: Source[];
  dbPath: string;
  redactionSteps: RedactionStep[];
}

export const CONFIG_PATH = path.join(os.homedir(), ".config", "devlog", "config.json");

export const DEFAULTS: ResolvedConfig = {
  archiveDir: path.join(os.homedir(), ".config", "devlog"),
  excludeProjects: [],
  excludeSources: [],
  dbPath: path.join(os.homedir(), ".local", "state", "devlog", "index.db"),
  redactionSteps: [],
};

function warn(message: string): void {
  console.warn(`[devlog] config: ${message}`);
}

// Each step must be well-formed or it is dropped with a warning: a broken step
// never blocks indexing.
function resolveRedactionSteps(value: unknown): RedactionStep[] {
  if (value === undefined) {
    return [];
  }
  if (typeof value !== "object" || value === null) {
    warn("redaction must be an object with a steps array; ignoring it");
    return [];
  }
  const steps = (value as Record<string, unknown>)["steps"];
  if (steps === undefined) {
    // A typo'd key ("step", "Steps") would otherwise disable the whole
    // pipeline with zero signal while every sibling malformed case warns.
    warn("redaction has no steps array; ignoring it");
    return [];
  }
  if (!Array.isArray(steps)) {
    warn("redaction.steps must be an array; ignoring it");
    return [];
  }

  const resolved: RedactionStep[] = [];
  for (const [index, step] of steps.entries()) {
    if (typeof step !== "object" || step === null) {
      warn(`redaction.steps[${index}] must be an object; ignoring it`);
      continue;
    }
    const record = step as Record<string, unknown>;
    const kind = record["kind"];

    if (kind === "redact") {
      const step = resolveRedactStep(record, index);
      if (step) {
        resolved.push(step);
      }
      continue;
    }

    if (kind === "trufflehog") {
      const step = resolveTruffleHogStep(record, index);
      if (step) {
        resolved.push(step);
      }
      continue;
    }

    warn(
      `redaction.steps[${index}] has unknown kind ${JSON.stringify(kind)} ("redact" and "trufflehog" are supported); ignoring it`,
    );
  }
  return resolved;
}

function resolveRedactStep(
  record: Record<string, unknown>,
  index: number,
): RedactHookStep | undefined {
  const where = `redaction.steps[${index}]`;

  if (typeof record["name"] !== "string" || record["name"].trim() === "") {
    warn(`${where} needs a non-empty name; ignoring it`);
    return undefined;
  }
  if (typeof record["command"] !== "string" || record["command"].trim() === "") {
    warn(`${where} needs a non-empty command; ignoring it`);
    return undefined;
  }
  if (
    record["timeoutMs"] !== undefined &&
    (typeof record["timeoutMs"] !== "number" || record["timeoutMs"] <= 0)
  ) {
    warn(`${where} has invalid timeoutMs; ignoring it`);
    return undefined;
  }
  if (record["cwd"] !== undefined && typeof record["cwd"] !== "string") {
    warn(`${where} has invalid cwd; ignoring it`);
    return undefined;
  }

  return {
    kind: "redact",
    name: record["name"],
    command: record["command"],
    timeoutMs: record["timeoutMs"],
    cwd: record["cwd"],
  };
}

function resolveTruffleHogStep(
  record: Record<string, unknown>,
  index: number,
): TruffleHogStep | undefined {
  const mode = record["mode"];
  if (mode !== "warn" && mode !== "redact") {
    warn(`redaction.steps[${index}] needs mode "warn" or "redact"; ignoring it`);
    return undefined;
  }
  return { kind: "trufflehog", mode };
}

export function loadConfig(): ResolvedConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    return DEFAULTS;
  }

  try {
    const content = fs.readFileSync(CONFIG_PATH, "utf-8");
    const config: RawConfig = JSON.parse(content) as RawConfig;

    return {
      archiveDir: config.archiveDir ?? DEFAULTS.archiveDir,
      excludeProjects: config.excludeProjects ?? DEFAULTS.excludeProjects,
      excludeSources: config.excludeSources ?? DEFAULTS.excludeSources,
      dbPath: config.dbPath ?? DEFAULTS.dbPath,
      redactionSteps: resolveRedactionSteps(config.redaction),
    };
  } catch (err) {
    // A broken config (trailing comma, bad JSON) would otherwise silently
    // drop redaction.steps — the whole scan pipeline — with no warning.
    warn(
      `failed to load ${CONFIG_PATH} (${err instanceof Error ? err.message : String(err)}); using defaults`,
    );
    return DEFAULTS;
  }
}
