import path from "node:path";
import { loadConfig, type Source } from "./config.ts";
import {
  DEFAULT_CLI_OPTIONS,
  formatIndexedTarget,
  formatParseWarning,
  printArchiveSummary,
  printIndexSummary,
  ProgressReporter,
  type CliOptions,
  type SourceSummary,
} from "./progress.ts";
import { ensureDir } from "./sources/shared.ts";
import * as claude from "./sources/claude.ts";
import * as opencode from "./sources/opencode.ts";
import * as pi from "./sources/pi.ts";

const config = loadConfig();
const ARCHIVE_DIR = config.archiveDir;
const PROJECTS_ARCHIVE_DIR = path.join(ARCHIVE_DIR, "projects");

function isExcluded(source: Source): boolean {
  return config.excludeSources.includes(source);
}

export async function archiveMain(options: CliOptions = DEFAULT_CLI_OPTIONS) {
  const startedAt = Date.now();
  const progress = new ProgressReporter(options);

  ensureDir(ARCHIVE_DIR);
  ensureDir(PROJECTS_ARCHIVE_DIR);

  const summaries: SourceSummary[] = [];

  if (!isExcluded("claude")) {
    summaries.push(claude.archive(options, progress));
  }

  if (!isExcluded("opencode")) {
    summaries.push(opencode.archive(options, progress));
  }

  if (!isExcluded("pi")) {
    summaries.push(pi.archive(options, progress));
  }

  printArchiveSummary(summaries, ARCHIVE_DIR, Date.now() - startedAt);
  progress.flushWarnings();
}

export async function indexMain(rebuild: boolean, options: CliOptions = DEFAULT_CLI_OPTIONS) {
  const { getDb, resetDb } = await import("./db.ts");
  const { indexAll } = await import("./indexer.ts");
  const startedAt = Date.now();
  const progress = new ProgressReporter(options);
  const dbPath = config.dbPath;

  if (options.verbose) {
    console.log(
      rebuild ? "🔄 Rebuilding index from scratch...\n" : "🔄 Indexing archived sessions...\n",
    );
  }

  if (rebuild) {
    resetDb(dbPath);
  }

  const db = getDb(dbPath);
  const stats = await indexAll(ARCHIVE_DIR, rebuild, db, {
    onStart(total) {
      progress.start("index", total);
    },
    onTick(processed, currentStats) {
      progress.tick({
        processed,
        archived: currentStats.sessionsIndexed,
        skipped: currentStats.sessionsSkipped,
      });
    },
    onIndexed() {},
    onWarning(warning) {
      progress.warn(formatParseWarning(warning));
    },
    onError(event) {
      progress.warn(
        `[devlog] Failed indexing ${formatIndexedTarget(event.filePath, ARCHIVE_DIR)}: ${event.error}`,
      );
    },
  });
  progress.end();

  printIndexSummary(stats, dbPath, Date.now() - startedAt);
  progress.flushWarnings();
}

// Re-exports for backward compatibility with tests importing from archive.ts
export {
  iterateOpencodeDbSessions,
  reconstructSessionJsonl,
  type MessageWithParts,
  type OpencodeSession,
} from "./sources/opencode.ts";
export { slugFromPath } from "./sources/shared.ts";
