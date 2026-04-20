import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ensureDir,
  runArchive,
  setupPiSession,
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
