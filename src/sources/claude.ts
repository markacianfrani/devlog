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
import { createArchiveStats, makeSummary, type ArchiveStats } from "./types.ts";

const config = loadConfig();
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

interface ConversationFile {
  sourcePath: string;
  archiveRelPath: string; // relative to {archiveBaseDir}/{projectName}
}

function getConversationFiles(projectPath: string): ConversationFile[] {
  const results: ConversationFile[] = [];

  for (const entry of fs.readdirSync(projectPath)) {
    if (entry.endsWith(".jsonl")) {
      results.push({
        sourcePath: path.join(projectPath, entry),
        archiveRelPath: `claude/${entry}`,
      });
    } else {
      const subagentDir = path.join(projectPath, entry, "subagents");
      if (fs.existsSync(subagentDir) && fs.statSync(subagentDir).isDirectory()) {
        for (const agentFile of fs.readdirSync(subagentDir)) {
          if (agentFile.endsWith(".jsonl")) {
            results.push({
              sourcePath: path.join(subagentDir, agentFile),
              archiveRelPath: `claude/${entry}/subagents/${agentFile}`,
            });
          }
        }
      }
    }
  }

  return results;
}

function getClaudeProjectSlug(projectName: string): string {
  if (projectName.startsWith("-")) {
    return projectName;
  }

  return slugFromPath(projectName);
}

function countExchanges(filePath: string): number {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.trim().split("\n");
    let count = 0;

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === "user") {
          count++;
        }
      } catch {
        // Ignore malformed lines when counting exchanges.
      }
    }

    return count;
  } catch {
    return 0;
  }
}

function tickArchiveProgress(progress: ProgressReporter | undefined, stats: ArchiveStats) {
  progress?.tick({ processed: stats.processed, archived: stats.archived, skipped: stats.skipped });
}

function recordArchived(stats: ArchiveStats, activity: number, progress?: ProgressReporter) {
  stats.archived++;
  stats.activity += activity;
  stats.processed++;
  tickArchiveProgress(progress, stats);
}

function recordSkipped(stats: ArchiveStats, progress?: ProgressReporter) {
  stats.skipped++;
  stats.processed++;
  tickArchiveProgress(progress, stats);
}

function logProjectRollup(
  logger: ReturnType<typeof createLogger>,
  verbose: boolean,
  projectSlug: string,
  archived: number,
  activity: number,
  activityLabel: string,
) {
  if (!verbose) {
    return;
  }

  if (archived > 0) {
    logger.verbose(`  📊 ${projectSlug}: ${archived} new, ${activity} ${activityLabel}\n`);
  } else {
    logger.verbose(`  📊 ${projectSlug}: all up to date\n`);
  }
}

function archiveClaudeProject(
  project: string,
  logger: ReturnType<typeof createLogger>,
  options: CliOptions,
  stats: ArchiveStats,
  progress?: ProgressReporter,
) {
  const excludeProjects = config.excludeProjects;
  if (matchesExcludedProject(excludeProjects, project)) {
    logger.verbose(`🚫 Skipping excluded project: ${project}`);
    return;
  }

  const projectPath = path.join(CLAUDE_PROJECTS_DIR, project);
  if (!fs.statSync(projectPath).isDirectory()) {
    return;
  }

  const conversationFiles = getConversationFiles(projectPath);
  if (conversationFiles.length === 0) {
    return;
  }

  const projectSlug = getClaudeProjectSlug(project);
  const archiveDir = config.archiveDir;
  const projectsArchiveDir = path.join(archiveDir, "projects");

  logger.verbose(`📁 Project: ${projectSlug} (${conversationFiles.length} conversations)`);

  let projectArchived = 0;
  let projectExchanges = 0;
  for (const { sourcePath, archiveRelPath } of conversationFiles) {
    if (!archiveConversation(sourcePath, projectSlug, projectsArchiveDir, archiveRelPath)) {
      logger.verbose(`  ⏭️  Skipped: ${archiveRelPath} (already archived)`);
      recordSkipped(stats, progress);
      continue;
    }

    const exchanges = countExchanges(sourcePath);
    logger.verbose(`  ✅ Archived: ${archiveRelPath} (${exchanges} exchanges)`);
    projectArchived++;
    projectExchanges += exchanges;
    recordArchived(stats, exchanges, progress);
  }

  logProjectRollup(
    logger,
    options.verbose,
    projectSlug,
    projectArchived,
    projectExchanges,
    "exchanges",
  );
}

export function countSessions(): number {
  const excludeProjects = config.excludeProjects;
  if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) {
    return 0;
  }

  let total = 0;

  for (const project of fs.readdirSync(CLAUDE_PROJECTS_DIR)) {
    if (matchesExcludedProject(excludeProjects, project)) {
      continue;
    }

    const projectPath = path.join(CLAUDE_PROJECTS_DIR, project);
    if (!fs.statSync(projectPath).isDirectory()) {
      continue;
    }

    total += getConversationFiles(projectPath).length;
  }

  return total;
}

export function archive(
  options: CliOptions = DEFAULT_CLI_OPTIONS,
  progress?: ProgressReporter,
): SourceSummary {
  const logger = createLogger(options);
  if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) {
    progress?.warn(`[devlog] Claude projects directory not found: ${CLAUDE_PROJECTS_DIR}`);
    return makeSummary("Claude", createArchiveStats(), "exchanges", 1);
  }

  const stats = createArchiveStats();
  progress?.start("Claude");
  progress?.setTotal(countSessions());

  for (const project of fs.readdirSync(CLAUDE_PROJECTS_DIR)) {
    archiveClaudeProject(project, logger, options, stats, progress);
  }

  progress?.end();
  return makeSummary("Claude", stats, "exchanges");
}
