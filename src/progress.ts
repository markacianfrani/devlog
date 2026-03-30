import path from "node:path";
import readline from "node:readline";

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
  totalLabelWidth: number;
  archived: number;
  skipped: number;
}

const SPINNER_FRAMES = ["◐", "◓", "◑", "◒"];

const SOURCE_THEME: Record<string, { icon: string; color: number }> = {
  Claude: { icon: "✦", color: 33 },
  opencode: { icon: "◈", color: 36 },
  pi: { icon: "◌", color: 35 },
  index: { icon: "⌕", color: 32 },
};

function isInteractiveTerminal() {
  return Boolean(process.stdout.isTTY);
}

function ansi(code: number, text: string) {
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

function tint(text: string, color: number) {
  return ansi(color, text);
}

function sourceTheme(label: string) {
  return SOURCE_THEME[label] ?? { icon: "•", color: 39 };
}

function renderMeter(processed: number, total: number, color: number) {
  const width = 12;
  const ratio = total > 0 ? Math.min(1, processed / total) : 0;
  const filled = Math.round(width * ratio);
  const bar = `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
  return tint(bar, color);
}

function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return count === 1 ? singular : plural;
}

export function formatIndexedTarget(filePath: string, archiveDir: string) {
  const relative = path.relative(path.join(archiveDir, "projects"), filePath);
  const parts = relative.split(path.sep);
  const project = parts[0] ?? "unknown";
  const source = parts[1] ?? "session";
  const session = path.basename(filePath, ".jsonl");
  return `${source}/${project}/${session}`;
}

export class ProgressReporter {
  private readonly enabled: boolean;
  private current: ProgressState | undefined;
  private lastRenderAt = 0;
  private frame = 0;

  constructor(options: CliOptions) {
    this.enabled = Boolean(process.stdout.isTTY) && !options.verbose;
  }

  start(label: string, total = 0) {
    if (!this.enabled) {
      return;
    }

    const totalDigits = Math.max(String(total).length, 1);
    this.current = {
      label,
      processed: 0,
      total,
      totalLabelWidth: totalDigits * 2 + 1,
      archived: 0,
      skipped: 0,
    };
    this.render(true);
  }

  setTotal(total: number) {
    if (!this.current) {
      return;
    }

    const totalDigits = String(total).length;
    this.current.total = total;
    this.current.totalLabelWidth = totalDigits * 2 + 1;
  }

  tick(update: Partial<ProgressState>) {
    if (!this.enabled || !this.current) {
      return;
    }

    this.current = { ...this.current, ...update };
    this.render();
  }

  warn(message: string) {
    if (!this.enabled) {
      console.warn(message);
      return;
    }

    this.clear();
    console.warn(message);
    this.render();
  }

  end() {
    if (!this.enabled || !this.current) {
      return;
    }

    const { label, processed, total, totalLabelWidth, archived, skipped } = this.current;
    const theme = sourceTheme(label);
    const totalLabel = (total > 0 ? `${processed}/${total}` : `${processed}`).padStart(
      totalLabelWidth,
    );
    const meter = renderMeter(processed, total, theme.color);
    const check = success("✓");
    const line = `${check} ${tint(theme.icon, theme.color)} ${bold(label.padEnd(8))} ${meter} ${dim(totalLabel)}  ${archived} new  ${skipped} unchanged`;
    this.clear();
    console.log(line);
    this.current = undefined;
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

    const { label, processed, total, totalLabelWidth, archived, skipped } = this.current;
    const theme = sourceTheme(label);
    const spinner = tint(SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length] ?? "•", theme.color);
    this.frame += 1;
    const totalLabel = (total > 0 ? `${processed}/${total}` : `${processed}`).padStart(
      totalLabelWidth,
    );
    const meter = renderMeter(processed, total, theme.color);
    const line = `${spinner} ${tint(theme.icon, theme.color)} ${bold(label.padEnd(8))} ${meter} ${dim(totalLabel)}  ${archived} new  ${skipped} unchanged`;
    this.clear();
    process.stdout.write(line);
  }

  private clear() {
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
  }
}

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
        `${summary.label.padEnd(8)} ${summary.archived} updated, ${summary.skipped} skipped`,
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

  console.log(
    `\n${bold("devlog archive")}  ${dim(formatDuration(durationMs))}  ${success(String(totalArchived))} updated  ${totalSkipped} unchanged`,
  );
  if (totalWarnings > 0) {
    console.log(`${bold("Warnings")} ${totalWarnings}`);
  }
}

export function printIndexSummary(
  stats: {
    sessionsIndexed: number;
    sessionsSkipped: number;
    messagesIndexed: number;
    errors: number;
  },
  dbPath: string,
  durationMs: number,
) {
  if (!isInteractiveTerminal()) {
    console.log("Index complete");
    console.log(`Sessions indexed: ${stats.sessionsIndexed}`);
    console.log(`Sessions skipped: ${stats.sessionsSkipped}`);
    console.log(`Messages indexed: ${stats.messagesIndexed}`);
    if (stats.errors > 0) {
      console.log(`Errors: ${stats.errors}`);
    }
    console.log(`Database: ${dbPath}`);
    return;
  }

  console.log(`\n${bold("devlog index")}`);
  console.log(dim(`Finished in ${formatDuration(durationMs)}  •  db ${dbPath}`));
  console.log("");
  console.log(
    `${tint("⌕", 32)} ${bold("Index")} ${dim("•")} ${stats.sessionsIndexed} new  ${stats.sessionsSkipped} unchanged  ${stats.messagesIndexed} messages`,
  );
  console.log("");
  console.log(
    `${success(bold("Indexed"))} ${success(String(stats.sessionsIndexed))} ${pluralize(stats.sessionsIndexed, "session")}`,
  );
  console.log(`${bold("Skipped")} ${stats.sessionsSkipped} unchanged`);
  console.log(`${bold("Messages")} ${stats.messagesIndexed}`);
  if (stats.errors > 0) {
    console.log(`${bold("Errors")} ${stats.errors}`);
  }
}

export const DEFAULT_CLI_OPTIONS: CliOptions = {
  verbose: false,
  debug: false,
};
