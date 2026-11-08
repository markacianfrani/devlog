import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { closeDb, getDb } from "../db.ts";
import { indexAll } from "../indexer.ts";

const claudeUserLine = (sessionId: string, uuid: string, text: string, ts: string) =>
  JSON.stringify({
    type: "user",
    sessionId,
    uuid,
    parentUuid: null,
    timestamp: ts,
    cwd: "/home/user/project",
    message: { role: "user", content: text },
  });

const claudeForkRefLine = (parentSessionId: string) =>
  JSON.stringify({ type: "fork-context-ref", parentSessionId });

const piHeader = (id: string, parentSession?: string) =>
  JSON.stringify({
    type: "session",
    version: 3,
    id,
    timestamp: "2026-01-01T00:00:00Z",
    cwd: "/tmp/fart-project",
    ...(parentSession ? { parentSession } : {}),
  });
const piUser = (id: string) =>
  JSON.stringify({
    type: "message",
    id,
    timestamp: "2026-01-01T00:00:01Z",
    message: { role: "user", content: [{ type: "text", text: "fart task" }] },
  });

type IndexDb = ReturnType<typeof getDb>;

const relationshipForRow = (db: IndexDb, filePath: string) =>
  db
    .query<
      {
        session_id: string;
        parent_session_id: string | null;
        relation_kind: string | null;
        parent_file_path: string | null;
      },
      [string]
    >(
      "SELECT session_id, parent_session_id, relation_kind, parent_file_path FROM sessions WHERE file_path = ?",
    )
    .get(filePath);

describe("session relationships", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "devlog-relationships-test-"));
    dbPath = path.join(tempDir, "index.db");
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test("resolves a parent transcript for an exact, same-project, same-source, non-self match", async () => {
    const parentId = "11111111-2222-4333-8444-555555555555";
    // Claude's child echoes its parent's session ID, but has its own file key.
    const childId = parentId;
    const projectDir = path.join(tempDir, "projects", "fart-project", "claude");
    fs.mkdirSync(projectDir, { recursive: true });
    // Claude Code archives subagent transcripts under the parent's uuid.
    const childFile = path.join(projectDir, parentId, "subagents", "agent-fart.jsonl");
    fs.mkdirSync(path.dirname(childFile), { recursive: true });
    const parentFile = path.join(projectDir, `${parentId}.jsonl`);
    fs.writeFileSync(
      parentFile,
      claudeUserLine(parentId, "p1", "fart opener", "2026-02-01T10:00:00.000Z"),
    );
    fs.writeFileSync(
      childFile,
      claudeUserLine(childId, "c1", "fart task", "2026-02-01T10:00:01.000Z"),
    );

    const db = getDb(dbPath);
    const stats = await indexAll(tempDir, false, db);
    expect(stats.sessionsIndexed).toBe(2);

    expect(relationshipForRow(db, childFile)).toEqual({
      session_id: childId,
      parent_session_id: parentId,
      relation_kind: "subagent",
      parent_file_path: parentFile,
    });
  });

  test("resolves two Claude subagent siblings by archive parent, not their shared session id", async () => {
    const sharedId = "22222222-3333-4444-8555-666666666666";
    const projectDir = path.join(tempDir, "projects", "fart-project", "claude");
    const subagentDir = path.join(projectDir, sharedId, "subagents");
    fs.mkdirSync(subagentDir, { recursive: true });
    const parentFile = path.join(projectDir, `${sharedId}.jsonl`);
    fs.writeFileSync(parentFile, claudeUserLine(sharedId, "p1", "opener", "2026-02-02T10:00:00Z"));
    const children = ["agent-one.jsonl", "agent-two.jsonl"].map((name, index) => {
      const file = path.join(subagentDir, name);
      fs.writeFileSync(
        file,
        [
          claudeForkRefLine(sharedId),
          claudeUserLine(sharedId, `c${index}`, "subagent", "2026-02-02T10:00:01Z"),
        ].join("\n"),
      );
      return file;
    });

    const db = getDb(dbPath);
    await indexAll(tempDir, false, db);
    for (const child of children) {
      expect(relationshipForRow(db, child)).toEqual({
        session_id: sharedId,
        parent_session_id: sharedId,
        relation_kind: "subagent",
        parent_file_path: parentFile,
      });
    }
  });

  test("a conflicting Claude record cannot redirect a subagent to another root", async () => {
    const pathParentId = "33333333-4444-4555-8666-777777777777";
    const recordParentId = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
    const projectDir = path.join(tempDir, "projects", "fart-project", "claude");
    const childFile = path.join(projectDir, pathParentId, "subagents", "agent-fart.jsonl");
    fs.mkdirSync(path.dirname(childFile), { recursive: true });
    const parentFile = path.join(projectDir, `${pathParentId}.jsonl`);
    fs.writeFileSync(
      parentFile,
      claudeUserLine(pathParentId, "p1", "opener", "2026-02-03T10:00:00Z"),
    );
    fs.writeFileSync(
      path.join(projectDir, `${recordParentId}.jsonl`),
      claudeUserLine(recordParentId, "p2", "other root", "2026-02-03T10:00:00Z"),
    );
    fs.writeFileSync(
      childFile,
      claudeUserLine(pathParentId, "c1", "subagent", "2026-02-03T10:00:01Z"),
    );

    const db = getDb(dbPath);
    await indexAll(tempDir, false, db);
    expect(relationshipForRow(db, childFile)?.parent_file_path).toBe(parentFile);

    const previousMtime = fs.statSync(childFile).mtimeMs;
    fs.writeFileSync(
      childFile,
      [
        claudeForkRefLine(recordParentId),
        claudeUserLine(pathParentId, "c1", "subagent", "2026-02-03T10:00:01Z"),
      ].join("\n"),
    );
    fs.utimesSync(childFile, new Date(previousMtime + 1000), new Date(previousMtime + 1000));
    await indexAll(tempDir, false, db);
    expect(relationshipForRow(db, childFile)).toEqual({
      session_id: pathParentId,
      parent_session_id: recordParentId,
      relation_kind: "subagent",
      parent_file_path: null,
    });

    await indexAll(tempDir, true, db);
    expect(relationshipForRow(db, childFile)?.parent_file_path).toBeNull();
    expect(relationshipForRow(db, childFile)?.parent_session_id).toBe(recordParentId);
  });

  test("an ambiguous native parent ID stays unresolved on incremental and rebuild runs", async () => {
    const parentId = "ses_shared_parent";
    const projectDir = path.join(tempDir, "projects", "fart-project", "pi");
    fs.mkdirSync(projectDir, { recursive: true });
    const firstParent = path.join(projectDir, "first.jsonl");
    const secondParent = path.join(projectDir, "second.jsonl");
    const childFile = path.join(projectDir, "child.jsonl");
    fs.writeFileSync(firstParent, [piHeader(parentId), piUser("p1")].join("\n"));
    fs.writeFileSync(childFile, [piHeader("ses_child", parentId), piUser("c1")].join("\n"));
    const db = getDb(dbPath);
    await indexAll(tempDir, false, db);
    expect(relationshipForRow(db, childFile)?.parent_file_path).toBe(firstParent);

    fs.writeFileSync(secondParent, [piHeader(parentId), piUser("p2")].join("\n"));
    await indexAll(tempDir, false, db);
    expect(relationshipForRow(db, childFile)?.parent_file_path).toBeNull();
    expect(relationshipForRow(db, childFile)?.parent_session_id).toBe(parentId);
    await indexAll(tempDir, true, db);
    expect(relationshipForRow(db, childFile)?.parent_file_path).toBeNull();
  });

  test("clears a resolved parent link when its archive disappears", async () => {
    const parentId = "ses_removed_parent";
    const projectDir = path.join(tempDir, "projects", "fart-project", "pi");
    fs.mkdirSync(projectDir, { recursive: true });
    const parentFile = path.join(projectDir, "parent.jsonl");
    const childFile = path.join(projectDir, "child.jsonl");
    fs.writeFileSync(parentFile, [piHeader(parentId), piUser("p1")].join("\n"));
    fs.writeFileSync(childFile, [piHeader("ses_child", parentId), piUser("c1")].join("\n"));
    const db = getDb(dbPath);
    await indexAll(tempDir, false, db);
    expect(relationshipForRow(db, childFile)?.parent_file_path).toBe(parentFile);

    fs.rmSync(parentFile);
    await indexAll(tempDir, false, db);
    expect(relationshipForRow(db, childFile)?.parent_session_id).toBe(parentId);
    expect(relationshipForRow(db, childFile)?.parent_file_path).toBeNull();
  });

  test("leaves cyclic Pi parent pointers unresolved", async () => {
    const projectDir = path.join(tempDir, "projects", "fart-project", "pi");
    fs.mkdirSync(projectDir, { recursive: true });
    const first = path.join(projectDir, "first.jsonl");
    const second = path.join(projectDir, "second.jsonl");
    fs.writeFileSync(first, [piHeader("ses_first", "ses_second"), piUser("u1")].join("\n"));
    fs.writeFileSync(second, [piHeader("ses_second", "ses_first"), piUser("u2")].join("\n"));
    const db = getDb(dbPath);
    await indexAll(tempDir, false, db);
    expect(relationshipForRow(db, first)?.parent_session_id).toBe("ses_second");
    expect(relationshipForRow(db, second)?.parent_session_id).toBe("ses_first");
    expect(relationshipForRow(db, first)?.parent_file_path).toBeNull();
    expect(relationshipForRow(db, second)?.parent_file_path).toBeNull();
  });

  test("resolves a Pi subagent across worktree project slugs through its archived parent name", async () => {
    const parentId = "cccccccc-4444-4555-8666-777777777777";
    const childId = "dddddddd-4444-4555-8666-777777777777";
    const group = `2026-02-04T00-00-00-000Z_${parentId}`;
    const run = "12345678-1234-4234-8234-123456789abc";
    const parentDir = path.join(tempDir, "projects", "fart-project", "pi");
    const childDir = path.join(tempDir, "projects", "fart-project-worktrees-review", "pi");
    fs.mkdirSync(parentDir, { recursive: true });
    fs.mkdirSync(childDir, { recursive: true });
    const parentFile = path.join(parentDir, `${group}.jsonl`);
    const childFile = path.join(childDir, `${group}__${run}__run-0.jsonl`);
    const rawParent = `/home/user/.pi/agent/sessions/--fart-project--/${group}.jsonl`;
    fs.writeFileSync(parentFile, [piHeader(parentId), piUser("parent-user")].join("\n"));
    fs.writeFileSync(childFile, [piHeader(childId, rawParent), piUser("child-user")].join("\n"));
    const db = getDb(dbPath);
    await indexAll(tempDir, false, db);
    expect(relationshipForRow(db, childFile)).toEqual({
      session_id: childId,
      parent_session_id: rawParent,
      relation_kind: "subagent",
      parent_file_path: parentFile,
    });
  });

  test("does not resolve a Pi parent when its header conflicts with its archive filename", async () => {
    const archivedId = "11111111-2222-4333-8444-555555555555";
    const headerId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const projectDir = path.join(tempDir, "projects", "fart-project", "pi");
    fs.mkdirSync(projectDir, { recursive: true });
    const archivedGroup = `2026-02-04T00-00-00-000Z_${archivedId}`;
    const headerGroup = `2026-02-04T00-00-00-000Z_${headerId}`;
    const archivedParent = path.join(projectDir, `${archivedGroup}.jsonl`);
    const headerParent = path.join(projectDir, `${headerGroup}.jsonl`);
    const childFile = path.join(projectDir, `${archivedGroup}__worker__run-0.jsonl`);
    fs.writeFileSync(archivedParent, [piHeader(archivedId), piUser("p1")].join("\n"));
    fs.writeFileSync(headerParent, [piHeader(headerId), piUser("p2")].join("\n"));
    const rawParent = `/sessions/${headerGroup}.jsonl`;
    fs.writeFileSync(childFile, [piHeader("ses_child", rawParent), piUser("c1")].join("\n"));

    const db = getDb(dbPath);
    await indexAll(tempDir, false, db);
    expect(relationshipForRow(db, childFile)).toEqual({
      session_id: "ses_child",
      parent_session_id: rawParent,
      relation_kind: null,
      parent_file_path: null,
    });
    await indexAll(tempDir, true, db);
    expect(relationshipForRow(db, childFile)?.parent_file_path).toBeNull();
  });

  test("does not resolve duplicate Pi parents across projects", async () => {
    const parentId = "44444444-5555-4666-8777-888888888888";
    const childId = "cccccccc-dddd-4eee-8fff-000000000000";
    const group = `2026-02-04T00-00-00-000Z_${parentId}`;
    const run = "12345678-1234-4234-8234-123456789abc";
    const writeParent = (project: string) => {
      const projectDir = path.join(tempDir, "projects", project, "pi");
      fs.mkdirSync(projectDir, { recursive: true });
      const parentFile = path.join(projectDir, `${group}.jsonl`);
      fs.writeFileSync(parentFile, [piHeader(parentId), piUser("parent-user")].join("\n"));
      return parentFile;
    };
    // Both projects hold a parent session with the same id and archive name.
    const accidentalParent = writeParent("fart-one");
    const realParent = writeParent("fart-two");
    const childFile = path.join(
      path.join(tempDir, "projects", "fart-two", "pi"),
      `${group}__${run}__run-0.jsonl`,
    );
    fs.writeFileSync(childFile, [piHeader(childId), piUser("child-user")].join("\n"));

    const db = getDb(dbPath);
    await indexAll(tempDir, false, db);

    // The two source files have the same basename and ID. A project slug is
    // not parent evidence: the child could have run in another worktree.
    expect(relationshipForRow(db, childFile)).toEqual({
      session_id: childId,
      parent_session_id: parentId,
      relation_kind: "subagent",
      parent_file_path: null,
    });
    expect(relationshipForRow(db, realParent)?.parent_file_path).toBeNull();
    expect(relationshipForRow(db, accidentalParent)?.parent_file_path).toBeNull();
  });

  test("does not resolve a parent that only exists in another source", async () => {
    const parentId = "55555555-6666-4777-8888-999999999999";
    const childId = "dddddddd-eeee-4fff-8000-111111111111";
    const claudeDir = path.join(tempDir, "projects", "fart-project", "claude");
    const piDir = path.join(tempDir, "projects", "fart-project", "pi");
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.mkdirSync(piDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, "parent.jsonl"),
      claudeUserLine(parentId, "p1", "fart opener", "2026-02-05T10:00:00.000Z"),
    );
    const childFile = path.join(
      piDir,
      `2026-02-05T00-00-00-000Z_${parentId}__fart-worker__run-0.jsonl`,
    );
    fs.writeFileSync(childFile, [piHeader(childId), piUser("child-user")].join("\n"));

    const db = getDb(dbPath);
    await indexAll(tempDir, false, db);

    expect(relationshipForRow(db, childFile)).toEqual({
      session_id: childId,
      parent_session_id: parentId,
      relation_kind: "subagent",
      parent_file_path: null,
    });
  });

  test("keeps session relationships as nullable raw pointers over a non-unique session id", () => {
    const db = getDb(dbPath);
    const columns = db
      .query<{ name: string; notnull: number }, []>("PRAGMA table_info(sessions)")
      .all()
      .flatMap((column) =>
        ["parent_session_id", "relation_kind", "parent_file_path"].includes(column.name)
          ? [{ name: column.name, notnull: column.notnull }]
          : [],
      );
    expect(columns).toEqual([
      { name: "parent_session_id", notnull: 0 },
      { name: "relation_kind", notnull: 0 },
      { name: "parent_file_path", notnull: 0 },
    ]);

    // file_path stays the only unique key: a child shares its parent's session id.
    const uniqueIndexes = db
      .query<{ unique: number; origin: string }, []>("PRAGMA index_list(sessions)")
      .all()
      .flatMap((index) => (index.unique === 1 ? [{ origin: index.origin }] : []));
    expect(uniqueIndexes).toEqual([{ origin: "pk" }]);
  });
});
