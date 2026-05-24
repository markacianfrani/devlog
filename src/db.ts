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

const SCHEMA_VERSION = 12;
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
	PRIMARY KEY (file_path, id),
	FOREIGN KEY (file_path) REFERENCES sessions(file_path) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_file_path ON messages(file_path);
CREATE INDEX IF NOT EXISTS idx_messages_role ON messages(role);

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

-- FTS table for full-text search
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
	session_id,
	message_id,
	text,
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
    database.exec("DROP TABLE IF EXISTS messages_fts");
    database.exec("DROP TABLE IF EXISTS content_blocks");
    database.exec("DROP TABLE IF EXISTS pr_links");
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
