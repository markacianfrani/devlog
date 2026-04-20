import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  decodeOutput,
  ensureDir,
  FIXTURES_DIR,
  runArchive,
  setupOpenCodeSession,
  slugFromPath,
  withEnv,
  WORKSPACE_HASH,
  writeConfig,
  writeJsonl,
} from "./archive-fixtures.ts";

test("writes the index to config.dbPath when set", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "devlog-test-"));
  try {
    const worktree = path.join(home, "Code", "custom-db-project");
    ensureDir(worktree);

    const slug = slugFromPath(worktree);
    const claudeProjectDir = path.join(home, ".claude", "projects", slug);
    writeJsonl(path.join(claudeProjectDir, "session.jsonl"), [
      { type: "user", content: "hi" },
      { type: "assistant", content: "hello" },
    ]);

    const customDbPath = path.join(home, "custom", "my-index.db");
    writeConfig(home, { dbPath: customDbPath });

    const archiveResult = runArchive(home);
    expect(archiveResult.exitCode).toBe(0);

    const indexResult = runArchive(home, ["index"]);
    expect(indexResult.exitCode).toBe(0);

    expect(fs.existsSync(customDbPath)).toBe(true);
    const defaultDbPath = path.join(home, ".local", "state", "devlog", "index.db");
    expect(fs.existsSync(defaultDbPath)).toBe(false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("archives Claude conversations", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "devlog-test-"));
  try {
    const worktree = path.join(home, "Code", "playground", "markboard");
    ensureDir(worktree);

    const slug = slugFromPath(worktree);
    const claudeProjectDir = path.join(home, ".claude", "projects", slug);
    writeJsonl(path.join(claudeProjectDir, "session.jsonl"), [
      { type: "user", content: "hi" },
      { type: "assistant", content: "hello" },
    ]);

    const result = runArchive(home);
    expect(result.exitCode).toBe(0);

    const archiveRoot = path.join(home, ".config", "devlog", "projects", slug);
    expect(fs.existsSync(path.join(archiveRoot, "claude", "session.jsonl"))).toBe(true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("index command redacts indexed content without modifying archived files", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "devlog-test-"));

  try {
    await withEnv(
      "DEVLOG_TEST_SECRET_TOKEN_INTEGRATION",
      "literal-secret-token-12345",
      async () => {
        const worktree = path.join(home, "Code", "playground", "redaction-project");
        ensureDir(worktree);

        const slug = slugFromPath(worktree);
        const sourcePath = path.join(home, ".claude", "projects", slug, "redaction-session.jsonl");
        const fixtureContent = fs.readFileSync(
          path.join(FIXTURES_DIR, "claude-redaction.jsonl"),
          "utf-8",
        );
        ensureDir(path.dirname(sourcePath));
        fs.writeFileSync(sourcePath, fixtureContent);

        const archiveResult = runArchive(home);
        expect(archiveResult.exitCode).toBe(0);

        const archivedPath = path.join(
          home,
          ".config",
          "devlog",
          "projects",
          slug,
          "claude",
          "redaction-session.jsonl",
        );
        expect(fs.readFileSync(archivedPath, "utf-8")).toBe(fixtureContent);
        expect(fs.readFileSync(archivedPath, "utf-8")).toContain(
          "sk-proj-123456789012345678901234",
        );
        expect(fs.readFileSync(archivedPath, "utf-8")).toContain("literal-secret-token-12345");

        const indexResult = runArchive(home, ["index"]);
        expect(indexResult.exitCode).toBe(0);

        const dbPath = path.join(home, ".local", "state", "devlog", "index.db");
        const db = new Database(dbPath, { readonly: true });

        try {
          const rows = db
            .query<
              { text: string | null; tool_input: string | null; tool_output: string | null },
              []
            >("SELECT text, tool_input, tool_output FROM content_blocks ORDER BY id")
            .all();
          const prUrls = db
            .query<{ pr_url: string }, []>("SELECT pr_url FROM pr_links ORDER BY rowid")
            .all()
            .map((row) => row.pr_url);

          const persisted = [
            ...rows
              .flatMap((row) => [row.text, row.tool_input, row.tool_output])
              .flatMap((value) => (value ? [value] : [])),
            ...prUrls,
          ].join("\n");

          expect(persisted).toContain("[REDACTED:openai-project-key]");
          expect(persisted).toContain("[REDACTED:devlog-test-secret-token-integration]");
          expect(persisted).toContain("[REDACTED:github-token]");
          expect(persisted).toContain("[REDACTED:huggingface-token]");
          expect(persisted).toContain("[REDACTED:jwt]");

          expect(persisted).not.toContain("sk-proj-123456789012345678901234");
          expect(persisted).not.toContain("literal-secret-token-12345");
          expect(persisted).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz123456");
          expect(persisted).not.toContain("hf_abcdefghijklmnopqrstuvwxyz12");
        } finally {
          db.close();
        }
      },
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("excludeProjects fuzzy-matches Claude project slugs", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "devlog-test-"));
  try {
    const worktree = path.join(home, "src", "tries", "2026-02-17", "meetings");
    ensureDir(worktree);

    const slug = slugFromPath(worktree);
    writeConfig(home, { excludeProjects: ["meetings"] });

    const claudeProjectDir = path.join(home, ".claude", "projects", slug);
    writeJsonl(path.join(claudeProjectDir, "session.jsonl"), [
      { type: "user", content: "hi" },
      { type: "assistant", content: "hello" },
    ]);

    const result = runArchive(home);
    expect(result.exitCode).toBe(0);

    const archivePath = path.join(home, ".config", "devlog", "projects", slug, "claude");
    expect(fs.existsSync(archivePath)).toBe(false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("archives subagent session files under their parent session directory", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "devlog-test-"));
  try {
    const worktree = path.join(home, "Code", "myproject");
    ensureDir(worktree);
    const slug = slugFromPath(worktree);
    const sessionId = "abc12345-0000-0000-0000-000000000000";
    const claudeProjectDir = path.join(home, ".claude", "projects", slug);

    writeJsonl(path.join(claudeProjectDir, `${sessionId}.jsonl`), [
      { type: "user", content: "hi" },
    ]);

    const agentFile = "agent-abc123.jsonl";
    writeJsonl(path.join(claudeProjectDir, sessionId, "subagents", agentFile), [
      { type: "user", content: "subagent task" },
    ]);

    runArchive(home);

    const archiveRoot = path.join(home, ".config", "devlog", "projects", slug);
    expect(fs.existsSync(path.join(archiveRoot, "claude", `${sessionId}.jsonl`))).toBe(true);
    expect(fs.existsSync(path.join(archiveRoot, "claude", sessionId, "subagents", agentFile))).toBe(
      true,
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("re-archives Claude conversation when source file is updated after first archive", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "devlog-test-"));
  try {
    const worktree = path.join(home, "Code", "playground", "markboard");
    ensureDir(worktree);
    const slug = slugFromPath(worktree);
    const claudeProjectDir = path.join(home, ".claude", "projects", slug);
    const sourcePath = path.join(claudeProjectDir, "session.jsonl");

    writeJsonl(sourcePath, [
      { type: "user", content: "first message" },
      { type: "assistant", content: "hello" },
    ]);

    runArchive(home);

    const archivePath = path.join(
      home,
      ".config",
      "devlog",
      "projects",
      slug,
      "claude",
      "session.jsonl",
    );
    const firstLines = fs.readFileSync(archivePath, "utf-8").trim().split("\n");
    expect(firstLines).toHaveLength(2);

    Bun.sleepSync(50);
    fs.appendFileSync(sourcePath, "\n" + JSON.stringify({ type: "user", content: "day two" }));

    runArchive(home);

    const secondLines = fs.readFileSync(archivePath, "utf-8").trim().split("\n");
    expect(secondLines).toHaveLength(3);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("uses compact summary output by default", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "devlog-test-"));
  try {
    const worktree = path.join(home, "Code", "myproject");
    ensureDir(worktree);

    setupOpenCodeSession(home, {
      sessionId: "ses_summary",
      workspaceHash: WORKSPACE_HASH,
      worktree,
      messages: [
        {
          id: "msg_1",
          role: "user",
          parts: [{ id: "prt_1", type: "text", text: "first" }],
        },
      ],
    });

    runArchive(home);
    const secondRun = runArchive(home);
    const stdout = decodeOutput(secondRun.stdout);

    expect(stdout).toContain("Scanning sources...");
    expect(stdout).toContain("Updated: 0 sessions");
    expect(stdout).toContain("Skipped: 1 unchanged");
    expect(stdout).not.toContain("⏭️  Skipped:");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("shows per-session skip details in verbose mode", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "devlog-test-"));
  try {
    const worktree = path.join(home, "Code", "myproject");
    ensureDir(worktree);

    setupOpenCodeSession(home, {
      sessionId: "ses_verbose",
      workspaceHash: WORKSPACE_HASH,
      worktree,
      messages: [
        {
          id: "msg_1",
          role: "user",
          parts: [{ id: "prt_1", type: "text", text: "first" }],
        },
      ],
    });

    runArchive(home);
    const verboseRun = runArchive(home, ["archive", "--verbose"]);
    const stdout = decodeOutput(verboseRun.stdout);

    expect(stdout).toContain("⏭️  Skipped: ses_verbose");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
