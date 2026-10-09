import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";

import { DEFAULTS } from "./config.ts";
import type { ContentBlockType, MessageRole, Source } from "./parsers/types.ts";
import { ensureDir } from "./sources/shared.ts";

// Row types for database queries
export interface SessionRow {
  file_path: string;
  session_id: string;
  source: Source;
  project: string;
  cwd: string | null;
  title: string | null;
  model: string | null;
  created_at: string | null;
  updated_at: string | null;
  parent_session_id: string | null;
  mtime: number;
}

export interface SessionWorktreeRow {
  file_path: string;
  worktree_path: string;
  worktree_name: string;
  original_cwd: string | null;
  worktree_branch: string | null;
  original_branch: string | null;
  original_head_commit: string | null;
}

export interface MessageRow {
  id: string;
  file_path: string;
  parent_id: string | null;
  role: MessageRole;
  timestamp: string | null;
  model: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  reasoning_tokens: number | null;
  agent_id: string | null;
  api_message_id: string | null;
  request_id: string | null;
  is_sidechain: 0 | 1;
}

export interface ContentBlockRow {
  id: number;
  file_path: string;
  message_id: string;
  block_index: number;
  type: ContentBlockType;
  text: string | null;
  tool_name: string | null;
  tool_input: string | null;
  tool_output: string | null;
  tool_use_id: string | null;
  media_type: string | null;
}

export interface MessageFtsRow {
  session_id: string;
  message_id: string;
  text: string;
}

export interface PrLinkRow {
  id: number;
  file_path: string;
  session_id: string;
  pr_number: number;
  pr_url: string;
  pr_repository: string;
  timestamp: string | null;
}

export interface ArtifactLinkRow {
  id: number;
  file_path: string;
  session_id: string;
  path: string;
  artifact_url: string;
  timestamp: string | null;
}
export const SCHEMA_VERSION = 16;
const DEFAULT_DB_PATH = DEFAULTS.dbPath;

let db: Database | undefined;
let readonlyDb: Database | undefined;

const SCHEMA = `
-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_version (
	version INTEGER PRIMARY KEY
);

-- Sessions table (file_path is primary key since session IDs may be shared across files)
CREATE TABLE IF NOT EXISTS sessions (
	file_path TEXT PRIMARY KEY,
	session_id TEXT NOT NULL,
	source TEXT NOT NULL CHECK(source IN ('claude', 'opencode', 'pi')),
	project TEXT NOT NULL,
	cwd TEXT,
	title TEXT,
	model TEXT,
	created_at TEXT,
	updated_at TEXT,
	parent_session_id TEXT,
	mtime INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
CREATE INDEX IF NOT EXISTS idx_sessions_source ON sessions(source);
CREATE INDEX IF NOT EXISTS idx_sessions_session_id ON sessions(session_id);

-- 1:1 side table for sessions running inside a git worktree.
-- worktree_path + worktree_name are always present when the row exists; the rest
-- are nullable because pi worktree sessions can only be detected (via cwd
-- containing "pi-worktree"), not described -- pi emits no structured metadata.
-- An index on original_cwd lets us group worktree sessions under their real
-- project when claude provides that field.
CREATE TABLE IF NOT EXISTS session_worktrees (
	file_path TEXT PRIMARY KEY,
	worktree_path TEXT NOT NULL,
	worktree_name TEXT NOT NULL,
	original_cwd TEXT,
	worktree_branch TEXT,
	original_branch TEXT,
	original_head_commit TEXT,
	FOREIGN KEY (file_path) REFERENCES sessions(file_path) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_session_worktrees_original_cwd ON session_worktrees(original_cwd);

-- Messages table (references sessions by file_path)
-- Every file keeps its own copy of a message, even when a fork or subagent
-- sidechain replays one from another file. api_message_id/request_id/is_sidechain
-- identify the API response behind a Claude assistant message; message_usage
-- (below) uses them to count each response's tokens once.
CREATE TABLE IF NOT EXISTS messages (
	id TEXT NOT NULL,
	file_path TEXT NOT NULL,
	parent_id TEXT,
	role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
	timestamp TEXT,
	model TEXT,
	tokens_in INTEGER,
	tokens_out INTEGER,
	cache_read_tokens INTEGER,
	cache_write_tokens INTEGER,
	reasoning_tokens INTEGER,
	agent_id TEXT,
	api_message_id TEXT,
	request_id TEXT,
	is_sidechain INTEGER NOT NULL DEFAULT 0 CHECK(is_sidechain IN (0, 1)),
	PRIMARY KEY (file_path, id),
	FOREIGN KEY (file_path) REFERENCES sessions(file_path) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_file_path ON messages(file_path);
CREATE INDEX IF NOT EXISTS idx_messages_role ON messages(role);
CREATE INDEX IF NOT EXISTS idx_messages_api_message_id ON messages(api_message_id);

-- One row per billed API response: sum tokens over this view, not messages.
-- Ports ccusage's Claude dedupe (rust/adapters/claude/src/lib.rs):
--   1. Exact: api_message_id + request_id match across sessions. Without a
--      request_id the match is scoped to the session and timestamp.
--   2. Sidechain replay: within a session, a sidechain copy of a response (e.g.
--      /btw replaying parent turns under a new request_id) matches on
--      api_message_id plus timestamp, or on api_message_id alone when neither
--      copy has a request_id.
-- The survivor is the main-chain copy, then the one with the most tokens, then
-- the first indexed. Messages without api_message_id (user turns, pi, opencode)
-- pass through untouched.
CREATE VIEW IF NOT EXISTS message_usage AS
WITH ranked AS (
	SELECT m.*, m.rowid AS row_id, s.session_id,
		COALESCE(m.tokens_in, 0) + COALESCE(m.tokens_out, 0)
			+ COALESCE(m.cache_read_tokens, 0) + COALESCE(m.cache_write_tokens, 0) AS usage_total,
		ROW_NUMBER() OVER (
			PARTITION BY
				CASE WHEN m.api_message_id IS NULL THEN m.file_path END,
				COALESCE(m.api_message_id, m.id),
				m.request_id,
				CASE WHEN m.api_message_id IS NOT NULL AND m.request_id IS NULL THEN s.session_id END,
				CASE WHEN m.api_message_id IS NOT NULL AND m.request_id IS NULL THEN m.timestamp END
			ORDER BY m.is_sidechain,
				COALESCE(m.tokens_in, 0) + COALESCE(m.tokens_out, 0)
					+ COALESCE(m.cache_read_tokens, 0) + COALESCE(m.cache_write_tokens, 0) DESC,
				m.rowid
		) AS exact_rank
	FROM messages m
	JOIN sessions s ON s.file_path = m.file_path
),
exact AS (SELECT * FROM ranked WHERE exact_rank = 1)
SELECT w.id, w.file_path, w.session_id, w.parent_id, w.role, w.timestamp, w.model,
	w.tokens_in, w.tokens_out, w.cache_read_tokens, w.cache_write_tokens, w.reasoning_tokens,
	w.agent_id, w.api_message_id, w.request_id, w.is_sidechain
FROM exact w
WHERE w.api_message_id IS NULL OR NOT EXISTS (
	SELECT 1 FROM exact o
	WHERE o.api_message_id = w.api_message_id
		AND o.session_id = w.session_id
		AND o.row_id <> w.row_id
		AND (o.is_sidechain = 1 OR w.is_sidechain = 1)
		AND ((o.request_id IS NULL AND w.request_id IS NULL) OR o.timestamp = w.timestamp)
		AND (o.is_sidechain < w.is_sidechain
			OR (o.is_sidechain = w.is_sidechain AND (o.usage_total > w.usage_total
				OR (o.usage_total = w.usage_total AND o.row_id < w.row_id))))
);

-- Content blocks table (references messages by file_path + message_id)
CREATE TABLE IF NOT EXISTS content_blocks (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	file_path TEXT NOT NULL,
	message_id TEXT NOT NULL,
	block_index INTEGER NOT NULL,
	type TEXT NOT NULL CHECK(type IN ('text', 'tool_use', 'tool_result', 'thinking', 'redacted_thinking', 'image', 'document')),
	text TEXT,
	tool_name TEXT,
	tool_input TEXT,
	tool_output TEXT,
	tool_use_id TEXT,
	media_type TEXT,
	FOREIGN KEY (file_path, message_id) REFERENCES messages(file_path, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_content_blocks_file_path ON content_blocks(file_path);
CREATE INDEX IF NOT EXISTS idx_content_blocks_message ON content_blocks(file_path, message_id);
CREATE INDEX IF NOT EXISTS idx_content_blocks_message_id ON content_blocks(message_id);
CREATE INDEX IF NOT EXISTS idx_content_blocks_tool_name ON content_blocks(tool_name);
CREATE INDEX IF NOT EXISTS idx_content_blocks_tool_use_id ON content_blocks(file_path, tool_use_id);

-- PR links table (normalized — most sessions have none, some have multiple)
CREATE TABLE IF NOT EXISTS pr_links (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	file_path TEXT NOT NULL,
	session_id TEXT NOT NULL,
	pr_number INTEGER NOT NULL,
	pr_url TEXT NOT NULL,
	pr_repository TEXT NOT NULL,
	timestamp TEXT,
	FOREIGN KEY (file_path) REFERENCES sessions(file_path) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pr_links_file_path ON pr_links(file_path);
CREATE INDEX IF NOT EXISTS idx_pr_links_session_id ON pr_links(session_id);
CREATE INDEX IF NOT EXISTS idx_pr_links_repository ON pr_links(pr_repository);

-- Artifact links table (normalized — most sessions have none, some publish multiple).
-- Written from claude frame-link records; path is the local scratchpad file, artifact_url the hosted page.
CREATE TABLE IF NOT EXISTS artifact_links (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	file_path TEXT NOT NULL,
	session_id TEXT NOT NULL,
	path TEXT NOT NULL,
	artifact_url TEXT NOT NULL,
	timestamp TEXT,
	FOREIGN KEY (file_path) REFERENCES sessions(file_path) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_artifact_links_file_path ON artifact_links(file_path);
CREATE INDEX IF NOT EXISTS idx_artifact_links_session_id ON artifact_links(session_id);

-- FTS table for full-text search
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
	session_id,
	message_id,
	text,
	-- Forks reuse their parent's session id and message ids, so only the file
	-- tells their rows apart (e.g. when one is reindexed).
	file_path UNINDEXED,
	tokenize='porter'
);
`;

function getSchemaVersion(database: Database): number | undefined {
  const hasTable = database
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'")
    .get();
  if (!hasTable) {
    return undefined;
  }

  const row = database.query<{ version: number }, []>("SELECT version FROM schema_version").get();
  return row?.version;
}

function initializeSchema(database: Database) {
  const version = getSchemaVersion(database);

  if (version === SCHEMA_VERSION) {
    return;
  }

  if (version !== undefined && version !== SCHEMA_VERSION) {
    // Index DB is a cache — just nuke and recreate on version mismatch
    database.exec("DROP VIEW IF EXISTS message_usage");
    database.exec("DROP TABLE IF EXISTS messages_fts");
    database.exec("DROP TABLE IF EXISTS content_blocks");
    database.exec("DROP TABLE IF EXISTS pr_links");
    database.exec("DROP TABLE IF EXISTS artifact_links");
    database.exec("DROP TABLE IF EXISTS session_worktrees");
    database.exec("DROP TABLE IF EXISTS messages");
    database.exec("DROP TABLE IF EXISTS sessions");
    database.exec("DROP TABLE IF EXISTS schema_version");
  }

  database.exec(SCHEMA);
  database.run("INSERT OR REPLACE INTO schema_version (version) VALUES (?)", [SCHEMA_VERSION]);
}

export function getDb(dbPath: string = DEFAULT_DB_PATH): Database {
  if (db) {
    return db;
  }

  ensureDir(path.dirname(dbPath));
  db = new Database(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  initializeSchema(db);
  return db;
}

export function getReadonlyDb(dbPath: string = DEFAULT_DB_PATH): Database {
  if (readonlyDb) {
    return readonlyDb;
  }

  // Ensure the RW connection has run schema init so the file exists.
  getDb(dbPath);
  readonlyDb = new Database(dbPath, { readonly: true });
  return readonlyDb;
}

export function closeDb() {
  if (db) {
    db.close();
    db = undefined;
  }
  if (readonlyDb) {
    readonlyDb.close();
    readonlyDb = undefined;
  }
}

export function resetDb(dbPath: string = DEFAULT_DB_PATH) {
  closeDb();
  if (fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath);
  }
  const walPath = `${dbPath}-wal`;
  const shmPath = `${dbPath}-shm`;
  if (fs.existsSync(walPath)) {
    fs.unlinkSync(walPath);
  }
  if (fs.existsSync(shmPath)) {
    fs.unlinkSync(shmPath);
  }
}

export { DEFAULT_DB_PATH };
