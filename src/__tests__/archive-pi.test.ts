import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ensureDir,
  runArchive,
  setupPiSession,
  setupPiSubagentSession,
  slugFromPath,
  writeConfig,
} from "./archive-fixtures.ts";

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

test("archives pi-subagents nested sessions with hierarchy preserved in the filename", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "devlog-test-"));
  try {
    const worktree = path.join(home, "Code", "pi-project");
    ensureDir(worktree);
    const slug = slugFromPath(worktree);

    const topGroup = "2026-05-17T17-03-17-486Z_top-uuid-1";

    // Two subagents under the same top group, one of them with two runs.
    // pi-subagents writes session.jsonl four levels below the project dir,
    // and every leaf has the same filename -- so the archive name must
    // disambiguate by top group, subagent, and run.
    setupPiSubagentSession(home, {
      sessionId: "pi-sub-a-run-0",
      worktree,
      topGroup,
      subagent: "subagent-aaaa",
      run: 0,
      entries: [
        {
          type: "message",
          message: { role: "user", content: "subagent A first run" },
        },
      ],
    });
    setupPiSubagentSession(home, {
      sessionId: "pi-sub-a-run-1",
      worktree,
      topGroup,
      subagent: "subagent-aaaa",
      run: 1,
      entries: [
        {
          type: "message",
          message: { role: "user", content: "subagent A second run" },
        },
      ],
    });
    setupPiSubagentSession(home, {
      sessionId: "pi-sub-b-run-0",
      worktree,
      topGroup,
      subagent: "subagent-bbbb",
      run: 0,
      entries: [
        {
          type: "message",
          message: { role: "user", content: "subagent B" },
        },
      ],
    });

    const result = runArchive(home);
    expect(result.exitCode).toBe(0);

    const piDir = path.join(home, ".config", "devlog", "projects", slug, "pi");

    // All three leaf files should land in pi/ with names that capture the
    // top group / subagent / run so they cannot collide.
    const expectA0 = path.join(piDir, `${topGroup}__subagent-aaaa__run-0.jsonl`);
    const expectA1 = path.join(piDir, `${topGroup}__subagent-aaaa__run-1.jsonl`);
    const expectB0 = path.join(piDir, `${topGroup}__subagent-bbbb__run-0.jsonl`);

    expect(fs.existsSync(expectA0)).toBe(true);
    expect(fs.existsSync(expectA1)).toBe(true);
    expect(fs.existsSync(expectB0)).toBe(true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("flat and nested pi layouts can coexist for the same project", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "devlog-test-"));
  try {
    const worktree = path.join(home, "Code", "pi-project");
    ensureDir(worktree);
    const slug = slugFromPath(worktree);

    setupPiSession(home, {
      sessionId: "pi-legacy",
      worktree,
      fileName: "pi-legacy.jsonl",
      entries: [{ type: "message", message: { role: "user", content: "legacy flat" } }],
    });

    setupPiSubagentSession(home, {
      sessionId: "pi-nested",
      worktree,
      topGroup: "2026-05-17T17-03-17-486Z_top",
      subagent: "subagent-xyz",
      run: 0,
      entries: [{ type: "message", message: { role: "user", content: "nested leaf" } }],
    });

    const result = runArchive(home);
    expect(result.exitCode).toBe(0);

    const piDir = path.join(home, ".config", "devlog", "projects", slug, "pi");
    const legacyArchive = path.join(piDir, "pi-legacy.jsonl");
    const nestedArchive = path.join(
      piDir,
      "2026-05-17T17-03-17-486Z_top__subagent-xyz__run-0.jsonl",
    );

    expect(fs.existsSync(legacyArchive)).toBe(true);
    expect(fs.existsSync(nestedArchive)).toBe(true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
