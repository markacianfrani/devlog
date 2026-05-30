import { Database } from "bun:sqlite";
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
import { ensureDir, slugFromPath, matchesExcludedProject } from "./shared.ts";
import {
  createArchiveStats,
  logProjectRollup,
  makeSummary,
  recordArchived,
  recordSkipped,
  type ArchiveStats,
} from "./types.ts";

const config = loadConfig();
const OPENCODE_DB_PATH = path.join(os.homedir(), ".local", "share", "opencode", "opencode.db");
const OPENCODE_STORAGE_DIR = path.join(os.homedir(), ".local", "share", "opencode", "storage");
const OPENCODE_SESSIONS_DIR = path.join(OPENCODE_STORAGE_DIR, "session");
const OPENCODE_PROJECT_DIR = path.join(OPENCODE_STORAGE_DIR, "project");
const OPENCODE_MESSAGE_DIR = path.join(OPENCODE_STORAGE_DIR, "message");
const OPENCODE_PART_DIR = path.join(OPENCODE_STORAGE_DIR, "part");

// ── Types from opencode.ts ──────────────────────────────────────────────────

export interface OpencodeMessage {
  id: string;
  sessionID: string;
  role: string;
  time: { created: number; completed?: number };
  parentID?: string;
  modelID?: string;
  providerID?: string;
  agent?: string;
  tokens?: { input: number; output: number };
}

export interface OpencodePart {
  id: string;
  sessionID: string;
  messageID: string;
  type: string;
  text?: string;
  tool?: string;
  callID?: string;
  state?: {
    status: string;
    input: unknown;
    output: unknown;
    title?: string;
  };
}

export interface OpencodeSession {
  id: string;
  projectID: string;
  directory: string;
  title?: string;
  time: { created: number; updated: number };
}

export type MessageWithParts = { message: OpencodeMessage; parts: OpencodePart[] };

// ── Helpers from opencode.ts ────────────────────────────────────────────────

function readJsonFilesFromDir<T>(dirPath: string): T[] {
  if (!fs.existsSync(dirPath)) {
    return [];
  }

  const items: T[] = [];
  for (const file of fs.readdirSync(dirPath)) {
    if (!file.endsWith(".json")) {
      continue;
    }
    const filePath = path.join(dirPath, file);
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      items.push(JSON.parse(content) as T);
    } catch (err) {
      console.warn(
        `[devlog] Failed to read ${filePath}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return items;
}

function readMessageParts(messageId: string, partDir: string): OpencodePart[] {
  return readJsonFilesFromDir<OpencodePart>(path.join(partDir, messageId));
}

function getSessionMessages(sessionId: string, messageDir: string): OpencodeMessage[] {
  const messages = readJsonFilesFromDir<OpencodeMessage>(path.join(messageDir, sessionId));
  return messages.sort((a, b) => a.time.created - b.time.created);
}

function buildMessageContent(parts: OpencodePart[]): unknown[] {
  const content: unknown[] = [];

  for (const part of parts) {
    if (part.type === "text" && part.text) {
      content.push({ type: "text", text: part.text });
    } else if (part.type === "tool" && part.tool) {
      content.push({
        type: "tool_use",
        id: part.callID,
        name: part.tool,
        input: part.state?.input ?? {},
      });
      if (part.state?.output !== undefined) {
        const output = part.state.output;
        const outputStr = typeof output === "string" ? output : JSON.stringify(output);
        content.push({
          type: "tool_result",
          tool_use_id: part.callID,
          content: outputStr,
        });
      }
    }
  }

  return content;
}

export function loadMessagesFromFiles(
  sessionId: string,
  messageDir: string,
  partDir: string,
): MessageWithParts[] {
  const messages = getSessionMessages(sessionId, messageDir);
  return messages.map((message) => ({
    message,
    parts: readMessageParts(message.id, partDir),
  }));
}

export function reconstructSessionJsonl(
  sessionId: string,
  session: OpencodeSession,
  messagesWithParts: MessageWithParts[],
): string[] {
  const lines: string[] = [];

  for (const { message: msg, parts } of messagesWithParts) {
    const content = buildMessageContent(parts);

    if (content.length === 0) {
      continue;
    }

    const entry = {
      type: msg.role,
      sessionId: sessionId,
      uuid: msg.id,
      ...(msg.parentID && { parentUuid: msg.parentID }),
      timestamp: new Date(msg.time.created).toISOString(),
      cwd: session.directory,
      message: {
        role: msg.role,
        content: msg.role === "user" ? ((content[0] as { text?: string })?.text ?? "") : content,
        ...(msg.modelID && { model: msg.modelID }),
      },
      ...(msg.providerID && { provider: msg.providerID }),
      ...(msg.agent && { agent: msg.agent }),
      ...(msg.tokens && { tokens: msg.tokens }),
    };

    lines.push(JSON.stringify(entry));
  }

  return lines;
}

export function countUserMessages(messagesWithParts: MessageWithParts[]): number {
  return messagesWithParts.filter((m) => m.message.role === "user").length;
}

// DB column → interface mapping lives entirely here.
// If opencode changes their schema, update this one function.
export function* iterateOpencodeDbSessions(
  db: Database,
  slugFn: (p: string) => string,
): Generator<{
  projectSlug: string;
  session: OpencodeSession;
  messagesWithParts: MessageWithParts[];
}> {
  // This query throws if the schema doesn't match — intentionally not caught
  // here so the caller can fall back to flat files.
  const sessions = db
    .query<
      {
        id: string;
        project_id: string;
        directory: string;
        title: string | null;
        time_created: number;
        time_updated: number;
        worktree: string;
      },
      []
    >(
      `SELECT s.id, s.project_id, s.directory, s.title, s.time_created, s.time_updated, p.worktree
			 FROM session s
			 JOIN project p ON s.project_id = p.id`,
    )
    .all();

  const msgStmt = db.query<{ id: string; data: string }, [string]>(
    "SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created ASC",
  );

  const partStmt = db.query<{ id: string; data: string }, [string]>(
    "SELECT id, data FROM part WHERE message_id = ?",
  );

  for (const row of sessions) {
    try {
      const session: OpencodeSession = {
        id: row.id,
        projectID: row.project_id,
        directory: row.directory,
        title: row.title ?? undefined,
        time: { created: row.time_created, updated: row.time_updated },
      };

      const msgRows = msgStmt.all(row.id);
      const messagesWithParts: MessageWithParts[] = [];

      for (const msgRow of msgRows) {
        const d = JSON.parse(msgRow.data) as {
          role: string;
          time?: { created: number; completed?: number };
          parentID?: string;
          modelID?: string;
          providerID?: string;
          agent?: string;
          tokens?: { input: number; output: number };
        };

        const message: OpencodeMessage = {
          id: msgRow.id,
          sessionID: row.id,
          role: d.role,
          time: d.time ?? { created: row.time_created },
          parentID: d.parentID,
          modelID: d.modelID,
          providerID: d.providerID,
          agent: d.agent,
          tokens: d.tokens,
        };

        const partRows = partStmt.all(msgRow.id);
        const parts: OpencodePart[] = partRows.map((pr) => {
          const pd = JSON.parse(pr.data) as {
            type: string;
            text?: string;
            tool?: string;
            callID?: string;
            state?: OpencodePart["state"];
          };
          return {
            id: pr.id,
            sessionID: row.id,
            messageID: msgRow.id,
            type: pd.type,
            text: pd.text,
            tool: pd.tool,
            callID: pd.callID,
            state: pd.state,
          };
        });

        messagesWithParts.push({ message, parts });
      }

      yield {
        projectSlug: slugFn(row.worktree),
        session,
        messagesWithParts,
      };
    } catch (err) {
      console.warn(
        `[devlog] Failed to read session ${row.id} from DB:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

// ── Flat-file archive logic ─────────────────────────────────────────────────

function getOpencodeSessionFiles(workspacePath: string): string[] {
  return fs
    .readdirSync(workspacePath)
    .filter((f) => f.startsWith("ses_") && f.endsWith(".json"))
    .map((f) => path.join(workspacePath, f));
}

function countOpencodeFileSessions(): number {
  const excludeProjects = config.excludeProjects;
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
    if (matchesExcludedProject(excludeProjects, workspace, projectSlug, worktree)) {
      continue;
    }

    total += getOpencodeSessionFiles(workspacePath).length;
  }

  return total;
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

function archiveOpencodeWorkspace(
  workspace: string,
  logger: ReturnType<typeof createLogger>,
  options: CliOptions,
  stats: ArchiveStats,
  progress?: ProgressReporter,
) {
  const excludeProjects = config.excludeProjects;
  const archiveDir = config.archiveDir;
  const projectsArchiveDir = path.join(archiveDir, "projects");

  const workspacePath = path.join(OPENCODE_SESSIONS_DIR, workspace);
  if (!fs.statSync(workspacePath).isDirectory()) {
    return;
  }

  const sessionFiles = getOpencodeSessionFiles(workspacePath);
  if (sessionFiles.length === 0) {
    return;
  }

  const projectFile = path.join(OPENCODE_PROJECT_DIR, `${workspace}.json`);
  const worktree = getWorktreeFromProjectFile(projectFile);
  const projectSlug = getOpencodeProjectSlug(workspace, projectFile);
  if (matchesExcludedProject(excludeProjects, workspace, projectSlug, worktree)) {
    logger.verbose(`🚫 Skipping excluded project: ${projectSlug}`);
    return;
  }

  logger.verbose(`📁 Project: ${projectSlug} (${sessionFiles.length} sessions)`);
  if (archiveOpencodeProject(workspace, projectSlug, projectsArchiveDir)) {
    logger.verbose(`  ✅ Archived: project.json (metadata)`);
  }

  let workspaceArchived = 0;
  let workspaceMessages = 0;
  for (const filePath of sessionFiles) {
    const fileName = path.basename(filePath, ".json");
    const result = archiveOpencodeSession(filePath, projectSlug, projectsArchiveDir);

    if (!result.archived) {
      logger.verbose(`  ⏭️  Skipped: ${fileName} (already archived or empty)`);
      recordSkipped(stats, progress);
      continue;
    }

    logger.verbose(`  ✅ Archived: ${fileName}.jsonl (${result.messages} messages)`);
    workspaceArchived++;
    workspaceMessages += result.messages;
    recordArchived(stats, result.messages, progress);
  }

  logProjectRollup(
    logger,
    options.verbose,
    projectSlug,
    workspaceArchived,
    workspaceMessages,
    "messages",
  );
}

function archiveFromFiles(
  options: CliOptions = DEFAULT_CLI_OPTIONS,
  progress?: ProgressReporter,
): SourceSummary {
  const logger = createLogger(options);
  logger.verbose("🟦 Processing opencode sessions (from flat files)...\n");

  const stats = createArchiveStats();
  progress?.start("opencode");
  progress?.setTotal(countOpencodeFileSessions());

  for (const workspace of fs.readdirSync(OPENCODE_SESSIONS_DIR)) {
    archiveOpencodeWorkspace(workspace, logger, options, stats, progress);
  }

  progress?.end();
  return makeSummary("opencode", stats, "messages");
}

// ── DB archive logic ────────────────────────────────────────────────────────

function getOpencodeDbSessionCount(db: Database): number {
  const row = db.query<{ count: number }, []>("SELECT COUNT(*) as count FROM session").get();
  return row?.count ?? 0;
}

function archiveOpencodeDbSession(
  projectSlug: string,
  session: OpencodeSession,
  messagesWithParts: MessageWithParts[],
  logger: ReturnType<typeof createLogger>,
  stats: ArchiveStats,
  progress?: ProgressReporter,
) {
  const archiveDir = config.archiveDir;
  const projectsArchiveDir = path.join(archiveDir, "projects");
  const archivePath = path.join(projectsArchiveDir, projectSlug, "opencode", `${session.id}.jsonl`);

  if (fs.existsSync(archivePath)) {
    const archiveMtime = fs.statSync(archivePath).mtimeMs;
    if (session.time.updated <= archiveMtime) {
      logger.verbose(`  ⏭️  Skipped: ${session.id} (already archived)`);
      recordSkipped(stats, progress);
      return;
    }
  }

  const lines = reconstructSessionJsonl(session.id, session, messagesWithParts);
  if (lines.length === 0) {
    recordSkipped(stats, progress);
    return;
  }

  ensureDir(path.dirname(archivePath));
  fs.writeFileSync(archivePath, lines.join("\n") + "\n");

  const userMessages = countUserMessages(messagesWithParts);
  logger.verbose(`  ✅ Archived: ${session.id}.jsonl (${userMessages} messages)`);
  logger.verbose(`  📁 Project: ${projectSlug}`);
  recordArchived(stats, userMessages, progress);
}

function archiveFromDb(
  options: CliOptions = DEFAULT_CLI_OPTIONS,
  progress?: ProgressReporter,
): { handled: boolean; summary: SourceSummary } {
  const logger = createLogger(options);
  if (!fs.existsSync(OPENCODE_DB_PATH)) {
    return { handled: false, summary: makeSummary("opencode", createArchiveStats(), "messages") };
  }

  const excludeProjects = config.excludeProjects;
  const stats = createArchiveStats();

  try {
    const db = new Database(OPENCODE_DB_PATH, { readonly: true });
    try {
      logger.verbose("🟦 Processing opencode sessions (from DB)...\n");
      progress?.start("opencode");
      progress?.setTotal(getOpencodeDbSessionCount(db));

      for (const { projectSlug, session, messagesWithParts } of iterateOpencodeDbSessions(
        db,
        slugFromPath,
      )) {
        if (matchesExcludedProject(excludeProjects, projectSlug, session.directory)) {
          logger.verbose(`🚫 Skipping excluded project: ${projectSlug}`);
          continue;
        }

        archiveOpencodeDbSession(projectSlug, session, messagesWithParts, logger, stats, progress);
      }
    } finally {
      progress?.end();
      db.close();
    }

    return { handled: true, summary: makeSummary("opencode", stats, "messages") };
  } catch (err) {
    progress?.warn(
      `[devlog] Failed to read opencode DB, falling back to flat files: ${err instanceof Error ? err.message : err}`,
    );
    return {
      handled: false,
      summary: makeSummary("opencode", createArchiveStats(), "messages", 1),
    };
  }
}

// ── Public surface ──────────────────────────────────────────────────────────

export function archive(
  options: CliOptions = DEFAULT_CLI_OPTIONS,
  progress?: ProgressReporter,
): SourceSummary {
  const dbResult = archiveFromDb(options, progress);
  if (dbResult.handled) {
    return dbResult.summary;
  }

  if (fs.existsSync(OPENCODE_SESSIONS_DIR)) {
    return archiveFromFiles(options, progress);
  }

  progress?.warn("[devlog] opencode storage not found");
  return { ...dbResult.summary, warnings: dbResult.summary.warnings + 1 };
}
