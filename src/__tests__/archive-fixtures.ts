import fs from "node:fs";
import path from "node:path";

export const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
export const BIN_PATH = path.join(REPO_ROOT, "src", "archive.ts");
export const FIXTURES_DIR = path.join(import.meta.dir, "fixtures");
export const WORKSPACE_HASH = "5c9dbe89c9230dfefb77d96d9a7d13853999ce23";

export async function withEnv<T>(
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

export function slugFromPath(value: string) {
  const segments = path
    .resolve(value)
    .split(path.sep)
    .filter(Boolean)
    .map((segment) => segment.replace(/[^a-zA-Z0-9]/g, "-"))
    .join("-");

  return `-${segments}`;
}

export function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function writeJson(filePath: string, data: unknown) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data));
}

export function writeJsonl(filePath: string, lines: Array<Record<string, unknown>>) {
  ensureDir(path.dirname(filePath));
  const content = lines.map((line) => JSON.stringify(line)).join("\n");
  fs.writeFileSync(filePath, content);
}

export function runArchive(home: string, args: string[] = []) {
  return Bun.spawnSync({
    cmd: ["bun", BIN_PATH, ...args],
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
}

export function writeConfig(home: string, config: Record<string, unknown>) {
  writeJson(path.join(home, ".config", "devlog", "config.json"), config);
}

export function decodeOutput(buffer: Uint8Array | undefined) {
  return buffer ? new TextDecoder().decode(buffer) : "";
}

export interface OpenCodeFixture {
  storageDir: string;
  sessionId: string;
  workspaceHash: string;
}

export function setupOpenCodeSession(
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

  const sessionDir = path.join(storageDir, "session", opts.workspaceHash);
  writeJson(path.join(sessionDir, `${opts.sessionId}.json`), {
    id: opts.sessionId,
    projectID: opts.workspaceHash,
    directory: opts.worktree,
    title: "Test session",
    time: { created: baseTime, updated: baseTime },
  });

  const projectDir = path.join(storageDir, "project");
  writeJson(path.join(projectDir, `${opts.workspaceHash}.json`), { worktree: opts.worktree });

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

export function setupPiSession(
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
