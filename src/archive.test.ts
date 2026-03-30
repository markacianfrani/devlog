import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  iterateOpencodeDbSessions,
  reconstructSessionJsonl,
  slugFromPath as archiveSlugFromPath,
} from "./archive.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const BIN_PATH = path.join(REPO_ROOT, "src", "archive.ts");
const WORKSPACE_HASH = "5c9dbe89c9230dfefb77d96d9a7d13853999ce23";

function slugFromPath(value: string) {
  const segments = path
    .resolve(value)
    .split(path.sep)
    .filter(Boolean)
    .map((segment) => segment.replace(/[^a-zA-Z0-9]/g, "-"))
    .join("-");

  return `-${segments}`;
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath: string, data: unknown) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data));
}

function writeJsonl(filePath: string, lines: Array<Record<string, unknown>>) {
  ensureDir(path.dirname(filePath));
  const content = lines.map((line) => JSON.stringify(line)).join("\n");
  fs.writeFileSync(filePath, content);
}

function runArchive(home: string, args: string[] = []) {
  return Bun.spawnSync({
    cmd: ["bun", BIN_PATH, ...args],
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
}

function writeConfig(home: string, config: Record<string, unknown>) {
  writeJson(path.join(home, ".config", "devlog", "config.json"), config);
}

function decodeOutput(buffer: Uint8Array | undefined) {
  return buffer ? new TextDecoder().decode(buffer) : "";
}

interface OpenCodeFixture {
  storageDir: string;
  sessionId: string;
  workspaceHash: string;
}

function setupOpenCodeSession(
  home: string,
  opts: {
    sessionId: string;
    workspaceHash: string;
    worktree: string;
    messages: Array<{
      id: string;
      role: string;
      parentID?: string;
      modelID?: string;
      providerID?: string;
      parts: Array<{ id: string; type: string; text?: string; tool?: string; state?: unknown }>;
    }>;
  },
): OpenCodeFixture {
  const storageDir = path.join(home, ".local", "share", "opencode", "storage");
  const baseTime = Date.now();

  // Write session file
  const sessionDir = path.join(storageDir, "session", opts.workspaceHash);
  writeJson(path.join(sessionDir, `${opts.sessionId}.json`), {
    id: opts.sessionId,
    projectID: opts.workspaceHash,
    directory: opts.worktree,
    title: "Test session",
    time: { created: baseTime, updated: baseTime },
  });

  // Write project file
  const projectDir = path.join(storageDir, "project");
  writeJson(path.join(projectDir, `${opts.workspaceHash}.json`), { worktree: opts.worktree });

  // Write messages and parts with incrementing timestamps
  for (let i = 0; i < opts.messages.length; i++) {
    const msg = opts.messages[i];
    const messageDir = path.join(storageDir, "message", opts.sessionId);
    writeJson(path.join(messageDir, `${msg.id}.json`), {
      id: msg.id,
      sessionID: opts.sessionId,
      role: msg.role,
      time: { created: baseTime + i * 1000 },
      parentID: msg.parentID,
      modelID: msg.modelID,
      providerID: msg.providerID,
    });

    for (const part of msg.parts) {
      const partDir = path.join(storageDir, "part", msg.id);
      writeJson(path.join(partDir, `${part.id}.json`), {
        id: part.id,
        sessionID: opts.sessionId,
        messageID: msg.id,
        type: part.type,
        text: part.text,
        tool: part.tool,
        state: part.state,
      });
    }
  }

  return { storageDir, sessionId: opts.sessionId, workspaceHash: opts.workspaceHash };
}

function setupPiSession(
  home: string,
  opts: {
    sessionId: string;
    worktree: string;
    fileName?: string;
    entries: Array<Record<string, unknown>>;
  },
): string {
  const sessionDirName = `--${opts.worktree.split(path.sep).filter(Boolean).join("-")}--`;
  const sessionDir = path.join(home, ".pi", "agent", "sessions", sessionDirName);
  const fileName = opts.fileName ?? `${opts.sessionId}.jsonl`;
  writeJsonl(path.join(sessionDir, fileName), [
    {
      type: "session",
      version: 3,
      id: opts.sessionId,
      timestamp: "2026-03-15T20:09:38.000Z",
      cwd: opts.worktree,
    },
    ...opts.entries,
  ]);
  return path.join(sessionDir, fileName);
}

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

test("reconstructs opencode session as JSONL from message/part directories", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "devlog-test-"));
  try {
    const worktree = path.join(home, "Code", "myproject");
    ensureDir(worktree);
    const slug = slugFromPath(worktree);

    setupOpenCodeSession(home, {
      sessionId: "ses_test123",
      workspaceHash: WORKSPACE_HASH,
      worktree,
      messages: [
        {
          id: "msg_user1",
          role: "user",
          parts: [{ id: "prt_user1", type: "text", text: "Hello, help me with code" }],
        },
        {
          id: "msg_asst1",
          role: "assistant",
          parentID: "msg_user1",
          modelID: "claude-opus-4-5",
          providerID: "anthropic",
          parts: [
            { id: "prt_asst1_text", type: "text", text: "Sure, I can help!" },
            {
              id: "prt_asst1_tool",
              type: "tool",
              tool: "read",
              state: { status: "completed", input: { path: "/foo" }, output: "file contents" },
            },
          ],
        },
      ],
    });

    const result = runArchive(home);
    expect(result.exitCode).toBe(0);

    const archivePath = path.join(
      home,
      ".config",
      "devlog",
      "projects",
      slug,
      "opencode",
      "ses_test123.jsonl",
    );
    expect(fs.existsSync(archivePath)).toBe(true);

    const lines = fs.readFileSync(archivePath, "utf-8").trim().split("\n");
    expect(lines.length).toBe(2);

    const userMsg = JSON.parse(lines[0]);
    expect(userMsg.type).toBe("user");
    expect(userMsg.message.role).toBe("user");
    expect(userMsg.message.content).toBe("Hello, help me with code");
    expect(userMsg.sessionId).toBe("ses_test123");

    const asstMsg = JSON.parse(lines[1]);
    expect(asstMsg.type).toBe("assistant");
    expect(asstMsg.message.role).toBe("assistant");
    expect(asstMsg.message.model).toBe("claude-opus-4-5");
    expect(asstMsg.provider).toBe("anthropic");
    expect(Array.isArray(asstMsg.message.content)).toBe(true);
    expect(asstMsg.message.content.length).toBe(3); // text + tool_use + tool_result
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("skips sessions with no messages", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "devlog-test-"));
  try {
    const worktree = path.join(home, "Code", "emptyproject");
    ensureDir(worktree);
    const slug = slugFromPath(worktree);

    // Set up session file but no messages
    const storageDir = path.join(home, ".local", "share", "opencode", "storage");
    const sessionDir = path.join(storageDir, "session", WORKSPACE_HASH);
    writeJson(path.join(sessionDir, "ses_empty.json"), {
      id: "ses_empty",
      projectID: WORKSPACE_HASH,
      directory: worktree,
      time: { created: Date.now(), updated: Date.now() },
    });

    const projectDir = path.join(storageDir, "project");
    writeJson(path.join(projectDir, `${WORKSPACE_HASH}.json`), { worktree });

    const result = runArchive(home);
    expect(result.exitCode).toBe(0);

    const archivePath = path.join(
      home,
      ".config",
      "devlog",
      "projects",
      slug,
      "opencode",
      "ses_empty.jsonl",
    );
    expect(fs.existsSync(archivePath)).toBe(false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("falls back to workspace hash when worktree missing", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "devlog-test-"));
  try {
    const storageDir = path.join(home, ".local", "share", "opencode", "storage");

    // Set up session without project file
    const sessionDir = path.join(storageDir, "session", WORKSPACE_HASH);
    writeJson(path.join(sessionDir, "ses_noproj.json"), {
      id: "ses_noproj",
      projectID: WORKSPACE_HASH,
      directory: "/some/path",
      time: { created: Date.now(), updated: Date.now() },
    });

    // Set up message and part
    const messageDir = path.join(storageDir, "message", "ses_noproj");
    writeJson(path.join(messageDir, "msg_1.json"), {
      id: "msg_1",
      sessionID: "ses_noproj",
      role: "user",
      time: { created: Date.now() },
    });

    const partDir = path.join(storageDir, "part", "msg_1");
    writeJson(path.join(partDir, "prt_1.json"), {
      id: "prt_1",
      sessionID: "ses_noproj",
      messageID: "msg_1",
      type: "text",
      text: "yo",
    });

    const result = runArchive(home);
    expect(result.exitCode).toBe(0);

    const archivePath = path.join(
      home,
      ".config",
      "devlog",
      "projects",
      WORKSPACE_HASH,
      "opencode",
      "ses_noproj.jsonl",
    );
    expect(fs.existsSync(archivePath)).toBe(true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("archives opencode sessions from SQLite DB", () => {
  const db = new Database(":memory:");
  const worktree = "/tmp/fake/dbproject";
  const baseTime = Date.now();

  db.exec(`
		CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);
		CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, directory TEXT NOT NULL, title TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);
		CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL, time_created INTEGER NOT NULL);
		CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, data TEXT NOT NULL, time_created INTEGER NOT NULL);
	`);

  db.run("INSERT INTO project VALUES (?, ?, ?, ?)", ["proj_abc", worktree, baseTime, baseTime]);
  db.run("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)", [
    "ses_db1",
    "proj_abc",
    worktree,
    "Test",
    baseTime,
    baseTime,
  ]);

  db.run("INSERT INTO message VALUES (?, ?, ?, ?)", [
    "msg_user1",
    "ses_db1",
    JSON.stringify({ role: "user", time: { created: baseTime } }),
    baseTime,
  ]);
  db.run("INSERT INTO part VALUES (?, ?, ?, ?, ?)", [
    "prt_u1",
    "msg_user1",
    "ses_db1",
    JSON.stringify({ type: "text", text: "Help me from the DB" }),
    baseTime,
  ]);

  db.run("INSERT INTO message VALUES (?, ?, ?, ?)", [
    "msg_asst1",
    "ses_db1",
    JSON.stringify({
      role: "assistant",
      time: { created: baseTime + 1000 },
      parentID: "msg_user1",
      modelID: "claude-opus-4-5",
      providerID: "anthropic",
    }),
    baseTime + 1000,
  ]);
  db.run("INSERT INTO part VALUES (?, ?, ?, ?, ?)", [
    "prt_a1_text",
    "msg_asst1",
    "ses_db1",
    JSON.stringify({ type: "text", text: "Sure thing!" }),
    baseTime + 1000,
  ]);
  db.run("INSERT INTO part VALUES (?, ?, ?, ?, ?)", [
    "prt_a1_tool",
    "msg_asst1",
    "ses_db1",
    JSON.stringify({
      type: "tool",
      tool: "read",
      callID: "call_123",
      state: { status: "completed", input: { path: "/foo" }, output: "contents" },
    }),
    baseTime + 1000,
  ]);

  const results = [...iterateOpencodeDbSessions(db, archiveSlugFromPath)];
  expect(results.length).toBe(1);

  const { projectSlug, session, messagesWithParts } = results[0];
  expect(projectSlug).toBe(archiveSlugFromPath(worktree));
  expect(session.id).toBe("ses_db1");

  const lines = reconstructSessionJsonl("ses_db1", session, messagesWithParts);
  expect(lines.length).toBe(2);

  const userMsg = JSON.parse(lines[0]);
  expect(userMsg.type).toBe("user");
  expect(userMsg.message.content).toBe("Help me from the DB");
  expect(userMsg.sessionId).toBe("ses_db1");

  const asstMsg = JSON.parse(lines[1]);
  expect(asstMsg.type).toBe("assistant");
  expect(asstMsg.message.model).toBe("claude-opus-4-5");
  expect(asstMsg.provider).toBe("anthropic");
  expect(asstMsg.message.content.length).toBe(3); // text + tool_use + tool_result

  db.close();
});

test("iterateOpencodeDbSessions throws on broken schema", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE something_else (id TEXT PRIMARY KEY, data TEXT)");

  expect(() => [...iterateOpencodeDbSessions(db, archiveSlugFromPath)]).toThrow();

  db.close();
});

test("falls back to flat files when DB has broken schema", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "devlog-test-"));
  try {
    const worktree = path.join(home, "Code", "fallbackproject");
    ensureDir(worktree);
    const slug = slugFromPath(worktree);

    // Create a DB with a completely different schema
    const dbPath = path.join(home, ".local", "share", "opencode", "opencode.db");
    ensureDir(path.dirname(dbPath));
    const db = new Database(dbPath);
    db.exec("CREATE TABLE something_else (id TEXT PRIMARY KEY, data TEXT)");
    db.close();

    // Also set up flat file session so fallback has something to archive
    setupOpenCodeSession(home, {
      sessionId: "ses_fallback",
      workspaceHash: WORKSPACE_HASH,
      worktree,
      messages: [
        {
          id: "msg_fb1",
          role: "user",
          parts: [{ id: "prt_fb1", type: "text", text: "Flat file fallback" }],
        },
      ],
    });

    const result = runArchive(home);
    expect(result.exitCode).toBe(0);

    // Flat file session should have been archived
    const archivePath = path.join(
      home,
      ".config",
      "devlog",
      "projects",
      slug,
      "opencode",
      "ses_fallback.jsonl",
    );
    expect(fs.existsSync(archivePath)).toBe(true);

    const lines = fs.readFileSync(archivePath, "utf-8").trim().split("\n");
    const userMsg = JSON.parse(lines[0]);
    expect(userMsg.message.content).toBe("Flat file fallback");
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

test("excludeProjects fuzzy-matches opencode project paths", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "devlog-test-"));
  try {
    const worktree = path.join(home, "Code", "team-meetings-notes");
    ensureDir(worktree);
    const slug = slugFromPath(worktree);
    writeConfig(home, { excludeProjects: ["meetings"] });

    setupOpenCodeSession(home, {
      sessionId: "ses_excluded",
      workspaceHash: WORKSPACE_HASH,
      worktree,
      messages: [
        {
          id: "msg_1",
          role: "user",
          parts: [{ id: "prt_1", type: "text", text: "skip me" }],
        },
      ],
    });

    const result = runArchive(home);
    expect(result.exitCode).toBe(0);

    const archivePath = path.join(
      home,
      ".config",
      "devlog",
      "projects",
      slug,
      "opencode",
      "ses_excluded.jsonl",
    );
    expect(fs.existsSync(archivePath)).toBe(false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("excludeProjects fuzzy-matches pi session cwd paths", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "devlog-test-"));
  try {
    const worktree = path.join(home, "Code", "weekly-meetings");
    ensureDir(worktree);
    const slug = slugFromPath(worktree);
    writeConfig(home, { excludeProjects: ["meetings"] });

    setupPiSession(home, {
      sessionId: "pi_excluded",
      worktree,
      entries: [
        {
          type: "message",
          message: { role: "user", content: "skip me" },
        },
      ],
    });

    const result = runArchive(home);
    expect(result.exitCode).toBe(0);

    const archivePath = path.join(home, ".config", "devlog", "projects", slug, "pi");
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

    // Simulate session continuing the next day
    Bun.sleepSync(50);
    fs.appendFileSync(sourcePath, "\n" + JSON.stringify({ type: "user", content: "day two" }));

    runArchive(home);

    const secondLines = fs.readFileSync(archivePath, "utf-8").trim().split("\n");
    expect(secondLines).toHaveLength(3);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("re-archives opencode session when new messages are added after first archive", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "devlog-test-"));
  try {
    const worktree = path.join(home, "Code", "myproject");
    ensureDir(worktree);
    const slug = slugFromPath(worktree);

    setupOpenCodeSession(home, {
      sessionId: "ses_growing",
      workspaceHash: WORKSPACE_HASH,
      worktree,
      messages: [
        {
          id: "msg_1",
          role: "user",
          parts: [{ id: "prt_1", type: "text", text: "first message" }],
        },
      ],
    });

    runArchive(home);

    const archivePath = path.join(
      home,
      ".config",
      "devlog",
      "projects",
      slug,
      "opencode",
      "ses_growing.jsonl",
    );
    const firstLines = fs.readFileSync(archivePath, "utf-8").trim().split("\n");
    expect(firstLines).toHaveLength(1);

    // Simulate session continuing: new messages written, session updated time bumped
    Bun.sleepSync(50);
    const storageDir = path.join(home, ".local", "share", "opencode", "storage");
    const newTime = Date.now();

    writeJson(path.join(storageDir, "message", "ses_growing", "msg_2.json"), {
      id: "msg_2",
      sessionID: "ses_growing",
      role: "assistant",
      time: { created: newTime },
    });
    writeJson(path.join(storageDir, "part", "msg_2", "prt_2.json"), {
      id: "prt_2",
      sessionID: "ses_growing",
      messageID: "msg_2",
      type: "text",
      text: "second message",
    });

    // opencode bumps time.updated when new messages arrive
    const sessionFilePath = path.join(storageDir, "session", WORKSPACE_HASH, "ses_growing.json");
    const sessionData = JSON.parse(fs.readFileSync(sessionFilePath, "utf-8"));
    sessionData.time.updated = newTime;
    fs.writeFileSync(sessionFilePath, JSON.stringify(sessionData));

    runArchive(home);

    const secondLines = fs.readFileSync(archivePath, "utf-8").trim().split("\n");
    expect(secondLines).toHaveLength(2);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("does not re-archive existing sessions", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "devlog-test-"));
  try {
    const worktree = path.join(home, "Code", "myproject");
    ensureDir(worktree);
    const slug = slugFromPath(worktree);

    setupOpenCodeSession(home, {
      sessionId: "ses_existing",
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

    // First archive
    runArchive(home);

    const archivePath = path.join(
      home,
      ".config",
      "devlog",
      "projects",
      slug,
      "opencode",
      "ses_existing.jsonl",
    );
    const firstContent = fs.readFileSync(archivePath, "utf-8");
    const firstMtime = fs.statSync(archivePath).mtimeMs;

    // Wait a bit and run again
    Bun.sleepSync(50);
    runArchive(home);

    const secondMtime = fs.statSync(archivePath).mtimeMs;
    const secondContent = fs.readFileSync(archivePath, "utf-8");

    expect(secondMtime).toBe(firstMtime);
    expect(secondContent).toBe(firstContent);
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

test("archives pi sessions", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "devlog-test-"));
  try {
    const worktree = path.join(home, "Code", "pi-project");
    ensureDir(worktree);
    const slug = slugFromPath(worktree);

    setupPiSession(home, {
      sessionId: "pi-session-1",
      worktree,
      fileName: "2026-03-15T20-09-38-000Z_pi-session-1.jsonl",
      entries: [
        {
          type: "message",
          id: "u1",
          parentId: undefined,
          timestamp: "2026-03-15T20:10:00.000Z",
          message: { role: "user", content: [{ type: "text", text: "hello from pi" }] },
        },
      ],
    });

    const result = runArchive(home);
    expect(result.exitCode).toBe(0);

    const archivePath = path.join(
      home,
      ".config",
      "devlog",
      "projects",
      slug,
      "pi",
      "2026-03-15T20-09-38-000Z_pi-session-1.jsonl",
    );
    expect(fs.existsSync(archivePath)).toBe(true);
    const archived = fs.readFileSync(archivePath, "utf-8");
    expect(archived).toContain('"type":"session"');
    expect(archived).toContain("hello from pi");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("re-archives pi sessions when source file changes", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "devlog-test-"));
  try {
    const worktree = path.join(home, "Code", "pi-project");
    ensureDir(worktree);
    const slug = slugFromPath(worktree);
    const sourcePath = setupPiSession(home, {
      sessionId: "pi-session-growing",
      worktree,
      fileName: "pi-growing.jsonl",
      entries: [
        {
          type: "message",
          id: "u1",
          parentId: undefined,
          timestamp: "2026-03-15T20:10:00.000Z",
          message: { role: "user", content: [{ type: "text", text: "first pi message" }] },
        },
      ],
    });

    runArchive(home);

    const archivePath = path.join(
      home,
      ".config",
      "devlog",
      "projects",
      slug,
      "pi",
      "pi-growing.jsonl",
    );
    const firstLines = fs.readFileSync(archivePath, "utf-8").trim().split("\n");
    expect(firstLines).toHaveLength(2);

    Bun.sleepSync(50);
    fs.appendFileSync(
      sourcePath,
      "\n" +
        JSON.stringify({
          type: "message",
          id: "a1",
          parentId: "u1",
          timestamp: "2026-03-15T20:10:05.000Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "second pi message" }],
            model: "gpt-5.4",
          },
        }),
    );

    runArchive(home);

    const secondLines = fs.readFileSync(archivePath, "utf-8").trim().split("\n");
    expect(secondLines).toHaveLength(3);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
