#!/usr/bin/env bun
// Test fixture: a devlog redact hook. Reads the redacted session JSON from
// stdin, replaces a fart-data secret, and writes the transformed JSON to
// stdout. Also verifies devlog passed the session metadata through env vars.
import { fartWebhook } from "../fart-webhook.ts";

const text = await Bun.stdin.text();

// devlog passes the session metadata through env vars; verify the whole
// contract, not just DEVLOG_PROJECT.
const expectedEnv: Array<[string, string]> = [
  ["DEVLOG_PROJECT", "fart-project"],
  ["DEVLOG_SOURCE", "claude"],
  ["DEVLOG_SESSION_FILE", "/archive/projects/fart-project/claude/session-1.jsonl"],
];
for (const [name, expected] of expectedEnv) {
  if (process.env[name] !== expected) {
    console.error(`expected ${name}=${expected}, got ${process.env[name]}`);
    process.exit(1);
  }
}

const result = JSON.parse(text) as {
  messages: Array<{ content: Array<{ type: string; text?: string }> }>;
};

// Fart-data stand-ins for two classes of secret: one the built-in redaction
// would catch, one (a Slack-webhook shape) only a scanner detects.
const REDACTIONS: Array<[string, string]> = [
  ["fart-token-topsecret-123", "[REDACTED:custom-hook]"],
  [fartWebhook(), "[REDACTED:webhook]"],
];

for (const message of result.messages) {
  for (const block of message.content) {
    if (block.type === "text" && block.text) {
      for (const [secret, replacement] of REDACTIONS) {
        block.text = block.text.replaceAll(secret, replacement);
      }
    }
  }
}

console.log(JSON.stringify(result));
