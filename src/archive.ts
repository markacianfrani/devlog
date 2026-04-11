#!/usr/bin/env bun

import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  countUserMessages,
  iterateOpencodeDbSessions,
  loadMessagesFromFiles,
  reconstructSessionJsonl,
  type OpencodeSession,
} from "./opencode.ts";
import {
  createLogger,
  DEFAULT_CLI_OPTIONS,
  formatIndexedTarget,
  printArchiveSummary,
  printIndexSummary,
  ProgressReporter,
  type CliOptions,
  type SourceSummary,
} from "./progress.ts";

interface Config {
  archiveDir?: string;
  excludeProjects?: string[];
}

const CONFIG_PATH = path.join(os.homedir(), ".config", "devlog", "config.json");

function loadConfig(): Required<Config> {
  const defaults = {
    archiveDir: path.join(os.homedir(), ".config", "devlog"),
    excludeProjects: [] as string[],
  };

  if (!fs.existsSync(CONFIG_PATH)) {
    return defaults;
  }

  try {
    const content = fs.readFileSync(CONFIG_PATH, "utf-8");
    const config: Config = JSON.parse(content);

    return {
      archiveDir: config.archiveDir ?? defaults.archiveDir,
      excludeProjects: config.excludeProjects ?? defaults.excludeProjects,
    };
  } catch {
    return defaults;
  }
}

const config = loadConfig();
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");
const OPENCODE_DB_PATH = path.join(os.homedir(), ".local", "share", "opencode", "opencode.db");
const OPENCODE_STORAGE_DIR = path.join(os.homedir(), ".local", "share", "opencode", "storage");
const OPENCODE_SESSIONS_DIR = path.join(OPENCODE_STORAGE_DIR, "session");
const OPENCODE_PROJECT_DIR = path.join(OPENCODE_STORAGE_DIR, "project");
const OPENCODE_MESSAGE_DIR = path.join(OPENCODE_STORAGE_DIR, "message");
const OPENCODE_PART_DIR = path.join(OPENCODE_STORAGE_DIR, "part");
const PI_SESSIONS_DIR = path.join(os.homedir(), ".pi", "agent", "sessions");
const ARCHIVE_DIR = config.archiveDir;
const PROJECTS_ARCHIVE_DIR = path.join(ARCHIVE_DIR, "projects");

function ensureDir(dirPath: string) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

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

function normalizeProjectMatcher(value: string): string {
  return value.trim().toLowerCase();
}

function matchesExcludedProject(...candidates: Array<string | undefined>): boolean {
  const haystacks = candidates
    .filter((candidate): candidate is string => Boolean(candidate))
    .map(normalizeProjectMatcher);

  return config.excludeProjects
    .map(normalizeProjectMatcher)
    .filter(Boolean)
    .some((excludedProject) => haystacks.some((candidate) => candidate.includes(excludedProject)));
}

function countClaudeConversations(): number {
  if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) {
    return 0;
  }

  let total = 0;

  for (const project of fs.readdirSync(CLAUDE_PROJECTS_DIR)) {
    if (matchesExcludedProject(project)) {
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

function slugFromPath(projectPath: string): string {
  const segments = path
    .resolve(projectPath)
    .split(path.sep)
    .filter(Boolean)
    .map((segment) => segment.replace(/[^a-zA-Z0-9]/g, "-"))
    .join("-");

  return `-${segments}`;
}

function getClaudeProjectSlug(projectName: string): string {
  if (projectName.startsWith("-")) {
    return projectName;
  }

  return slugFromPath(projectName);
}

function archiveConversation(
  sourcePath: string,
  projectName: string,
  archiveBaseDir: string,
  archiveRelPath: string,
) {
  const archivePath = path.join(archiveBaseDir, projectName, archiveRelPath);

  ensureDir(path.dirname(archivePath));

  if (fs.existsSync(archivePath)) {
    const sourceMtime = fs.statSync(sourcePath).mtimeMs;
    const archiveMtime = fs.statSync(archivePath).mtimeMs;
    if (sourceMtime <= archiveMtime) {
      return false;
    }
  }

  fs.copyFileSync(sourcePath, archivePath);
  return true;
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

interface PiSessionHeader {
  type: "session";
  id?: string;
  cwd?: string;
}

function getPiSessionHeader(filePath: string): PiSessionHeader | undefined {
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

function getOpencodeSessionFiles(workspacePath: string): string[] {
  return fs
    .readdirSync(workspacePath)
    .filter((f) => f.startsWith("ses_") && f.endsWith(".json"))
    .map((f) => path.join(workspacePath, f));
}

function countOpencodeFileSessions(): number {
  if (!fs.existsSync(OPENCODE_SESSIONS_DIR)) {
    return 0;
  }

  let total = 0;
  for (const workspace of fs.readdirSync(OPENCODE_SESSIONS_DIR)) {
    const workspacePath = path.join(OPENCODE_SESSIONS_DIR, workspace);
    if (!fs.statSync(workspacePath).isDirectory()) {
      continue;
    }

    const projectFile = path.join(OPENCODE_PROJECT_DIR, `${workspace}.json`);
    const worktree = getWorktreeFromProjectFile(projectFile);
    const projectSlug = getOpencodeProjectSlug(workspace, projectFile);
    if (matchesExcludedProject(workspace, projectSlug, worktree)) {
      continue;
    }

    total += getOpencodeSessionFiles(workspacePath).length;
  }

  return total;
}

function countPiSessions(): number {
  if (!fs.existsSync(PI_SESSIONS_DIR)) {
    return 0;
  }

  let total = 0;
  for (const sessionDir of fs.readdirSync(PI_SESSIONS_DIR)) {
    const dirPath = path.join(PI_SESSIONS_DIR, sessionDir);
    if (!fs.statSync(dirPath).isDirectory()) {
      continue;
    }

    for (const entry of fs.readdirSync(dirPath)) {
      if (!entry.endsWith(".jsonl")) {
        continue;
      }

      const sourcePath = path.join(dirPath, entry);
      const header = getPiSessionHeader(sourcePath);
      const projectSlug = header?.cwd ? slugFromPath(header.cwd) : undefined;
      if (matchesExcludedProject(projectSlug, header?.cwd)) {
        continue;
      }

      total++;
    }
  }

  return total;
}

function getOpencodeDbSessionCount(db: Database): number {
  const row = db.query<{ count: number }, []>("SELECT COUNT(*) as count FROM session").get();
  return row?.count ?? 0;
}

function getWorktreeFromProjectFile(projectFile: string): string | undefined {
  if (!fs.existsSync(projectFile)) {
    return undefined;
  }

  try {
    const content = fs.readFileSync(projectFile, "utf-8");
    const parsed = JSON.parse(content) as { worktree?: string };
    return parsed.worktree;
  } catch {
    return undefined;
  }
}

function getOpencodeProjectSlug(workspaceHash: string, projectFilePath?: string): string {
  const projectFile = projectFilePath ?? path.join(OPENCODE_PROJECT_DIR, `${workspaceHash}.json`);
  const worktree = getWorktreeFromProjectFile(projectFile);
  return worktree ? slugFromPath(worktree) : workspaceHash;
}

function archiveOpencodeProject(
  workspaceHash: string,
  projectSlug: string,
  archiveBaseDir: string,
): boolean {
  const projectFile = path.join(OPENCODE_PROJECT_DIR, `${workspaceHash}.json`);
  const archivePath = path.join(
    archiveBaseDir,
    projectSlug,
    "opencode",
    workspaceHash,
    "project.json",
  );

  if (!fs.existsSync(projectFile)) {
    return false;
  }

  ensureDir(path.dirname(archivePath));

  if (!fs.existsSync(archivePath)) {
    fs.copyFileSync(projectFile, archivePath);
    return true;
  }

  return false;
}

function archiveOpencodeSession(
  sessionFilePath: string,
  projectSlug: string,
  archiveBaseDir: string,
): { archived: boolean; messages: number; error?: string } {
  let sessionContent: string;
  try {
    sessionContent = fs.readFileSync(sessionFilePath, "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[devlog] Failed to read session file ${sessionFilePath}: ${msg}`);
    return { archived: false, messages: 0, error: msg };
  }

  let session: OpencodeSession;
  try {
    session = JSON.parse(sessionContent) as OpencodeSession;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[devlog] Failed to parse session file ${sessionFilePath}: ${msg}`);
    return { archived: false, messages: 0, error: msg };
  }

  const sessionId = session.id;
  const archivePath = path.join(archiveBaseDir, projectSlug, "opencode", `${sessionId}.jsonl`);

  if (fs.existsSync(archivePath)) {
    const archiveMtime = fs.statSync(archivePath).mtimeMs;
    if (session.time.updated <= archiveMtime) {
      return { archived: false, messages: 0 };
    }
  }

  const messagesWithParts = loadMessagesFromFiles(
    sessionId,
    OPENCODE_MESSAGE_DIR,
    OPENCODE_PART_DIR,
  );
  const lines = reconstructSessionJsonl(sessionId, session, messagesWithParts);

  if (lines.length === 0) {
    return { archived: false, messages: 0 };
  }

  try {
    ensureDir(path.dirname(archivePath));
    fs.writeFileSync(archivePath, lines.join("\n") + "\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[devlog] Failed to write archive ${archivePath}: ${msg}`);
    return { archived: false, messages: 0, error: msg };
  }

  const userMessages = countUserMessages(messagesWithParts);
  return { archived: true, messages: userMessages };
}

function archiveClaudeProjects(
  options: CliOptions = DEFAULT_CLI_OPTIONS,
  progress?: ProgressReporter,
): SourceSummary {
  const logger = createLogger(options);
  if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) {
    progress?.warn(`[devlog] Claude projects directory not found: ${CLAUDE_PROJECTS_DIR}`);
    return {
      label: "Claude",
      archived: 0,
      skipped: 0,
      activity: 0,
      activityLabel: "exchanges",
      warnings: 1,
    };
  }

  let archived = 0;
  let skipped = 0;
  let exchanges = 0;
  let processed = 0;

  progress?.start("Claude");
  progress?.setTotal(countClaudeConversations());

  for (const project of fs.readdirSync(CLAUDE_PROJECTS_DIR)) {
    if (matchesExcludedProject(project)) {
      logger.verbose(`🚫 Skipping excluded project: ${project}`);
      continue;
    }

    const projectPath = path.join(CLAUDE_PROJECTS_DIR, project);
    if (!fs.statSync(projectPath).isDirectory()) {
      continue;
    }

    const conversationFiles = getConversationFiles(projectPath);
    if (conversationFiles.length === 0) {
      continue;
    }

    const projectSlug = getClaudeProjectSlug(project);
    logger.verbose(`📁 Project: ${projectSlug} (${conversationFiles.length} conversations)`);

    let projectArchived = 0;
    let projectExchanges = 0;

    for (const { sourcePath, archiveRelPath } of conversationFiles) {
      const didArchive = archiveConversation(
        sourcePath,
        projectSlug,
        PROJECTS_ARCHIVE_DIR,
        archiveRelPath,
      );

      if (didArchive) {
        const ex = countExchanges(sourcePath);
        logger.verbose(`  ✅ Archived: ${archiveRelPath} (${ex} exchanges)`);
        projectArchived++;
        projectExchanges += ex;
        archived++;
        exchanges += ex;
        processed++;
        progress?.tick({ processed, archived, skipped });
      } else {
        logger.verbose(`  ⏭️  Skipped: ${archiveRelPath} (already archived)`);
        skipped++;
        processed++;
        progress?.tick({ processed, archived, skipped });
      }
    }

    if (options.verbose) {
      if (projectArchived > 0) {
        logger.verbose(
          `  📊 ${projectSlug}: ${projectArchived} new, ${projectExchanges} exchanges\n`,
        );
      } else {
        logger.verbose(`  📊 ${projectSlug}: all up to date\n`);
      }
    }
  }

  progress?.end();

  return {
    label: "Claude",
    archived,
    skipped,
    activity: exchanges,
    activityLabel: "exchanges",
    warnings: 0,
  };
}

function archiveOpencodeFromDb(
  options: CliOptions = DEFAULT_CLI_OPTIONS,
  progress?: ProgressReporter,
): { handled: boolean; summary: SourceSummary } {
  const logger = createLogger(options);
  if (!fs.existsSync(OPENCODE_DB_PATH)) {
    return {
      handled: false,
      summary: {
        label: "opencode",
        archived: 0,
        skipped: 0,
        activity: 0,
        activityLabel: "messages",
        warnings: 0,
      },
    };
  }

  let archived = 0;
  let skipped = 0;
  let messages = 0;

  try {
    const db = new Database(OPENCODE_DB_PATH, { readonly: true });
    try {
      logger.verbose("🟦 Processing opencode sessions (from DB)...\n");
      progress?.start("opencode");
      progress?.setTotal(getOpencodeDbSessionCount(db));

      let processed = 0;

      for (const { projectSlug, session, messagesWithParts } of iterateOpencodeDbSessions(
        db,
        slugFromPath,
      )) {
        if (matchesExcludedProject(projectSlug, session.directory)) {
          logger.verbose(`🚫 Skipping excluded project: ${projectSlug}`);
          continue;
        }

        const archivePath = path.join(
          PROJECTS_ARCHIVE_DIR,
          projectSlug,
          "opencode",
          `${session.id}.jsonl`,
        );

        if (fs.existsSync(archivePath)) {
          const archiveMtime = fs.statSync(archivePath).mtimeMs;
          if (session.time.updated <= archiveMtime) {
            skipped++;
            logger.verbose(`  ⏭️  Skipped: ${session.id} (already archived)`);
            processed++;
            progress?.tick({ processed, archived, skipped });
            continue;
          }
        }

        const lines = reconstructSessionJsonl(session.id, session, messagesWithParts);
        if (lines.length === 0) {
          processed++;
          skipped++;
          progress?.tick({ processed, archived, skipped });
          continue;
        }

        ensureDir(path.dirname(archivePath));
        fs.writeFileSync(archivePath, lines.join("\n") + "\n");

        const userMessages = countUserMessages(messagesWithParts);
        logger.verbose(`  ✅ Archived: ${session.id}.jsonl (${userMessages} messages)`);
        logger.verbose(`  📁 Project: ${projectSlug}`);
        archived++;
        messages += userMessages;
        processed++;
        progress?.tick({ processed, archived, skipped });
      }
    } finally {
      progress?.end();
      db.close();
    }
    return {
      handled: true,
      summary: {
        label: "opencode",
        archived,
        skipped,
        activity: messages,
        activityLabel: "messages",
        warnings: 0,
      },
    };
  } catch (err) {
    progress?.warn(
      `[devlog] Failed to read opencode DB, falling back to flat files: ${err instanceof Error ? err.message : err}`,
    );
    return {
      handled: false,
      summary: {
        label: "opencode",
        archived: 0,
        skipped: 0,
        activity: 0,
        activityLabel: "messages",
        warnings: 1,
      },
    };
  }
}

function archiveOpencodeFromFiles(
  options: CliOptions = DEFAULT_CLI_OPTIONS,
  progress?: ProgressReporter,
): SourceSummary {
  const logger = createLogger(options);
  logger.verbose("🟦 Processing opencode sessions (from flat files)...\n");

  let archived = 0;
  let skipped = 0;
  let messages = 0;
  let processed = 0;

  progress?.start("opencode");
  progress?.setTotal(countOpencodeFileSessions());

  for (const workspace of fs.readdirSync(OPENCODE_SESSIONS_DIR)) {
    const workspacePath = path.join(OPENCODE_SESSIONS_DIR, workspace);
    if (!fs.statSync(workspacePath).isDirectory()) {
      continue;
    }

    const sessionFiles = getOpencodeSessionFiles(workspacePath);
    if (sessionFiles.length === 0) {
      continue;
    }

    const projectFile = path.join(OPENCODE_PROJECT_DIR, `${workspace}.json`);
    const worktree = getWorktreeFromProjectFile(projectFile);
    const projectSlug = getOpencodeProjectSlug(workspace, projectFile);
    if (matchesExcludedProject(workspace, projectSlug, worktree)) {
      logger.verbose(`🚫 Skipping excluded project: ${projectSlug}`);
      continue;
    }

    logger.verbose(`📁 Project: ${projectSlug} (${sessionFiles.length} sessions)`);

    const projectArchived = archiveOpencodeProject(workspace, projectSlug, PROJECTS_ARCHIVE_DIR);
    if (projectArchived) {
      logger.verbose(`  ✅ Archived: project.json (metadata)`);
    }

    let workspaceArchived = 0;
    let workspaceMessages = 0;

    for (const filePath of sessionFiles) {
      const fileName = path.basename(filePath, ".json");
      const result = archiveOpencodeSession(filePath, projectSlug, PROJECTS_ARCHIVE_DIR);

      if (result.archived) {
        logger.verbose(`  ✅ Archived: ${fileName}.jsonl (${result.messages} messages)`);
        workspaceArchived++;
        workspaceMessages += result.messages;
        archived++;
        messages += result.messages;
        processed++;
        progress?.tick({ processed, archived, skipped });
      } else {
        logger.verbose(`  ⏭️  Skipped: ${fileName} (already archived or empty)`);
        skipped++;
        processed++;
        progress?.tick({ processed, archived, skipped });
      }
    }

    if (options.verbose) {
      if (workspaceArchived > 0) {
        logger.verbose(
          `  📊 ${projectSlug}: ${workspaceArchived} new, ${workspaceMessages} messages\n`,
        );
      } else {
        logger.verbose(`  📊 ${projectSlug}: all up to date\n`);
      }
    }
  }

  progress?.end();

  return {
    label: "opencode",
    archived,
    skipped,
    activity: messages,
    activityLabel: "messages",
    warnings: 0,
  };
}

function* iteratePiSessionFiles(): Generator<{ sourcePath: string; fileName: string }> {
  for (const sessionDir of fs.readdirSync(PI_SESSIONS_DIR)) {
    const dirPath = path.join(PI_SESSIONS_DIR, sessionDir);
    if (!fs.statSync(dirPath).isDirectory()) {
      continue;
    }

    for (const entry of fs.readdirSync(dirPath)) {
      if (entry.endsWith(".jsonl")) {
        yield { sourcePath: path.join(dirPath, entry), fileName: entry };
      }
    }
  }
}

function archiveSinglePiSession(
  sourcePath: string,
  fileName: string,
  projectStats: Map<string, { total: number; archived: number; messages: number }>,
  progress?: ProgressReporter,
): { archived: boolean; messages: number; skipped: boolean } {
  const header = getPiSessionHeader(sourcePath);
  if (!header?.cwd) {
    progress?.warn(`[devlog] Failed to determine pi project for ${sourcePath}`);
    return { archived: false, messages: 0, skipped: false };
  }

  const projectSlug = slugFromPath(header.cwd);
  if (matchesExcludedProject(projectSlug, header.cwd)) {
    return { archived: false, messages: 0, skipped: false };
  }

  const stats = projectStats.get(projectSlug) ?? { total: 0, archived: 0, messages: 0 };
  stats.total++;
  projectStats.set(projectSlug, stats);

  const didArchive = archiveConversation(
    sourcePath,
    projectSlug,
    PROJECTS_ARCHIVE_DIR,
    `pi/${fileName}`,
  );
  if (!didArchive) {
    return { archived: false, messages: 0, skipped: true };
  }

  const userMessages = countPiUserMessages(sourcePath);
  stats.archived++;
  stats.messages += userMessages;
  return { archived: true, messages: userMessages, skipped: false };
}

function archivePiSessions(
  options: CliOptions = DEFAULT_CLI_OPTIONS,
  progress?: ProgressReporter,
): SourceSummary {
  const logger = createLogger(options);
  if (!fs.existsSync(PI_SESSIONS_DIR)) {
    progress?.warn(`[devlog] pi sessions directory not found: ${PI_SESSIONS_DIR}`);
    return {
      label: "pi",
      archived: 0,
      skipped: 0,
      activity: 0,
      activityLabel: "messages",
      warnings: 1,
    };
  }

  let archived = 0;
  let skipped = 0;
  let messages = 0;
  const projectStats = new Map<string, { total: number; archived: number; messages: number }>();
  let processed = 0;

  progress?.start("pi");
  progress?.setTotal(countPiSessions());

  for (const { sourcePath, fileName } of iteratePiSessionFiles()) {
    processed++;
    const result = archiveSinglePiSession(sourcePath, fileName, projectStats, progress);
    if (result.archived) {
      archived++;
      messages += result.messages;
    } else if (result.skipped) {
      skipped++;
    }
    progress?.tick({ processed, archived, skipped });
  }

  for (const [projectSlug, stats] of projectStats) {
    if (options.verbose) {
      logger.verbose(`📁 Project: ${projectSlug} (${stats.total} sessions)`);
      if (stats.archived > 0) {
        logger.verbose(`  📊 ${projectSlug}: ${stats.archived} new, ${stats.messages} messages\n`);
      } else {
        logger.verbose(`  📊 ${projectSlug}: all up to date\n`);
      }
    }
  }

  progress?.end();

  return {
    label: "pi",
    archived,
    skipped,
    activity: messages,
    activityLabel: "messages",
    warnings: 0,
  };
}

async function archiveMain(options: CliOptions = DEFAULT_CLI_OPTIONS) {
  const startedAt = Date.now();
  const progress = new ProgressReporter(options);

  ensureDir(ARCHIVE_DIR);
  ensureDir(PROJECTS_ARCHIVE_DIR);

  const claude = archiveClaudeProjects(options, progress);
  const opencodeDb = archiveOpencodeFromDb(options, progress);
  const pi = archivePiSessions(options, progress);

  let opencode = opencodeDb.summary;

  if (!opencodeDb.handled) {
    if (fs.existsSync(OPENCODE_SESSIONS_DIR)) {
      const opencodeFiles = archiveOpencodeFromFiles(options, progress);
      opencode = {
        ...opencodeFiles,
        warnings: opencode.warnings + opencodeFiles.warnings,
      };
    } else {
      progress.warn("[devlog] opencode storage not found");
      opencode = { ...opencode, warnings: opencode.warnings + 1 };
    }
  }

  printArchiveSummary([claude, opencode, pi], ARCHIVE_DIR, Date.now() - startedAt);
}

async function indexMain(rebuild: boolean, options: CliOptions = DEFAULT_CLI_OPTIONS) {
  const { getDb, resetDb, DEFAULT_DB_PATH } = await import("./db.ts");
  const { indexAll } = await import("./indexer.ts");
  const startedAt = Date.now();
  const progress = new ProgressReporter(options);

  if (options.verbose) {
    console.log(
      rebuild ? "🔄 Rebuilding index from scratch...\n" : "🔄 Indexing archived sessions...\n",
    );
  }

  if (rebuild) {
    resetDb(DEFAULT_DB_PATH);
  }

  const db = getDb(DEFAULT_DB_PATH);
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
    onError(event) {
      progress.warn(
        `[devlog] Failed indexing ${formatIndexedTarget(event.filePath, ARCHIVE_DIR)}: ${event.error}`,
      );
    },
  });
  progress.end();

  printIndexSummary(stats, DEFAULT_DB_PATH, Date.now() - startedAt);
}

export {
  iterateOpencodeDbSessions,
  reconstructSessionJsonl,
  type MessageWithParts,
  type OpencodeSession,
} from "./opencode.ts";
export { slugFromPath };

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: devlog [archive|index|mcp|init] [options]");
    console.log("");
    console.log("Commands:");
    console.log("  archive    Archive Claude Code, opencode, and pi sessions (default)");
    console.log("  index      Index archived sessions into SQLite database");
    console.log("  mcp        Start the MCP server (stdio)");
    console.log("  init       Set up devlog and install MCP servers");
    console.log("");
    console.log("Options:");
    console.log("  --rebuild  (index only) Re-index all sessions, ignoring cache");
    console.log("  --verbose  Show per-project and per-session details");
    console.log("  --debug    Include noisy debug logs");
    console.log("  --help     Show this help message");
    return;
  }

  const command = args.find((arg) => !arg.startsWith("--")) ?? "archive";
  const options: CliOptions = {
    verbose: args.includes("--verbose"),
    debug: args.includes("--debug"),
  };

  switch (command) {
    case "archive":
      await archiveMain(options);
      break;
    case "index": {
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
      console.log("Usage: devlog [archive|index|mcp|init] [--rebuild] [--verbose] [--debug]");
      console.log("");
      console.log("Commands:");
      console.log("  archive    Archive Claude Code, opencode, and pi sessions (default)");
      console.log("  index      Index archived sessions into SQLite database");
      console.log("  mcp        Start the MCP server (stdio)");
      console.log("  init       Set up devlog and install MCP servers");
      console.log("");
      console.log("Options:");
      console.log("  --rebuild  Re-index all sessions, ignoring cache");
      console.log("  --verbose  Show per-project and per-session details");
      console.log("  --debug    Include noisy debug logs");
      process.exit(1);
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error("❌ Error:", error.message);
    process.exit(1);
  });
}
