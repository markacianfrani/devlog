import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  iterateOpencodeDbSessions,
  reconstructSessionJsonl,
  slugFromPath as archiveSlugFromPath,
} from "../archive.ts";
import {
  ensureDir,
  runArchive,
  setupOpenCodeSession,
  slugFromPath,
  WORKSPACE_HASH,
  writeConfig,
  writeJson,
} from "./archive-fixtures.ts";

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
    expect(asstMsg.message.content.length).toBe(3);
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

    const sessionDir = path.join(storageDir, "session", WORKSPACE_HASH);
    writeJson(path.join(sessionDir, "ses_noproj.json"), {
      id: "ses_noproj",
      projectID: WORKSPACE_HASH,
      directory: "/some/path",
      time: { created: Date.now(), updated: Date.now() },
    });

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
  expect(asstMsg.message.content.length).toBe(3);

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

    const dbPath = path.join(home, ".local", "share", "opencode", "opencode.db");
    ensureDir(path.dirname(dbPath));
    const db = new Database(dbPath);
    db.exec("CREATE TABLE something_else (id TEXT PRIMARY KEY, data TEXT)");
    db.close();

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
