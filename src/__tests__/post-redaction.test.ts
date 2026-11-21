import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { closeDb, getDb } from "../db.ts";
import { indexAll, indexSession } from "../indexer.ts";
import type { ParseWarning } from "../parsers/types.ts";
import type { RedactionStep } from "../redaction-steps.ts";
import { isTruffleHogAvailable, resetTruffleHogAvailabilityCache } from "../trufflehog.ts";
import { FART_HOOK_TOKEN, fartWebhook } from "./fixtures/fart-webhook.ts";

// The committed fixture carries a __FART_WEBHOOK__ placeholder instead of the
// fart webhook itself: a complete Slack-webhook-shaped URL in a tracked file is
// what GitHub push protection blocks, so the body is filled in at write time.
const FIXTURE_TEMPLATE = path.join(import.meta.dir, "fixtures", "claude-post-redaction.jsonl");

function writeFixture(dest: string): string {
  const body = fs
    .readFileSync(FIXTURE_TEMPLATE, "utf8")
    .replaceAll("__FART_WEBHOOK__", fartWebhook());
  fs.writeFileSync(dest, body);
  return dest;
}

// Same shape as FIXTURE_TEMPLATE, no secrets: the clean-scan case.
const CLEAN_LINE = JSON.stringify({
  type: "user",
  sessionId: "post-redaction-clean",
  uuid: "msg-user-clean",
  parentUuid: null,
  timestamp: "2026-01-01T00:00:00.000Z",
  cwd: "/home/user/project",
  message: { role: "user", content: "just a fart session about fart pipelines" },
});

const sessionCount = (db: ReturnType<typeof getDb>) =>
  db.query<{ n: number }, []>("SELECT COUNT(*) as n FROM sessions").get()?.n ?? 0;

describe("redaction steps integration", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "devlog-post-redaction-test-"));
    dbPath = path.join(tempDir, "index.db");
    resetTruffleHogAvailabilityCache();
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tempDir, { recursive: true, force: true });
    resetTruffleHogAvailabilityCache();
  });

  async function indexFixture(
    db: ReturnType<typeof getDb>,
    redactionSteps: readonly RedactionStep[],
    filePath = writeFixture(path.join(tempDir, "post-redaction.jsonl")),
  ) {
    const warnings: ParseWarning[] = [];
    const outcome = await indexSession(filePath, "claude", "fart-project", db, {
      onWarning: (warning) => warnings.push(warning),
      redactionSteps,
    });
    return { outcome, warnings };
  }

  test.skipIf(!isTruffleHogAvailable())(
    "warn mode indexes the session and prints masked findings",
    async () => {
      const db = getDb(dbPath);
      const { outcome, warnings } = await indexFixture(db, [{ kind: "trufflehog", mode: "warn" }]);

      expect(outcome.indexed).toBe(true);
      const trufflehogWarnings = warnings.filter(
        (warning) => warning.kind === "post-redaction" && warning.message.startsWith("trufflehog"),
      );
      expect(trufflehogWarnings.length).toBeGreaterThan(0);
      // The warning must not carry the secret body.
      expect(JSON.stringify(trufflehogWarnings)).not.toContain(FART_HOOK_TOKEN);

      // The scan is reported even though it found something.
      expect(outcome.trufflehogScanned).toBe(true);
      expect(outcome.trufflehogFindings).toBeGreaterThan(0);

      // warn prints but does not scrub: only "redact" mode removes the
      // finding from the indexed text.
      const warnBlocks = db
        .query<{ text: string | null }, []>("SELECT text FROM content_blocks WHERE type = 'text'")
        .all();
      const warnIndexed = JSON.stringify(warnBlocks);
      expect(warnIndexed).toContain(FART_HOOK_TOKEN);
      expect(warnIndexed).not.toContain("[REDACTED:");
    },
  );

  test.skipIf(!isTruffleHogAvailable())(
    "a clean scan reports zero findings rather than staying silent",
    async () => {
      const db = getDb(dbPath);
      const cleanPath = path.join(tempDir, "clean.jsonl");
      fs.writeFileSync(cleanPath, `${CLEAN_LINE}\n`);
      const { outcome, warnings } = await indexFixture(
        db,
        [{ kind: "trufflehog", mode: "warn" }],
        cleanPath,
      );

      expect(outcome.indexed).toBe(true);
      expect(outcome.trufflehogScanned).toBe(true);
      expect(outcome.trufflehogFindings).toBe(0);
      expect(warnings.filter((w) => w.kind === "post-redaction")).toEqual([]);
    },
  );

  test.skipIf(!isTruffleHogAvailable())(
    "redact mode indexes the session with findings scrubbed from the database",
    async () => {
      const db = getDb(dbPath);
      const { outcome } = await indexFixture(db, [{ kind: "trufflehog", mode: "redact" }]);

      expect(outcome.indexed).toBe(true);
      const blocks = db
        .query<{ text: string | null }, []>("SELECT text FROM content_blocks WHERE type = 'text'")
        .all();
      const indexed = JSON.stringify(blocks);
      expect(indexed).not.toContain(FART_HOOK_TOKEN);
      expect(indexed).toContain("[REDACTED:slackwebhook]");
    },
  );

  test("no steps reports nothing scanned", async () => {
    const db = getDb(dbPath);
    const { outcome } = await indexFixture(db, []);

    expect(outcome.indexed).toBe(true);
    expect(outcome.trufflehogScanned).toBe(false);
    expect(outcome.trufflehogFindings).toBe(0);
  });

  test("a hook that empties messages warns instead of silently skipping", async () => {
    const db = getDb(dbPath);
    const empty = JSON.stringify({
      meta: { id: "post-redaction-1", source: "claude", project: "fart-project" },
      messages: [],
      prLinks: [],
      artifactLinks: [],
    });
    const { outcome, warnings } = await indexFixture(db, [
      { kind: "redact", name: "empty-hook", command: `echo '${empty}'` },
    ]);

    expect(outcome.indexed).toBe(false);
    expect(sessionCount(db)).toBe(0);
    expect(warnings.some((w) => w.message.includes("left no messages"))).toBe(true);
  });

  test("steps that empty a previously indexed session drop its stale rows", async () => {
    const db = getDb(dbPath);
    const sessionPath = path.join(tempDir, "session.jsonl");
    writeFixture(sessionPath);

    // First run: the session indexes normally.
    const first = await indexFixture(db, [], sessionPath);
    expect(first.outcome.indexed).toBe(true);
    expect(sessionCount(db)).toBe(1);

    // Same file, newer mtime, an emptying hook: the stale rows must go, or
    // MCP keeps serving the pre-redaction content behind the warning.
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(sessionPath, later, later);
    const empty = JSON.stringify({
      meta: { id: "post-redaction-1", source: "claude", project: "fart-project" },
      messages: [],
      prLinks: [],
      artifactLinks: [],
    });
    const { outcome, warnings } = await indexFixture(
      db,
      [{ kind: "redact", name: "empty-hook", command: `echo '${empty}'` }],
      sessionPath,
    );

    expect(outcome.indexed).toBe(false);
    expect(sessionCount(db)).toBe(0);
    const blocks =
      db.query<{ n: number }, []>("SELECT COUNT(*) as n FROM content_blocks").get()?.n ?? 0;
    expect(blocks).toBe(0);
    expect(warnings.some((w) => w.message.includes("left no messages"))).toBe(true);
  });

  test("warn mode with no binary: one availability warning, session still indexed", async () => {
    const originalPath = process.env["PATH"];
    const projectDir = path.join(tempDir, "projects", "fart-project", "claude");
    fs.mkdirSync(projectDir, { recursive: true });
    writeFixture(path.join(projectDir, "session.jsonl"));

    const db = getDb(path.join(tempDir, "index.db"));
    delete process.env["PATH"];
    const warnings: ParseWarning[] = [];

    try {
      const stats = await indexAll(tempDir, false, db, {
        redactionSteps: [{ kind: "trufflehog", mode: "warn" }],
        callbacks: {
          onWarning: (warning) => warnings.push(warning),
        },
      });

      expect(stats.errors).toBe(0);
      expect(stats.sessionsIndexed).toBe(1);
      expect(stats.warnings).toBe(1);
      expect(warnings[0]?.message).toContain("trufflehog binary was not found");
      expect(sessionCount(db)).toBe(1);
    } finally {
      process.env["PATH"] = originalPath;
      resetTruffleHogAvailabilityCache();
    }
  });
});
