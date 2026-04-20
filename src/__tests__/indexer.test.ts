import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDb, getDb } from "../db.ts";
import { indexAll, indexSession } from "../indexer.ts";
import type { IndexRedactionContext } from "../redaction.ts";

const FIXTURES_DIR = path.join(import.meta.dir, "fixtures");

async function withEnv<T>(
  name: string,
  value: string | undefined,
  run: () => T | Promise<T>,
): Promise<T> {
  const previous = process.env[name];

  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }

  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  }
}

describe("indexer", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "devlog-indexer-test-"));
    dbPath = path.join(tempDir, "index.db");
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test("indexes a single Claude session", async () => {
    const db = getDb(dbPath);
    await indexSession(
      path.join(FIXTURES_DIR, "claude-simple.jsonl"),
      "claude",
      "test-project",
      db,
    );

    const session = db
      .query<{ session_id: string; project: string; source: string }, []>(
        "SELECT session_id, project, source FROM sessions",
      )
      .get();

    expect(session).not.toBeNull();
    expect(session?.session_id).toBe("test-session-1");
    expect(session?.project).toBe("test-project");
    expect(session?.source).toBe("claude");

    const messages = db
      .query<
        {
          id: string;
          role: string;
          tokens_in: number | null;
          cache_read_tokens: number | null;
          cache_write_tokens: number | null;
        },
        []
      >(
        "SELECT id, role, tokens_in, cache_read_tokens, cache_write_tokens FROM messages ORDER BY timestamp",
      )
      .all();

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].tokens_in).toBe(100);
    expect(messages[1].cache_read_tokens).toBe(20);
    expect(messages[1].cache_write_tokens).toBe(15);

    const blocks = db
      .query<{ type: string; text: string | null }, []>(
        "SELECT type, text FROM content_blocks ORDER BY id",
      )
      .all();

    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("text");
    expect(blocks[0].text).toContain("Hello");
  });

  test("indexes tool usage correctly", async () => {
    const db = getDb(dbPath);
    await indexSession(
      path.join(FIXTURES_DIR, "claude-with-tools.jsonl"),
      "claude",
      "test-project",
      db,
    );

    const toolBlocks = db
      .query<{ type: string; tool_name: string | null }, []>(
        "SELECT type, tool_name FROM content_blocks WHERE type = 'tool_use'",
      )
      .all();

    expect(toolBlocks).toHaveLength(1);
    expect(toolBlocks[0].tool_name).toBe("Read");

    const resultBlocks = db
      .query<{ type: string; tool_output: string | null }, []>(
        "SELECT type, tool_output FROM content_blocks WHERE type = 'tool_result'",
      )
      .all();

    expect(resultBlocks).toHaveLength(1);
    expect(resultBlocks[0].tool_output).toContain("my-project");
  });

  test("redacts content before writing to SQLite", async () => {
    await withEnv("DEVLOG_TEST_SECRET_TOKEN_INDEX", "literal-secret-token-12345", async () => {
      const db = getDb(dbPath);
      await indexSession(
        path.join(FIXTURES_DIR, "claude-redaction.jsonl"),
        "claude",
        "test-project",
        db,
      );

      const textBlocks = db
        .query<{ text: string | null }, []>(
          "SELECT text FROM content_blocks WHERE type = 'text' ORDER BY id",
        )
        .all()
        .flatMap((row) => (row.text ? [row.text] : []));
      const toolInputs = db
        .query<{ tool_input: string | null }, []>(
          "SELECT tool_input FROM content_blocks WHERE type = 'tool_use' ORDER BY id",
        )
        .all()
        .flatMap((row) => (row.tool_input ? [row.tool_input] : []));
      const toolOutputs = db
        .query<{ tool_output: string | null }, []>(
          "SELECT tool_output FROM content_blocks WHERE type = 'tool_result' ORDER BY id",
        )
        .all()
        .flatMap((row) => (row.tool_output ? [row.tool_output] : []));
      const prUrls = db
        .query<{ pr_url: string }, []>("SELECT pr_url FROM pr_links ORDER BY rowid")
        .all()
        .map((row) => row.pr_url);

      const persisted = [...textBlocks, ...toolInputs, ...toolOutputs, ...prUrls].join("\n");

      expect(persisted).toContain("[REDACTED:openai-project-key]");
      expect(persisted).toContain("[REDACTED:devlog-test-secret-token-index]");
      expect(persisted).toContain("[REDACTED:github-token]");
      expect(persisted).toContain("[REDACTED:huggingface-token]");
      expect(persisted).toContain("[REDACTED:jwt]");

      expect(persisted).not.toContain("sk-proj-123456789012345678901234");
      expect(persisted).not.toContain("literal-secret-token-12345");
      expect(persisted).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz123456");
      expect(persisted).not.toContain("hf_abcdefghijklmnopqrstuvwxyz12");
    });
  });

  test("redacts OpenCode and Pi content before writing to SQLite", async () => {
    const db = getDb(dbPath);
    const cases: Array<{
      fixture: string;
      source: "opencode" | "pi";
      expected: string[];
      rawSecrets: string[];
    }> = [
      {
        fixture: "opencode-redaction.jsonl",
        source: "opencode",
        expected: [
          "[REDACTED:github-token]",
          "Bearer [REDACTED]",
          "[REDACTED:huggingface-token]",
          "[REDACTED:jwt]",
        ],
        rawSecrets: [
          "github_pat_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_abc",
          "ghp_abcdefghijklmnopqrstuvwxyz123456",
          "hf_abcdefghijklmnopqrstuvwxyz12",
          "eyJabcdefghijk.eyJlmnopqrstuv.ABCDEFGHIJKLMNO",
        ],
      },
      {
        fixture: "pi-redaction.jsonl",
        source: "pi",
        expected: [
          "[REDACTED:openrouter-key]",
          "[REDACTED:github-token]",
          "Bearer [REDACTED]",
          "[REDACTED:huggingface-token]",
          "[REDACTED:jwt]",
        ],
        rawSecrets: [
          "sk-or-abcdefghijklmnopqrstuvwxyz123456",
          "github_pat_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_abc",
          "hf_abcdefghijklmnopqrstuvwxyz12",
          "eyJabcdefghijk.eyJlmnopqrstuv.ABCDEFGHIJKLMNO",
        ],
      },
    ];

    for (const testCase of cases) {
      const filePath = path.join(FIXTURES_DIR, testCase.fixture);
      await indexSession(filePath, testCase.source, "test-project", db);

      const rows = db
        .query<
          { text: string | null; tool_input: string | null; tool_output: string | null },
          [string]
        >(
          "SELECT text, tool_input, tool_output FROM content_blocks WHERE file_path = ? ORDER BY id",
        )
        .all(filePath);

      const persisted = rows
        .flatMap((row) => [row.text, row.tool_input, row.tool_output])
        .flatMap((value) => (value ? [value] : []))
        .join("\n");

      for (const marker of testCase.expected) {
        expect(persisted).toContain(marker);
      }

      for (const secret of testCase.rawSecrets) {
        expect(persisted).not.toContain(secret);
      }
    }
  });

  test("indexes OpenCode session", async () => {
    const db = getDb(dbPath);
    await indexSession(
      path.join(FIXTURES_DIR, "opencode-simple.jsonl"),
      "opencode",
      "test-project",
      db,
    );

    const session = db
      .query<{ session_id: string; source: string }, []>("SELECT session_id, source FROM sessions")
      .get();

    expect(session?.session_id).toBe("ses_test123");
    expect(session?.source).toBe("opencode");
  });

  test("indexes Pi session", async () => {
    const db = getDb(dbPath);
    await indexSession(path.join(FIXTURES_DIR, "pi-simple.jsonl"), "pi", "test-project", db);

    const session = db
      .query<{ session_id: string; source: string; title: string | null }, []>(
        "SELECT session_id, source, title FROM sessions",
      )
      .get();

    expect(session?.session_id).toBe("pi-session-1");
    expect(session?.source).toBe("pi");
    expect(session?.title).toBe("Refactor auth module");

    const toolBlock = db
      .query<{ type: string; tool_name: string | null }, []>(
        "SELECT type, tool_name FROM content_blocks WHERE type = 'tool_use'",
      )
      .get();
    expect(toolBlock?.tool_name).toBe("read");
  });

  test("skips already-indexed files with same mtime", async () => {
    const db = getDb(dbPath);
    const fixturePath = path.join(FIXTURES_DIR, "claude-simple.jsonl");

    await indexSession(fixturePath, "claude", "test-project", db);

    const firstCount = db
      .query<{ count: number }, []>("SELECT COUNT(*) as count FROM messages")
      .get();
    expect(firstCount?.count).toBe(2);

    // Index again - should skip
    await indexSession(fixturePath, "claude", "test-project", db);

    const secondCount = db
      .query<{ count: number }, []>("SELECT COUNT(*) as count FROM messages")
      .get();
    expect(secondCount?.count).toBe(2); // Still 2, not 4
  });

  test("re-indexes files when mtime changes", async () => {
    const db = getDb(dbPath);

    // Copy fixture to temp location
    const tempFile = path.join(tempDir, "session.jsonl");
    fs.copyFileSync(path.join(FIXTURES_DIR, "claude-simple.jsonl"), tempFile);

    await indexSession(tempFile, "claude", "test-project", db);

    // Simulate mtime change by touching the file
    const futureTime = Date.now() / 1000 + 1000;
    fs.utimesSync(tempFile, futureTime, futureTime);

    await indexSession(tempFile, "claude", "test-project", db);

    // Should still have 2 messages (old ones deleted, new ones added)
    const count = db.query<{ count: number }, []>("SELECT COUNT(*) as count FROM messages").get();
    expect(count?.count).toBe(2);
  });

  test("keeps the previous indexed copy when redaction fails during re-index", async () => {
    const db = getDb(dbPath);
    const tempFile = path.join(tempDir, "session.jsonl");
    fs.copyFileSync(path.join(FIXTURES_DIR, "claude-simple.jsonl"), tempFile);

    await indexSession(tempFile, "claude", "test-project", db);

    const futureTime = Date.now() / 1000 + 1000;
    fs.utimesSync(tempFile, futureTime, futureTime);

    const failingContext: IndexRedactionContext = {
      get literalSecrets(): never {
        throw new Error("redaction unavailable");
      },
    };

    await expect(
      indexSession(tempFile, "claude", "test-project", db, failingContext),
    ).rejects.toThrow("redaction unavailable");

    const session = db
      .query<{ session_id: string }, [string]>(
        "SELECT session_id FROM sessions WHERE file_path = ?",
      )
      .get(tempFile);
    const messageCount = db
      .query<{ count: number }, [string]>(
        "SELECT COUNT(*) as count FROM messages WHERE file_path = ?",
      )
      .get(tempFile);

    expect(session?.session_id).toBe("test-session-1");
    expect(messageCount?.count).toBe(2);
  });

  test("indexAll indexes entire archive directory", async () => {
    const db = getDb(dbPath);

    // Create mock archive structure
    const archiveDir = path.join(tempDir, "archive", "projects");
    const projectDir = path.join(archiveDir, "test-project", "claude");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.copyFileSync(
      path.join(FIXTURES_DIR, "claude-simple.jsonl"),
      path.join(projectDir, "session1.jsonl"),
    );

    const stats = await indexAll(path.join(tempDir, "archive"), false, db);

    expect(stats.sessionsIndexed).toBe(1);
    expect(stats.messagesIndexed).toBe(2);

    // Run again - should skip
    const stats2 = await indexAll(path.join(tempDir, "archive"), false, db);
    expect(stats2.sessionsIndexed).toBe(0);
    expect(stats2.sessionsSkipped).toBe(1);
  });

  test("indexAll with rebuild flag re-indexes everything", async () => {
    const db = getDb(dbPath);

    const archiveDir = path.join(tempDir, "archive", "projects");
    const projectDir = path.join(archiveDir, "test-project", "claude");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.copyFileSync(
      path.join(FIXTURES_DIR, "claude-simple.jsonl"),
      path.join(projectDir, "session1.jsonl"),
    );

    await indexAll(path.join(tempDir, "archive"), false, db);

    // With rebuild, should re-index
    const stats = await indexAll(path.join(tempDir, "archive"), true, db);
    expect(stats.sessionsIndexed).toBe(1);
  });

  test("groups claude, opencode, and pi sessions under the same project slug", async () => {
    const db = getDb(dbPath);
    const archiveRoot = path.join(tempDir, "archive");
    const projectDir = path.join(archiveRoot, "projects", "test-project");

    fs.mkdirSync(path.join(projectDir, "claude"), { recursive: true });
    fs.mkdirSync(path.join(projectDir, "opencode"), { recursive: true });
    fs.mkdirSync(path.join(projectDir, "pi"), { recursive: true });

    fs.copyFileSync(
      path.join(FIXTURES_DIR, "claude-simple.jsonl"),
      path.join(projectDir, "claude", "claude-session.jsonl"),
    );
    fs.copyFileSync(
      path.join(FIXTURES_DIR, "opencode-simple.jsonl"),
      path.join(projectDir, "opencode", "opencode-session.jsonl"),
    );
    fs.copyFileSync(
      path.join(FIXTURES_DIR, "pi-simple.jsonl"),
      path.join(projectDir, "pi", "pi-session.jsonl"),
    );

    const stats = await indexAll(archiveRoot, false, db);
    expect(stats.sessionsIndexed).toBe(3);

    const rows = db
      .query<{ source: string; project: string }, []>(
        "SELECT source, project FROM sessions ORDER BY source ASC",
      )
      .all();

    expect(rows).toHaveLength(3);
    expect(rows).toEqual([
      { source: "claude", project: "test-project" },
      { source: "opencode", project: "test-project" },
      { source: "pi", project: "test-project" },
    ]);
  });

  test("indexes thinking blocks", async () => {
    const db = getDb(dbPath);
    await indexSession(path.join(FIXTURES_DIR, "claude-noise.jsonl"), "claude", "test-project", db);

    const thinkingBlocks = db
      .query<{ type: string; text: string | null }, []>(
        "SELECT type, text FROM content_blocks WHERE type = 'thinking'",
      )
      .all();

    expect(thinkingBlocks).toHaveLength(1);
    expect(thinkingBlocks[0].text).toBe("Let me think about this...");
  });

  test("indexes pr-link records into pr_links table", async () => {
    const db = getDb(dbPath);
    await indexSession(path.join(FIXTURES_DIR, "claude-noise.jsonl"), "claude", "test-project", db);

    const prLinks = db
      .query<{ pr_number: number; pr_url: string; pr_repository: string }, []>(
        "SELECT pr_number, pr_url, pr_repository FROM pr_links",
      )
      .all();

    expect(prLinks).toHaveLength(1);
    expect(prLinks[0].pr_number).toBe(109);
    expect(prLinks[0].pr_url).toBe("https://github.com/example-org/web-app/pull/109");
    expect(prLinks[0].pr_repository).toBe("example-org/web-app");
  });

  test("populates FTS index for searching", async () => {
    const db = getDb(dbPath);
    await indexSession(
      path.join(FIXTURES_DIR, "claude-simple.jsonl"),
      "claude",
      "test-project",
      db,
    );

    // FTS is contentless, so join with sessions to get actual values
    const ftsResults = db
      .query<{ session_id: string }, [string]>(
        `SELECT s.session_id
			 FROM messages_fts fts
			 JOIN sessions s ON fts.session_id = s.session_id
			 WHERE messages_fts MATCH ?`,
      )
      .all("Hello");

    expect(ftsResults.length).toBeGreaterThan(0);
    expect(ftsResults[0].session_id).toBe("test-session-1");
  });
});
