import path from "node:path";

import { loadConfig } from "./config.ts";
import { SOURCES, type Source } from "./parsers/types.ts";
import {
  DEFAULT_CLI_OPTIONS,
  formatIndexedTarget,
  formatParseWarning,
  printArchiveHeader,
  printArchiveSummary,
  printIndexSummary,
  printRunArchiveRows,
  printRunArchiveStage,
  printRunIndexResult,
  printRunIndexStage,
  ProgressReporter,
  type CliOptions,
  type SourceSummary,
} from "./progress.ts";
import { SOURCE_ADAPTERS } from "./sources/registry.ts";
import { ensureDir } from "./sources/shared.ts";

const config = loadConfig();
const ARCHIVE_DIR = config.archiveDir;
const PROJECTS_ARCHIVE_DIR = path.join(ARCHIVE_DIR, "projects");

function isExcluded(source: Source): boolean {
  return config.excludeSources.includes(source);
}

export async function archiveMain(options: CliOptions = DEFAULT_CLI_OPTIONS, combined = false) {
  const startedAt = Date.now();
  const progress = new ProgressReporter(options);

  ensureDir(ARCHIVE_DIR);
  ensureDir(PROJECTS_ARCHIVE_DIR);

  const summaries: SourceSummary[] = [];
  if (!combined) {
    printArchiveHeader(ARCHIVE_DIR, options);
  }

  for (const source of SOURCES) {
    if (!isExcluded(source)) {
      summaries.push(SOURCE_ADAPTERS[source].archive(options, progress));
    }
  }

  if (combined) {
    printRunArchiveRows(summaries);
  } else {
    printArchiveSummary(summaries, ARCHIVE_DIR, Date.now() - startedAt);
  }
  progress.flushWarnings();
}

export async function indexMain(
  rebuild: boolean,
  options: CliOptions = DEFAULT_CLI_OPTIONS,
  combined = false,
) {
  const { getDb, resetDb } = await import("./db.ts");
  const { indexAll } = await import("./indexer.ts");
  const startedAt = Date.now();
  const progress = new ProgressReporter(options);
  const dbPath = config.dbPath;

  if (options.verbose && !combined) {
    console.log(
      rebuild ? "🔄 Rebuilding index from scratch...\n" : "🔄 Indexing archived sessions...\n",
    );
  }

  if (rebuild) {
    resetDb(dbPath);
  }

  const db = getDb(dbPath);
  const stats = await indexAll(ARCHIVE_DIR, rebuild, db, {
    excludeSources: config.excludeSources,
    callbacks: {
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
    },
  });
  progress.end();

  if (!combined) {
    printIndexSummary(stats, dbPath, Date.now() - startedAt);
  }
  progress.flushWarnings();
  return stats;
}

export async function runMain(options: CliOptions = DEFAULT_CLI_OPTIONS, rebuild = false) {
  const startedAt = Date.now();
  printRunArchiveStage(ARCHIVE_DIR);
  await archiveMain(options, true);
  printRunIndexStage(rebuild);
  const stats = await indexMain(rebuild, options, true);
  printRunIndexResult(stats, Date.now() - startedAt);
}
