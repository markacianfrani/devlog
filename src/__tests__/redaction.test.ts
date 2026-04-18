import { describe, expect, test } from "bun:test";
import type {
  ParseResult,
  TextContentBlock,
  ThinkingContentBlock,
  ToolUseContentBlock,
} from "../parsers/types.ts";
import { redactParseResult } from "../redaction.ts";

function withEnv<T>(name: string, value: string | undefined, run: () => T): T {
  const previous = process.env[name];

  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }

  try {
    return run();
  } finally {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  }
}

function makeParseResult(text: string): ParseResult {
  return {
    meta: {
      id: "session-1",
      source: "claude",
      project: "test-project",
      title: text,
    },
    messages: [
      {
        id: "msg-1",
        sessionId: "session-1",
        timestamp: "2026-01-01T00:00:00.000Z",
        role: "assistant",
        content: [
          { type: "text", text },
          { type: "thinking", thinking: `considering ${text}` },
          { type: "tool_use", toolName: "fetch", toolInput: JSON.stringify({ token: text }) },
        ],
      },
    ],
    prLinks: [
      {
        sessionId: "session-1",
        prNumber: 1,
        prUrl: `https://github.com/example/repo/pull/1?trace=${text}`,
        prRepository: "example/repo",
        timestamp: "2026-01-01T00:00:00.000Z",
      },
    ],
  };
}

describe("redaction", () => {
  test("preserves structural identifiers while redacting content fields", () => {
    withEnv("DEVLOG_TEST_SECRET_TOKEN_SCOPE", "session-12345", () => {
      const original = makeParseResult("session-12345");
      original.meta.id = "session-12345";
      original.messages[0].sessionId = "session-12345";
      original.prLinks[0].sessionId = "session-12345";

      const redacted = redactParseResult(original);
      const redactedText = (redacted.messages[0].content[0] as TextContentBlock).text;

      expect(redacted.meta.id).toBe("session-12345");
      expect(redacted.messages[0].sessionId).toBe("session-12345");
      expect(redacted.prLinks[0].sessionId).toBe("session-12345");
      expect(redacted.prLinks[0].prUrl).toContain("[REDACTED:devlog-test-secret-token-scope]");
      expect(redacted.prLinks[0].prUrl).not.toContain("session-12345");

      expect(redacted.meta.title).toBe("[REDACTED:devlog-test-secret-token-scope]");
      expect(redactedText).toBe("[REDACTED:devlog-test-secret-token-scope]");
    });
  });

  test("does not treat unrelated env names as sensitive", () => {
    withEnv("MONKEY", "superlongbanana", () => {
      const original = makeParseResult("superlongbanana");
      const redacted = redactParseResult(original);
      const redactedText = (redacted.messages[0].content[0] as TextContentBlock).text;

      expect(redacted.meta.title).toBe("superlongbanana");
      expect(redactedText).toBe("superlongbanana");
    });
  });

  test("redacts github fine-grained PAT tokens", () => {
    const githubPat =
      "github_pat_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_abc";
    const original = makeParseResult(githubPat);

    const redacted = redactParseResult(original);
    const toolUse = redacted.messages[0].content[2] as ToolUseContentBlock;

    expect(toolUse.toolInput).toContain("[REDACTED:github-token]");
    expect(toolUse.toolInput).not.toContain(githubPat);

    const redactedText = (redacted.messages[0].content[0] as TextContentBlock).text;
    expect(redactedText).toBe("[REDACTED:github-token]");
  });

  test("redacts secrets inside thinking blocks", () => {
    const original = makeParseResult("hf_abcdefghijklmnopqrstuvwxyz12");
    const redacted = redactParseResult(original);
    const thinking = redacted.messages[0].content[1] as ThinkingContentBlock;

    expect(thinking.thinking).toBe("considering [REDACTED:huggingface-token]");
    expect(thinking.thinking).not.toContain("hf_abcdefghijklmnopqrstuvwxyz12");
  });
});
