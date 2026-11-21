import { describe, expect, test } from "bun:test";

import type { ParseResult } from "../parsers/types.ts";
import {
  isTruffleHogAvailable,
  resetTruffleHogAvailabilityCache,
  scanRedactedResult,
} from "../trufflehog.ts";
import { FART_HOOK_TOKEN, fartWebhook } from "./fixtures/fart-webhook.ts";

// Fart-data secret shaped like a real Slack webhook so TruffleHog's detector
// fires. Assembled at runtime, never committed whole: see fixtures/fart-webhook.ts.
const FART_WEBHOOK = fartWebhook();

function makeResult(text: string): ParseResult {
  return {
    meta: { id: "session-1", source: "claude", project: "fart-project", title: "fart session" },
    messages: [
      {
        id: "msg-1",
        sessionId: "session-1",
        timestamp: "2026-01-01T00:00:00.000Z",
        role: "assistant",
        content: [{ type: "text", text }],
      },
    ],
    prLinks: [],
    artifactLinks: [],
  };
}

describe("trufflehog", () => {
  test("scan is off when the binary is unavailable", () => {
    const originalPath = process.env["PATH"];
    delete process.env["PATH"];
    resetTruffleHogAvailabilityCache();
    try {
      expect(isTruffleHogAvailable()).toBe(false);
    } finally {
      process.env["PATH"] = originalPath;
      resetTruffleHogAvailabilityCache();
    }
  });

  test.skipIf(!isTruffleHogAvailable())("flags a fart-data webhook that redaction missed", () => {
    const scan = scanRedactedResult(
      makeResult(`someone pasted this hook into chat: ${FART_WEBHOOK}`),
    );

    expect(scan.error).toBeUndefined();
    expect(scan.findings.length).toBeGreaterThan(0);

    const slack = scan.findings.find((finding) => finding.detector === "SlackWebhook");
    expect(slack).toBeDefined();
    // Masked output must never carry the secret body.
    expect(slack?.masked).not.toContain("FART0");
    expect(slack?.masked).not.toContain(FART_HOOK_TOKEN);
    expect(slack?.masked).toContain("***");
    expect(slack?.rawSha256).toMatch(/^[0-9a-f]{16}$/);
    expect(slack?.line).toBeGreaterThan(0);
  });

  test.skipIf(!isTruffleHogAvailable())("finds nothing in a clean session", () => {
    const scan = scanRedactedResult(
      makeResult("just a regular fart session about fart pipelines, no secrets here"),
    );
    expect(scan.error).toBeUndefined();
    expect(scan.findings).toHaveLength(0);
  });
});
