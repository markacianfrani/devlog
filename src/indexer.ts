import type { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";

import type { Source } from "./config.ts";
import { piParentArchiveName } from "./parsers/pi-relationships.ts";
import { isSource, type ParseResult, type ParseWarning } from "./parsers/types.ts";
import {
  createIndexRedactionContext,
  redactForIndexing,
  type IndexRedactionContext,
} from "./redaction.ts";
import { SOURCE_ADAPTERS } from "./sources/registry.ts";

export interface IndexFailure {
  filePath: string;
  error: string;
}

export interface IndexStats {
  sessionsIndexed: number;
  sessionsSkipped: number;
  messagesIndexed: number;
  errors: number;
  warnings: number;
  failures: IndexFailure[];
}

export interface IndexProgressEvent {
  filePath: string;
  source: Source;
  project: string;
  messageCount?: number;
  error?: string;
}

export interface IndexProgressCallbacks {
  onStart?: (total: number) => void;
  onTick?: (processed: number, stats: IndexStats) => void;
  onIndexed?: (event: IndexProgressEvent) => void;
  onWarning?: (warning: ParseWarning) => void;
  onError?: (event: IndexProgressEvent) => void;
}

export interface IndexAllOptions {
  excludeSources?: readonly Source[];
  callbacks?: IndexProgressCallbacks;
}

function getMtime(filePath: string): number {
  return Math.floor(fs.statSync(filePath).mtimeMs);
}

interface SessionCheck {
  exists: boolean;
  sameVersion: boolean;
}

function checkSession(db: Database, filePath: string, mtime: number): SessionCheck {
  const row = db
    .query<{ mtime: number }, [string]>("SELECT mtime FROM sessions WHERE file_path = ?")
    .get(filePath);

  if (!row) {
    return { exists: false, sameVersion: false };
  }

  return {
    exists: true,
    sameVersion: row.mtime === mtime,
  };
}

function deleteSession(db: Database, filePath: string) {
  // CASCADE delete will handle messages and content_blocks
  db.run("DELETE FROM sessions WHERE file_path = ?", [filePath]);
  // FTS table doesn't have CASCADE, delete manually. Scope by file, not session
  // id: a fork shares its parent's session id.
  db.run("DELETE FROM messages_fts WHERE file_path = ?", [filePath]);
}

// SQLite requires null (not undefined) for NULL values
// biome-ignore lint: SQLite bindings require null literals
const SQL_NULL = null;

function toSqlValue<T>(value: T | undefined): T | null {
  return value ?? SQL_NULL;
}

function insertSession(db: Database, result: ParseResult, filePath: string, mtime: number) {
  db.run(
    `INSERT INTO sessions (file_path, session_id, source, project, cwd, title, model, created_at, updated_at, parent_session_id, relation_kind, parent_file_path, mtime)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    [
      filePath,
      result.meta.id,
      result.meta.source,
      result.meta.project,
      toSqlValue(result.meta.cwd),
      toSqlValue(result.meta.title),
      toSqlValue(result.meta.model),
      toSqlValue(result.meta.createdAt),
      toSqlValue(result.meta.updatedAt),
      toSqlValue(result.meta.parentSessionId),
      toSqlValue(result.meta.relationKind),
      mtime,
    ],
  );
}

function insertWorktree(db: Database, result: ParseResult, filePath: string) {
  const w = result.meta.worktree;
  if (!w) {
    return;
  }
  db.run(
    `INSERT INTO session_worktrees (file_path, worktree_path, worktree_name, original_cwd, worktree_branch, original_branch, original_head_commit)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      filePath,
      w.worktreePath,
      w.worktreeName,
      toSqlValue(w.originalCwd),
      toSqlValue(w.worktreeBranch),
      toSqlValue(w.originalBranch),
      toSqlValue(w.originalHeadCommit),
    ],
  );
}

function insertMessages(db: Database, result: ParseResult, filePath: string) {
  const insertMsg = db.prepare(
    `INSERT INTO messages (id, file_path, parent_id, role, timestamp, model, tokens_in, tokens_out, cache_read_tokens, cache_write_tokens, reasoning_tokens, agent_id, api_message_id, request_id, is_sidechain)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const insertBlock = db.prepare(
    `INSERT INTO content_blocks (file_path, message_id, block_index, type, text, tool_name, tool_input, tool_output, tool_use_id, media_type)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const insertFts = db.prepare(
    `INSERT INTO messages_fts (session_id, message_id, text, file_path) VALUES (?, ?, ?, ?)`,
  );

  for (const msg of result.messages) {
    insertMsg.run(
      msg.id,
      filePath,
      toSqlValue(msg.parentId),
      msg.role,
      msg.timestamp,
      toSqlValue(msg.model),
      toSqlValue(msg.tokensIn),
      toSqlValue(msg.tokensOut),
      toSqlValue(msg.cacheReadTokens),
      toSqlValue(msg.cacheWriteTokens),
      toSqlValue(msg.reasoningTokens),
      toSqlValue(msg.agentId),
      toSqlValue(msg.usageIdentity?.messageId),
      toSqlValue(msg.usageIdentity?.requestId),
      msg.usageIdentity?.isSidechain ? 1 : 0,
    );

    const textParts: string[] = [];
    for (const [i, block] of msg.content.entries()) {
      let text: string | null = SQL_NULL;
      let toolName: string | null = SQL_NULL;
      let toolInput: string | null = SQL_NULL;
      let toolOutput: string | null = SQL_NULL;
      let toolUseId: string | null = SQL_NULL;
      let mediaType: string | null = SQL_NULL;

      switch (block.type) {
        case "text":
          text = block.text;
          textParts.push(block.text);
          break;
        case "thinking":
          text = block.thinking;
          break;
        case "redacted_thinking":
          break;
        case "tool_use":
          toolName = block.toolName;
          toolInput = block.toolInput ?? SQL_NULL;
          toolUseId = block.toolUseId ?? SQL_NULL;
          break;
        case "tool_result":
          toolOutput = block.toolOutput;
          toolUseId = block.toolUseId ?? SQL_NULL;
          break;
        case "image":
        case "document":
          mediaType = block.mediaType ?? SQL_NULL;
          break;
      }

      insertBlock.run(
        filePath,
        msg.id,
        i,
        block.type,
        text,
        toolName,
        toolInput,
        toolOutput,
        toolUseId,
        mediaType,
      );
    }

    if (textParts.length > 0) {
      insertFts.run(result.meta.id, msg.id, textParts.join("\n"), filePath);
    }
  }
}

function insertPrLinks(db: Database, result: ParseResult, filePath: string) {
  if (result.prLinks.length === 0) {
    return;
  }

  const insert = db.prepare(
    `INSERT INTO pr_links (file_path, session_id, pr_number, pr_url, pr_repository, timestamp)
		 VALUES (?, ?, ?, ?, ?, ?)`,
  );

  for (const link of result.prLinks) {
    insert.run(
      filePath,
      result.meta.id,
      link.prNumber,
      link.prUrl,
      link.prRepository,
      toSqlValue(link.timestamp),
    );
  }
}

function insertArtifactLinks(db: Database, result: ParseResult, filePath: string) {
  if (result.artifactLinks.length === 0) {
    return;
  }

  const insert = db.prepare(
    `INSERT INTO artifact_links (file_path, session_id, path, artifact_url, timestamp)
		 VALUES (?, ?, ?, ?, ?)`,
  );

  for (const link of result.artifactLinks) {
    insert.run(filePath, result.meta.id, link.path, link.artifactUrl, toSqlValue(link.timestamp));
  }
}

export async function indexSession(
  jsonlPath: string,
  source: Source,
  project: string,
  db: Database,
  redactionContext?: IndexRedactionContext,
  onWarning?: (warning: ParseWarning) => void,
): Promise<{ indexed: boolean; messageCount: number }> {
  const mtime = getMtime(jsonlPath);
  const existing = checkSession(db, jsonlPath, mtime);

  if (existing.sameVersion) {
    return { indexed: false, messageCount: 0 };
  }

  const outcome = await SOURCE_ADAPTERS[source].parse(jsonlPath, project);

  for (const warning of outcome.warnings) {
    onWarning?.(warning);
  }

  let result = outcome.result;
  if (!result) {
    return { indexed: false, messageCount: 0 };
  }

  result = redactForIndexing(result, redactionContext);

  if (result.messages.length === 0) {
    return { indexed: false, messageCount: 0 };
  }

  db.exec("BEGIN TRANSACTION");
  try {
    if (existing.exists) {
      deleteSession(db, jsonlPath);
    }
    insertSession(db, result, jsonlPath, mtime);
    insertWorktree(db, result, jsonlPath);
    insertMessages(db, result, jsonlPath);
    insertPrLinks(db, result, jsonlPath);
    insertArtifactLinks(db, result, jsonlPath);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  return { indexed: true, messageCount: result.messages.length };
}

function findJsonlFiles(dir: string): string[] {
  const files: string[] = [];

  if (!fs.existsSync(dir)) {
    return files;
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findJsonlFiles(fullPath));
    } else if (entry.name.endsWith(".jsonl")) {
      files.push(fullPath);
    }
  }

  return files;
}

function getProjectAndSource(
  filePath: string,
  archiveDir: string,
): { project: string; source: Source } | undefined {
  const relative = path.relative(archiveDir, filePath);
  const parts = relative.split(path.sep);

  // Expected structure: projects/<project>/<source>/<session>.jsonl
  if (parts.length < 4 || parts[0] !== "projects") {
    return undefined;
  }

  const project = parts[1];
  const source = parts[2];

  if (project === undefined || source === undefined || !isSource(source)) {
    return undefined;
  }

  return { project, source };
}

// A raw parent pointer is stored producer evidence: usually the parent's session
// id, sometimes a path to its transcript. Extract only the final UUID from a
// path, never a title, prompt, timestamp, or prose resemblance.
function parentReferenceId(parentSessionId: string): string {
  return (
    parentSessionId.match(/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/gi)?.at(-1) ??
    parentSessionId
  ).toLowerCase();
}

// A Claude subagent's archive directory is an exact producer-owned locator:
// <parent UUID>/subagents/... belongs to <parent UUID>.jsonl. Siblings echo the
// same session ID, so an ID-only lookup could choose a sibling as the parent.
function claudeSubagentParentPath(filePath: string): string | undefined {
  const marker = `${path.sep}subagents${path.sep}`;
  const index = filePath.lastIndexOf(marker);
  return index < 0 ? undefined : `${filePath.slice(0, index)}.jsonl`;
}

// Resolve only an exact transcript. Claude subagents require their archive
// parent and an agreeing raw pointer. Pi can use a producer-owned source or
// archive filename across worktree project slugs; otherwise require a unique
// same-project/source ID. Recompute all links after each index run so
// incremental and rebuild behavior converge and later conflicts clear old links.
type SessionRow = {
  file_path: string;
  session_id: string;
  source: Source;
  project: string;
  parent_session_id: string | null;
};

function resolveParentFilePaths(db: Database): void {
  const sessions = db
    .query<SessionRow, []>(
      "SELECT file_path, session_id, source, project, parent_session_id FROM sessions",
    )
    .all();

  const byPath = new Map(sessions.map((session) => [session.file_path, session]));
  const bySessionId = new Map<string, SessionRow[]>();
  for (const session of sessions) {
    const key = session.session_id.toLowerCase();
    const matches = bySessionId.get(key) ?? [];
    matches.push(session);
    bySessionId.set(key, matches);
  }

  const proposed = new Map<string, string | null>();
  for (const child of sessions) {
    proposed.set(child.file_path, resolveChildParent(child, byPath, bySessionId));
  }

  // Corrupt or conflicting pointers must not form a cycle.
  unresolveCycles(proposed);

  const update = db.prepare(`UPDATE sessions SET parent_file_path = ? WHERE file_path = ?`);
  for (const child of sessions) {
    update.run(proposed.get(child.file_path) ?? null, child.file_path);
  }
}

// Resolve one child's parent transcript. A malformed Claude path or Pi parent
// filename cannot fall back to another transcript merely sharing its ID.
// Multiple matches stay unknown.
function resolveChildParent(
  child: SessionRow,
  byPath: Map<string, SessionRow>,
  bySessionId: Map<string, SessionRow[]>,
): string | null {
  if (!child.parent_session_id) {
    return null;
  }
  const id = parentReferenceId(child.parent_session_id);
  const archiveParent =
    child.source === "claude" ? claudeSubagentParentPath(child.file_path) : undefined;
  const piArchiveName =
    child.source === "pi"
      ? piParentArchiveName(child.file_path, child.parent_session_id)
      : undefined;
  if (piArchiveName === null) {
    return null;
  }
  const candidates = archiveParent ? [byPath.get(archiveParent)] : (bySessionId.get(id) ?? []);
  const matches = candidates.filter(
    (candidate) =>
      candidate !== undefined &&
      fs.existsSync(candidate.file_path) &&
      candidate.file_path !== child.file_path &&
      candidate.session_id.toLowerCase() === id &&
      candidate.source === child.source &&
      (archiveParent
        ? candidate.project === child.project
        : piArchiveName
          ? path.basename(candidate.file_path) === piArchiveName
          : candidate.project === child.project),
  );
  return matches.length === 1 ? (matches[0]?.file_path ?? null) : null;
}

// Corrupt or conflicting pointers must not form a cycle. Leave the raw
// references visible but unresolve every link along a path into a cycle.
function unresolveCycles(proposed: Map<string, string | null>): void {
  for (const start of proposed.keys()) {
    const seen = new Set<string>();
    let cursor: string | null = start;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      cursor = proposed.get(cursor) ?? null;
    }
    if (cursor) {
      for (const filePath of seen) {
        proposed.set(filePath, null);
      }
    }
  }
}

export async function indexAll(
  archiveDir: string,
  rebuild: boolean,
  db: Database,
  options: IndexAllOptions = {},
): Promise<IndexStats> {
  const { callbacks } = options;
  const excludedSources = new Set(options.excludeSources ?? []);
  const stats: IndexStats = {
    sessionsIndexed: 0,
    sessionsSkipped: 0,
    messagesIndexed: 0,
    errors: 0,
    warnings: 0,
    failures: [],
  };

  if (rebuild) {
    db.run("DELETE FROM sessions");
  }

  const projectsDir = path.join(archiveDir, "projects");
  const jsonlFiles = findJsonlFiles(projectsDir);
  callbacks?.onStart?.(jsonlFiles.length);

  const redactionContext = createIndexRedactionContext();
  let processed = 0;

  for (const filePath of jsonlFiles) {
    const info = getProjectAndSource(filePath, archiveDir);
    if (!info || excludedSources.has(info.source)) {
      continue;
    }

    try {
      const result = await indexSession(
        filePath,
        info.source,
        info.project,
        db,
        redactionContext,
        (warning) => {
          stats.warnings++;
          callbacks?.onWarning?.(warning);
        },
      );
      if (result.indexed) {
        stats.sessionsIndexed++;
        stats.messagesIndexed += result.messageCount;
        callbacks?.onIndexed?.({
          filePath,
          source: info.source,
          project: info.project,
          messageCount: result.messageCount,
        });
      } else {
        stats.sessionsSkipped++;
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      if (!callbacks?.onError) {
        console.error(`Error indexing ${filePath}:`, errorMsg);
      }
      stats.errors++;
      stats.failures.push({ filePath, error: errorMsg });
      callbacks?.onError?.({
        filePath,
        source: info.source,
        project: info.project,
        error: errorMsg,
      });
    }

    processed++;
    callbacks?.onTick?.(processed, stats);
  }

  resolveParentFilePaths(db);
  return stats;
}
