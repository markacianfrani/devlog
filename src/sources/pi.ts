import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadConfig } from "../config.ts";
import {
  createLogger,
  DEFAULT_CLI_OPTIONS,
  type CliOptions,
  type SourceSummary,
} from "../progress.ts";
import type { ProgressReporter } from "../progress.ts";
import { slugFromPath, archiveConversation, matchesExcludedProject } from "./shared.ts";
import {
  createArchiveStats,
  logProjectRollup,
  makeSummary,
  recordArchived,
  recordSkipped,
  type ArchiveStats,
} from "./types.ts";

const config = loadConfig();
const PI_SESSIONS_DIR = path.join(os.homedir(), ".pi", "agent", "sessions");

interface PiSessionHeader {
  type: "session";
  id?: string;
  cwd?: string;
}

export function getPiSessionHeader(filePath: string): PiSessionHeader | undefined {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const [firstLine = ""] = content.split("\n");
    const header = JSON.parse(firstLine) as PiSessionHeader;
    return header.type === "session" ? header : undefined;
  } catch {
    return undefined;
  }
}

function countPiUserMessages(filePath: string): number {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.trim().split("\n");
    let count = 0;

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as { type?: string; message?: { role?: string } };
        if (parsed.type === "message" && parsed.message?.role === "user") {
          count++;
        }
      } catch {
        // Ignore malformed lines when counting user messages.
      }
    }

    return count;
  } catch {
    return 0;
  }
}

// Pi writes sessions in two layouts that coexist on disk:
//   flat:   <project>/<id>.jsonl
//   nested: <project>/<topGroup>/<subagent>/run-<N>/session.jsonl  (pi-subagents)
// The nested layout has no session.jsonl at intermediate levels and every leaf
// shares the filename "session.jsonl", so the archive name folds the hierarchy
// in to avoid collisions: <topGroup>__<subagent>__run-<N>.jsonl.
function* iteratePiSessionFiles(): Generator<{ sourcePath: string; fileName: string }> {
  for (const sessionDir of fs.readdirSync(PI_SESSIONS_DIR)) {
    const dirPath = path.join(PI_SESSIONS_DIR, sessionDir);
    if (!fs.statSync(dirPath).isDirectory()) {
      continue;
    }

    for (const entry of fs.readdirSync(dirPath)) {
      const entryPath = path.join(dirPath, entry);
      if (entry.endsWith(".jsonl")) {
        yield { sourcePath: entryPath, fileName: entry };
        continue;
      }
      if (!fs.statSync(entryPath).isDirectory()) {
        continue;
      }
      yield* iteratePiSubagentFiles(entryPath, entry);
    }
  }
}

function* iteratePiSubagentFiles(
  topGroupDir: string,
  topGroup: string,
): Generator<{ sourcePath: string; fileName: string }> {
  for (const subagent of fs.readdirSync(topGroupDir)) {
    const subagentDir = path.join(topGroupDir, subagent);
    if (!fs.statSync(subagentDir).isDirectory()) {
      continue;
    }

    for (const runEntry of fs.readdirSync(subagentDir)) {
      const sourcePath = path.join(subagentDir, runEntry, "session.jsonl");
      if (!fs.existsSync(sourcePath)) {
        continue;
      }
      yield { sourcePath, fileName: `${topGroup}__${subagent}__${runEntry}.jsonl` };
    }
  }
}

function archiveSinglePiSession(
  sourcePath: string,
  fileName: string,
  projectStats: Map<string, { total: number; archived: number; messages: number }>,
  stats: ArchiveStats,
  progress?: ProgressReporter,
): { archived: boolean; messages: number; skipped: boolean } {
  const excludeProjects = config.excludeProjects;
  const archiveDir = config.archiveDir;
  const projectsArchiveDir = path.join(archiveDir, "projects");

  const header = getPiSessionHeader(sourcePath);
  if (!header?.cwd) {
    progress?.warn(`[devlog] Failed to determine pi project for ${sourcePath}`);
    return { archived: false, messages: 0, skipped: false };
  }

  const projectSlug = slugFromPath(header.cwd);
  if (matchesExcludedProject(excludeProjects, projectSlug, header.cwd)) {
    return { archived: false, messages: 0, skipped: false };
  }

  const pStats = projectStats.get(projectSlug) ?? { total: 0, archived: 0, messages: 0 };
  pStats.total++;
  projectStats.set(projectSlug, pStats);

  const didArchive = archiveConversation(
    sourcePath,
    projectSlug,
    projectsArchiveDir,
    `pi/${fileName}`,
  );
  if (!didArchive) {
    recordSkipped(stats, progress);
    return { archived: false, messages: 0, skipped: true };
  }

  const userMessages = countPiUserMessages(sourcePath);
  pStats.archived++;
  pStats.messages += userMessages;
  recordArchived(stats, userMessages, progress);
  return { archived: true, messages: userMessages, skipped: false };
}

export function countSessions(): number {
  if (!fs.existsSync(PI_SESSIONS_DIR)) {
    return 0;
  }

  let total = 0;
  for (const { sourcePath } of iteratePiSessionFiles()) {
    const header = getPiSessionHeader(sourcePath);
    const projectSlug = header?.cwd ? slugFromPath(header.cwd) : undefined;
    if (matchesExcludedProject(config.excludeProjects, projectSlug, header?.cwd)) {
      continue;
    }

    total++;
  }

  return total;
}

export function archive(
  options: CliOptions = DEFAULT_CLI_OPTIONS,
  progress?: ProgressReporter,
): SourceSummary {
  const logger = createLogger(options);
  if (!fs.existsSync(PI_SESSIONS_DIR)) {
    progress?.warn(`[devlog] pi sessions directory not found: ${PI_SESSIONS_DIR}`);
    return makeSummary("pi", createArchiveStats(), "messages", 1);
  }

  const stats = createArchiveStats();
  const projectStats = new Map<string, { total: number; archived: number; messages: number }>();

  progress?.start("pi");
  progress?.setTotal(countSessions());

  for (const { sourcePath, fileName } of iteratePiSessionFiles()) {
    archiveSinglePiSession(sourcePath, fileName, projectStats, stats, progress);
  }

  for (const [projectSlug, pStats] of projectStats) {
    logger.verbose(`📁 Project: ${projectSlug} (${pStats.total} sessions)`);
    logProjectRollup(
      logger,
      options.verbose,
      projectSlug,
      pStats.archived,
      pStats.messages,
      "messages",
    );
  }

  progress?.end();
  return makeSummary("pi", stats, "messages");
}
