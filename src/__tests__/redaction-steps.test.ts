import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ParseResult } from "../parsers/types.ts";
import { applyRedactionSteps, type RedactionStep } from "../redaction-steps.ts";
import { isTruffleHogAvailable } from "../trufflehog.ts";
import { fartWebhook } from "./fixtures/fart-webhook.ts";

const HOOK_FIXTURE = `${import.meta.dir}/fixtures/hooks/redact-fart.ts`;

const SESSION: ParseResult = {
  meta: { id: "session-1", source: "claude", project: "fart-project", title: "fart session" },
  messages: [
    {
      id: "msg-1",
      sessionId: "session-1",
      timestamp: "2026-01-01T00:00:00.000Z",
      role: "assistant",
      content: [
        {
          type: "text",
          text: `token fart-token-topsecret-123, plain fart-plain, webhook ${fartWebhook()}`,
        },
      ],
    },
  ],
  prLinks: [],
  artifactLinks: [],
};

const SESSION_INFO = {
  filePath: "/archive/projects/fart-project/claude/session-1.jsonl",
  source: "claude" as const,
  project: "fart-project",
};

async function run(steps: readonly RedactionStep[], result: ParseResult = SESSION) {
  const warnings: string[] = [];
  const outcome = await applyRedactionSteps(result, steps, SESSION_INFO, (message) =>
    warnings.push(message),
  );
  return { ...outcome, warnings };
}

const hook = (command: string, timeoutMs?: number): RedactionStep => ({
  kind: "redact",
  name: "test-hook",
  command,
  timeoutMs,
});

const firstText = (result: ParseResult) => {
  const block = result.messages[0]?.content[0];
  if (block?.type !== "text") {
    throw new Error("expected a text block");
  }
  return block.text;
};

const trufflehog = (mode: "warn" | "redact"): RedactionStep => ({
  kind: "trufflehog",
  mode,
});

describe("redaction steps", () => {
  test("redact step pipes the session JSON through the command", async () => {
    const { result, warnings } = await run([hook(`bun ${HOOK_FIXTURE}`)]);

    expect(warnings).toEqual([]);
    expect(firstText(result)).toBe(
      "token [REDACTED:custom-hook], plain fart-plain, webhook [REDACTED:webhook]",
    );
  });

  test.skipIf(!isTruffleHogAvailable())(
    "steps run in order: a redact step can suppress what a later scan finds",
    async () => {
      // The scan runs after the hook, so the hook's output is what gets scanned.
      const { warnings } = await run([hook(`bun ${HOOK_FIXTURE}`), trufflehog("warn")]);
      expect(warnings.filter((message) => message.startsWith("trufflehog"))).toEqual([]);
    },
  );

  test.skipIf(!isTruffleHogAvailable())(
    "a scan before the hook still flags what the hook would have redacted",
    async () => {
      const { warnings } = await run([trufflehog("warn"), hook(`bun ${HOOK_FIXTURE}`)]);
      expect(warnings.filter((message) => message.startsWith("trufflehog")).length).toBeGreaterThan(
        0,
      );
    },
  );

  test.skipIf(!isTruffleHogAvailable())(
    "redact mode scrubs the finding out of the indexed text",
    async () => {
      const { result, warnings } = await run([trufflehog("redact")]);

      expect(firstText(result)).not.toContain("hooks.slack.com");
      expect(firstText(result)).toContain("[REDACTED:slackwebhook]");
      // Still contains everything else — redaction, not deletion.
      expect(firstText(result)).toContain("fart-plain");
      expect(
        warnings.filter((message) => message.includes("(redacted from the index)")).length,
      ).toBeGreaterThan(0);
    },
  );

  test.skipIf(!isTruffleHogAvailable())(
    "a scan after a redact step finds nothing: the redaction is self-verifying",
    async () => {
      const { warnings } = await run([trufflehog("redact"), trufflehog("warn")]);
      // The redact step's own "(redacted from the index)" warnings don't count;
      // what must be empty is the plain-scan output of the second step.
      expect(
        warnings.filter(
          (message) =>
            message.startsWith("trufflehog") && !message.includes("(redacted from the index)"),
        ),
      ).toEqual([]);
    },
  );

  test.skipIf(!isTruffleHogAvailable())(
    "a failed redact step warns and keeps the previous result; the scan still runs",
    async () => {
      const { result, warnings, trufflehogScanned } = await run([
        hook("exit 3"),
        trufflehog("warn"),
      ]);

      expect(warnings[0]).toContain('redaction hook "test-hook" failed');
      expect(firstText(result)).toContain("fart-token-topsecret-123");
      // The hook failure must not stop the pipeline: the scan ran and said so.
      expect(trufflehogScanned).toBe(true);
      expect(warnings.some((message) => message.startsWith("trufflehog"))).toBe(true);
    },
  );

  test("chained redact steps, any stdin/stdout program works", async () => {
    const { result, warnings } = await run([
      hook(`bun ${HOOK_FIXTURE}`),
      { kind: "redact", name: "sed", command: "sed s/fart-plain/fart-cleaned/" },
    ]);

    expect(warnings).toEqual([]);
    expect(firstText(result)).toBe(
      "token [REDACTED:custom-hook], plain fart-cleaned, webhook [REDACTED:webhook]",
    );
  });

  test("warns and keeps the previous result when a hook exits non-zero", async () => {
    const { result, warnings } = await run([hook("exit 3")]);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('redaction hook "test-hook" failed');
    expect(warnings[0]).toContain("exit 3");
    expect(result).toEqual(SESSION);
  });

  test("warns and keeps the previous result when stdout is not JSON", async () => {
    const { result, warnings } = await run([hook("echo not-json")]);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("was not valid JSON");
    expect(result).toEqual(SESSION);
  });

  test("warns and keeps the previous result when stdout is the wrong shape", async () => {
    const { result, warnings } = await run([hook(`echo '{"meta": 1}'`)]);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("was not a session result");
    expect(result).toEqual(SESSION);
  });

  test("warns and keeps the previous result when near-valid output is not indexable", async () => {
    // Right shape, fields the DB would reject: a bogus source or
    // relationKind trips a CHECK constraint, a worktree with null required
    // fields a NOT NULL — each would throw inside indexSession and lose the
    // session on every run, without the gate.
    const bogusOutputs: unknown[] = [
      { ...SESSION, meta: { ...SESSION.meta, source: "fart-not-a-source" } },
      { ...SESSION, meta: { ...SESSION.meta, relationKind: "fart-not-a-kind" } },
      {
        ...SESSION,
        meta: { ...SESSION.meta, worktree: { worktreePath: null, worktreeName: "fart-wt" } },
      },
    ];
    for (const bogus of bogusOutputs) {
      const { result, warnings } = await run([hook(`echo '${JSON.stringify(bogus)}'`)]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("was not a session result");
      expect(result).toEqual(SESSION);
    }
  });

  test("warns and keeps the previous result when a content block is missing its text", async () => {
    const gutted = {
      ...SESSION,
      messages: [{ ...SESSION.messages[0], content: [{ type: "text" }] }],
    };
    const { result, warnings } = await run([hook(`echo '${JSON.stringify(gutted)}'`)]);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("was not a session result");
    expect(result).toEqual(SESSION);
  });

  test("warns and keeps the previous result when a hook times out", async () => {
    const { result, warnings } = await run([hook("sleep 5", 100)]);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("timed out after 100ms");
    expect(result).toEqual(SESSION);
  });

  test("a broken scanner is an error, never a clean scan", async () => {
    // Exit failure, signal death, and unparseable output must all surface as
    // scan errors — none may quietly count as a zero-findings scan.
    const brokenScanners: Array<{ script: string; errorContains: string }> = [
      { script: "exit 1", errorContains: "trufflehog exited 1" },
      { script: "kill -9 $$", errorContains: "trufflehog was killed by" },
      { script: "echo not-json", errorContains: "parsed to no findings" },
    ];
    for (const { script, errorContains } of brokenScanners) {
      const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "devlog-thog-stub-"));
      fs.writeFileSync(path.join(stubDir, "trufflehog"), `#!/bin/sh\n${script}\n`, {
        mode: 0o755,
      });
      const originalPath = process.env["PATH"];
      process.env["PATH"] = stubDir;
      try {
        const { result, warnings, trufflehogScanned, trufflehogFindings } = await run([
          trufflehog("warn"),
        ]);

        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain(errorContains);
        // The previous result stands, and a failed scan never counts as clean.
        expect(result).toEqual(SESSION);
        expect(trufflehogScanned).toBe(false);
        expect(trufflehogFindings).toBe(0);
      } finally {
        process.env["PATH"] = originalPath;
        fs.rmSync(stubDir, { recursive: true, force: true });
      }
    }
  });
});
