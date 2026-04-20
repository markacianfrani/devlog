import type { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import {
  createIndexRedactionContext,
  redactForIndexing,
  type IndexRedactionContext,
} from "./redaction.ts";
import { parseClaudeSession } from "./parsers/claude.ts";
import { parseOpenCodeSession } from "./parsers/opencode.ts";
import { parsePiSession } from "./parsers/pi.ts";
import type { ParseResult, Source } from "./parsers/types.ts";

export interface IndexFailure {
  filePath: string;
  error: string;
}

export interface IndexStats {
  sessionsIndexed: number;
  sessionsSkipped: number;
  messagesIndexed: number;
  errors: number;
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
  onError?: (event: IndexProgressEvent) => void;
}

function getMtime(filePath: string): number {
  return Math.floor(fs.statSync(filePath).mtimeMs);
}

interface SessionCheck {
  exists: boolean;
  sameVersion: boolean;
  sessionId?: string;
}

function checkSession(db: Database, filePath: string, mtime: number): SessionCheck {
  const row = db
    .query<{ mtime: number; session_id: string }, [string]>(
      "SELECT mtime, session_id FROM sessions WHERE file_path = ?",
    )
    .get(filePath);

  if (!row) {
    return { exists: false, sameVersion: false };
  }

  return {
    exists: true,
    sameVersion: row.mtime === mtime,
    sessionId: row.session_id,
  };
}

function deleteSession(db: Database, filePath: string, sessionId: string) {
  // CASCADE delete will handle messages and content_blocks
  db.run("DELETE FROM sessions WHERE file_path = ?", [filePath]);
  // FTS table doesn't have CASCADE, delete manually
  if (sessionId) {
    db.run("DELETE FROM messages_fts WHERE session_id = ?", [sessionId]);
  }
}

// SQLite requires null (not undefined) for NULL values
// biome-ignore lint: SQLite bindings require null literals
// eslint-disable-next-line unicorn/no-null
const SQL_NULL = null;

function toSqlValue<T>(value: T | undefined): T | null {
  return value ?? SQL_NULL;
}

function insertSession(db: Database, result: ParseResult, filePath: string, mtime: number) {
  db.run(
    `INSERT INTO sessions (file_path, session_id, source, project, cwd, title, model, created_at, updated_at, parent_session_id, mtime)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      mtime,
    ],
  );
}

function insertMessages(db: Database, result: ParseResult, filePath: string) {
  const insertMsg = db.prepare(
    `INSERT INTO messages (id, file_path, parent_id, role, timestamp, model, tokens_in, tokens_out, cache_read_tokens, cache_write_tokens, reasoning_tokens, agent_id)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const insertBlock = db.prepare(
    `INSERT INTO content_blocks (file_path, message_id, block_index, type, text, tool_name, tool_input, tool_output, media_type)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const insertFts = db.prepare(
    `INSERT INTO messages_fts (session_id, message_id, text) VALUES (?, ?, ?)`,
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
    );

    const textParts: string[] = [];
    for (let i = 0; i < msg.content.length; i++) {
      const block = msg.content[i];
      let text: string | null = SQL_NULL;
      let toolName: string | null = SQL_NULL;
      let toolInput: string | null = SQL_NULL;
      let toolOutput: string | null = SQL_NULL;
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
          toolName = block.toolName ?? SQL_NULL;
          toolInput = block.toolInput ?? SQL_NULL;
          break;
        case "tool_result":
          toolOutput = block.toolOutput ?? SQL_NULL;
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
        mediaType,
      );
    }

    if (textParts.length > 0) {
      insertFts.run(result.meta.id, msg.id, textParts.join("\n"));
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

export async function indexSession(
  jsonlPath: string,
  source: Source,
  project: string,
  db: Database,
  redactionContext?: IndexRedactionContext,
): Promise<{ indexed: boolean; messageCount: number }> {
  const mtime = getMtime(jsonlPath);
  const existing = checkSession(db, jsonlPath, mtime);

  if (existing.sameVersion) {
    return { indexed: false, messageCount: 0 };
  }

  let result: ParseResult | undefined;
  if (source === "claude") {
    result = await parseClaudeSession(jsonlPath, project);
  } else if (source === "opencode") {
    result = await parseOpenCodeSession(jsonlPath, project);
  } else {
    result = await parsePiSession(jsonlPath, project);
  }

  if (!result) {
    return { indexed: false, messageCount: 0 };
  }

  result = redactForIndexing(result, redactionContext);

  if (result.messages.length === 0) {
    return { indexed: false, messageCount: 0 };
  }

  db.exec("BEGIN TRANSACTION");
  try {
    if (existing.exists && existing.sessionId) {
      deleteSession(db, jsonlPath, existing.sessionId);
    }
    insertSession(db, result, jsonlPath, mtime);
    insertMessages(db, result, jsonlPath);
    insertPrLinks(db, result, jsonlPath);
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

  if (source !== "claude" && source !== "opencode" && source !== "pi") {
    return undefined;
  }

  return { project, source };
}

export async function indexAll(
  archiveDir: string,
  rebuild: boolean,
  db: Database,
  callbacks?: IndexProgressCallbacks,
): Promise<IndexStats> {
  const stats: IndexStats = {
    sessionsIndexed: 0,
    sessionsSkipped: 0,
    messagesIndexed: 0,
    errors: 0,
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
    if (!info) {
      continue;
    }

    try {
      const result = await indexSession(filePath, info.source, info.project, db, redactionContext);
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

  return stats;
}
