import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";

import type { ParseWarning } from "./parsers/types.ts";

export interface CliOptions {
  verbose: boolean;
  debug: boolean;
}

export interface SourceSummary {
  label: string;
  archived: number;
  skipped: number;
  activity: number;
  activityLabel: string;
  warnings: number;
}

interface ProgressState {
  label: string;
  processed: number;
  total: number;
  archived: number;
  skipped: number;
}

const SPINNER_FRAMES = ["◐", "◓", "◑", "◒"];

const SOURCE_THEME: Record<string, { icon: string; color: number | string }> = {
  Claude: { icon: "✦", color: "38;5;208" },
  opencode: { icon: "◈", color: 36 },
  pi: { icon: "π", color: 35 },
  index: { icon: "⌕", color: 32 },
};

function isInteractiveTerminal() {
  return Boolean(process.stdout.isTTY);
}

function terminalColumns() {
  const columns = process.stdout.columns;
  return columns > 0 ? columns : 80;
}

function ansi(code: number | string, text: string) {
  if (!isInteractiveTerminal()) {
    return text;
  }

  return `\u001B[${code}m${text}\u001B[0m`;
}

function dim(text: string) {
  return ansi(2, text);
}

function bold(text: string) {
  return ansi(1, text);
}

function success(text: string) {
  return ansi(32, text);
}

function terminalLink(label: string, url: string) {
  if (!isInteractiveTerminal()) {
    return label;
  }

  return `\u001B]8;;${url}\u0007${label}\u001B]8;;\u0007`;
}

function tint(text: string, color: number | string) {
  return ansi(color, text);
}

function sourceTheme(label: string) {
  return SOURCE_THEME[label] ?? { icon: "•", color: 39 };
}

// A completed source only needs its session count and the number copied/indexed.
// The in-flight row uses the same columns, with a fraction in the session slot.
export function formatProgressRow(
  state: Pick<ProgressState, "label" | "processed" | "total" | "archived">,
  done: boolean,
  columns = terminalColumns(),
  frame = 0,
) {
  const { label, processed, total, archived } = state;
  const theme = sourceTheme(label);
  const status = done
    ? success("✓")
    : label === "Claude"
      ? dim(SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? "•")
      : tint(SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? "•", theme.color);
  const count = !done && total > 0 ? `${processed}/${total}` : String(processed);
  const displayLabel = label === "Claude" ? "claude code" : label;
  const name = `${tint(theme.icon, theme.color)} ${bold(displayLabel)}`;
  const action = label === "index" ? "indexed" : "copied";
  const unit = processed === 1 ? "session" : "sessions";

  if (columns < 58 || displayLabel.length > 11 || count.length > 13) {
    return `${status} ${name}  ${dim(count)} ${unit}  ${archived} ${action}`;
  }

  const source = `${tint(theme.icon, theme.color)} ${bold(displayLabel.padEnd(11))}`;
  return `${status} ${source}  ${dim(count.padStart(13))} ${unit.padEnd(8)}  ${success(String(archived).padStart(7))} ${action}`;
}

export function formatIndexedTarget(filePath: string, archiveDir: string) {
  const relative = path.relative(path.join(archiveDir, "projects"), filePath);
  const parts = relative.split(path.sep);
  const project = parts[0] ?? "unknown";
  const source = parts[1] ?? "session";
  const session = path.basename(filePath, ".jsonl");
  return `${source}/${project}/${session}`;
}

export function formatParseWarning(warning: ParseWarning) {
  const location = `${warning.filePath}${warning.lineNumber !== undefined ? `:${warning.lineNumber}` : ""}`;
  const linkedLocation = terminalLink(location, pathToFileURL(warning.filePath).href);
  const countSuffix =
    warning.count !== undefined && warning.count > 1 && warning.kind !== "malformed-lines"
      ? ` (${warning.count} occurrences)`
      : "";
  return `${warning.message}${countSuffix}\n  file: ${linkedLocation}`;
}

export class ProgressReporter {
  private readonly enabled: boolean;
  private current: ProgressState | undefined;
  private lastRenderAt = 0;
  private frame = 0;
  private pendingWarnings: string[] = [];

  constructor(options: CliOptions) {
    this.enabled = Boolean(process.stdout.isTTY) && !options.verbose;
  }

  start(label: string, total = 0) {
    if (!this.enabled) {
      return;
    }

    this.current = {
      label,
      processed: 0,
      total,
      archived: 0,
      skipped: 0,
    };
    this.frame = 0;
    this.render(true);
  }

  setTotal(total: number) {
    if (!this.current) {
      return;
    }

    this.current.total = total;
  }

  tick(update: Partial<ProgressState>) {
    if (!this.enabled || !this.current) {
      return;
    }

    this.current = { ...this.current, ...update };
    const stride = Math.max(1, Math.ceil(this.current.total / 40));
    this.render(update.processed !== undefined && this.current.processed % stride === 0);
  }

  warn(message: string) {
    if (!this.enabled) {
      console.warn(message);
      return;
    }

    this.pendingWarnings.push(message);
  }

  end() {
    if (!this.enabled || !this.current) {
      return;
    }

    const line = formatProgressRow(this.current, true);
    this.clear();
    console.log(line);
    this.current = undefined;
  }

  flushWarnings() {
    for (const message of this.pendingWarnings) {
      console.warn(message);
    }
    this.pendingWarnings = [];
  }

  private render(force = false) {
    if (!this.enabled || !this.current) {
      return;
    }

    const now = Date.now();
    if (!force && now - this.lastRenderAt < 80) {
      return;
    }
    this.lastRenderAt = now;

    const line = formatProgressRow(this.current, false, terminalColumns(), this.frame++);
    this.clear();
    process.stdout.write(line);
  }

  private clear() {
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
  }
}

export type Logger = ReturnType<typeof createLogger>;

export function createLogger(options: CliOptions) {
  return {
    info(message: string) {
      console.log(message);
    },
    verbose(message: string) {
      if (options.verbose) {
        console.log(message);
      }
    },
    debug(message: string) {
      if (options.debug) {
        console.log(message);
      }
    },
    warn(message: string) {
      console.warn(message);
    },
  };
}

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function displayDestination(archiveDir: string) {
  const home = os.homedir();
  return archiveDir === home
    ? "~"
    : archiveDir.startsWith(`${home}${path.sep}`)
      ? `~${archiveDir.slice(home.length)}`
      : archiveDir;
}

export function printArchiveHeader(archiveDir: string, options: CliOptions) {
  if (!isInteractiveTerminal() || options.verbose) {
    return;
  }

  console.log(
    `  ${dim("transcripts")}  ${tint("→", 36)}  ${bold(displayDestination(archiveDir))}\n`,
  );
}

export function printRunArchiveStage(archiveDir: string) {
  console.log(`${bold("[1/2] Archive transcripts")} to ${displayDestination(archiveDir)}\n`);
}

export function printRunIndexStage(rebuild = false) {
  console.log(
    `\n${bold(rebuild ? "[2/2] Rebuild search index" : "[2/2] Index sessions for search")}\n`,
  );
}

export function printRunArchiveRows(summaries: SourceSummary[]) {
  if (isInteractiveTerminal()) {
    return;
  }

  for (const summary of summaries) {
    const processed = summary.archived + summary.skipped;
    console.log(
      `  ${formatProgressRow({ label: summary.label, processed, total: processed, archived: summary.archived }, true)}`,
    );
  }
}

export function printRunIndexResult(
  stats: {
    sessionsIndexed: number;
    sessionsSkipped: number;
    messagesIndexed: number;
    errors: number;
    warnings?: number;
  },
  durationMs: number,
) {
  if (!isInteractiveTerminal()) {
    const processed = stats.sessionsIndexed + stats.sessionsSkipped;
    console.log(
      `  ${formatProgressRow({ label: "index", processed, total: processed, archived: stats.sessionsIndexed }, true)}`,
    );
  }
  console.log(
    `  ${stats.messagesIndexed} ${stats.messagesIndexed === 1 ? "message" : "messages"} indexed`,
  );
  if ((stats.warnings ?? 0) > 0) {
    console.log(`  Warnings: ${stats.warnings}`);
  }
  if (stats.errors > 0) {
    console.log(`  Errors: ${stats.errors}`);
  }
  console.log(`\n${dim(`Done in ${formatDuration(durationMs)}`)}`);
}

export function printArchiveSummary(
  summaries: SourceSummary[],
  archiveDir: string,
  durationMs: number,
) {
  const totalArchived = summaries.reduce((sum, item) => sum + item.archived, 0);
  const totalSkipped = summaries.reduce((sum, item) => sum + item.skipped, 0);
  const totalWarnings = summaries.reduce((sum, item) => sum + item.warnings, 0);

  if (!isInteractiveTerminal()) {
    console.log("Scanning sources...\n");

    for (const summary of summaries) {
      console.log(
        `${(summary.label === "Claude" ? "claude code" : summary.label).padEnd(11)} ${summary.archived} updated, ${summary.skipped} skipped`,
      );
    }

    console.log(`\nDone in ${formatDuration(durationMs)}`);
    console.log(`Updated: ${totalArchived} sessions`);
    console.log(`Skipped: ${totalSkipped} unchanged`);
    if (totalWarnings > 0) {
      console.log(`Warnings: ${totalWarnings}`);
    }
    console.log(`Archive: ${archiveDir}`);
    return;
  }

  console.log(`\n  ${dim(`Done in ${formatDuration(durationMs)}`)}`);
  if (totalWarnings > 0) {
    console.log(`  ${bold("Warnings")} ${totalWarnings}`);
  }
}

export function printIndexSummary(
  stats: {
    sessionsIndexed: number;
    sessionsSkipped: number;
    messagesIndexed: number;
    errors: number;
    warnings?: number;
  },
  dbPath: string,
  durationMs: number,
) {
  if (!isInteractiveTerminal()) {
    console.log("Index complete");
    console.log(`Sessions indexed: ${stats.sessionsIndexed}`);
    console.log(`Sessions skipped: ${stats.sessionsSkipped}`);
    console.log(`Messages indexed: ${stats.messagesIndexed}`);
    if ((stats.warnings ?? 0) > 0) {
      console.log(`Warnings: ${stats.warnings}`);
    }
    if (stats.errors > 0) {
      console.log(`Errors: ${stats.errors}`);
    }
    console.log(`Database: ${dbPath}`);
    return;
  }

  console.log(
    `\n  ${dim(`Done in ${formatDuration(durationMs)}`)}  ${dim("·")}  ${stats.messagesIndexed} messages indexed`,
  );
  console.log(`  ${dim(`Database: ${dbPath}`)}`);
  if ((stats.warnings ?? 0) > 0) {
    console.log(`  ${bold("Warnings")} ${stats.warnings}`);
  }
  if (stats.errors > 0) {
    console.log(`  ${bold("Errors")} ${stats.errors}`);
  }
}

export const DEFAULT_CLI_OPTIONS: CliOptions = {
  verbose: false,
  debug: false,
};
