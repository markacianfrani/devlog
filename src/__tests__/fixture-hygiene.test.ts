import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

// Redaction tests need secret-shaped sample data, and a complete Slack webhook
// in a tracked file is precisely what GitHub push protection refuses to push
// (GH013) — fake or not. So the stand-ins are assembled at test runtime from
// fixtures/fart-webhook.ts. This guard is the cheap way to keep that true: it
// fails locally, before the push, rather than as a remote rejection.
const SLACK_WEBHOOK =
  /hooks\.slack\.com\/services\/[A-Za-z0-9_]{9}\/[A-Za-z0-9_]{9}\/[A-Za-z0-9_]{24}/;

const root = spawnSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).stdout.trim();

describe("fixture hygiene", () => {
  test.skipIf(root === "")("no tracked file contains a complete Slack webhook", () => {
    // Plain substring search, then the shape test: git grep's own regex would
    // have to be written with escapes that read like the pattern itself.
    const hits = spawnSync("git", ["-c", "core.quotePath=false", "grep", "-In", "slack.com"], {
      cwd: root,
      encoding: "utf8",
    });

    const offenders = hits.stdout
      .split("\n")
      .filter((line) => SLACK_WEBHOOK.test(line))
      .map((line) => line.split(":")[0]);

    expect(offenders).toEqual([]);
  });
});
