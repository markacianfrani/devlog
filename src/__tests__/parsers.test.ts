import { describe, expect, test } from "bun:test";
import path from "node:path";
import { parseClaudeSession } from "../parsers/claude.ts";
import { parseOpenCodeSession } from "../parsers/opencode.ts";
import { parsePiSession } from "../parsers/pi.ts";
import { parseContentBlock } from "../parsers/shared.ts";
import { redactParseResult } from "../redaction.ts";
import type {
  ParseResult,
  TextContentBlock,
  ThinkingContentBlock,
  ToolResultContentBlock,
  ToolUseContentBlock,
} from "../parsers/types.ts";

const FIXTURES_DIR = path.join(import.meta.dir, "fixtures");

async function withEnv<T>(
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

function expectParsed(result: ParseResult | undefined): ParseResult {
  expect(result).toBeDefined();
  if (!result) {
    throw new Error("Expected parser to return a result");
  }
  return result;
}

describe("Claude parser", () => {
  test("parses simple user/assistant exchange", async () => {
    const result = expectParsed(
      await parseClaudeSession(path.join(FIXTURES_DIR, "claude-simple.jsonl"), "test-project"),
    );

    expect(result.meta.id).toBe("test-session-1");
    expect(result.meta.source).toBe("claude");
    expect(result.meta.project).toBe("test-project");
    expect(result.meta.cwd).toBe("/home/user/project");

    expect(result.messages).toHaveLength(2);

    const userMsg = result.messages[0];
    expect(userMsg.id).toBe("msg-user-1");
    expect(userMsg.role).toBe("user");
    expect(userMsg.content).toHaveLength(1);
    expect(userMsg.content[0].type).toBe("text");
    expect((userMsg.content[0] as TextContentBlock).text).toBe("Hello, how are you?");

    const asstMsg = result.messages[1];
    expect(asstMsg.id).toBe("msg-asst-1");
    expect(asstMsg.role).toBe("assistant");
    expect(asstMsg.parentId).toBe("msg-user-1");
    expect(asstMsg.model).toBe("claude-opus-4-5-20251101");
    expect(asstMsg.tokensIn).toBe(100);
    expect(asstMsg.tokensOut).toBe(50);
    expect(asstMsg.cacheReadTokens).toBe(20);
    expect(asstMsg.cacheWriteTokens).toBe(15);
    expect((asstMsg.content[0] as TextContentBlock).text).toBe(
      "I'm doing well, thank you for asking!",
    );
  });

  test("parses tool use and tool results", async () => {
    const result = expectParsed(
      await parseClaudeSession(path.join(FIXTURES_DIR, "claude-with-tools.jsonl"), "test-project"),
    );

    expect(result.messages).toHaveLength(4);

    const toolUseMsg = result.messages[1];
    expect(toolUseMsg.content).toHaveLength(1);
    expect(toolUseMsg.content[0].type).toBe("tool_use");
    expect((toolUseMsg.content[0] as ToolUseContentBlock).toolName).toBe("Read");
    expect((toolUseMsg.content[0] as ToolUseContentBlock).toolInput).toContain("package.json");
    expect((toolUseMsg.content[0] as ToolUseContentBlock).toolUseId).toBe("tool-1");

    const toolResultMsg = result.messages[2];
    expect(toolResultMsg.role).toBe("user");
    expect(toolResultMsg.content).toHaveLength(1);
    expect(toolResultMsg.content[0].type).toBe("tool_result");
    expect((toolResultMsg.content[0] as ToolResultContentBlock).toolOutput).toContain("my-project");
    expect((toolResultMsg.content[0] as ToolResultContentBlock).toolUseId).toBe("tool-1");
  });

  test("keeps parsing separate from redaction transform", async () => {
    await withEnv("DEVLOG_TEST_SECRET_TOKEN_PARSE", "literal-secret-token-12345", async () => {
      const parsed = expectParsed(
        await parseClaudeSession(path.join(FIXTURES_DIR, "claude-redaction.jsonl"), "test-project"),
      );

      const parsedUserText = (parsed.messages[0].content[0] as TextContentBlock).text;
      expect(parsedUserText).toContain("sk-proj-123456789012345678901234");
      expect(parsedUserText).toContain("literal-secret-token-12345");

      const redacted = redactParseResult(parsed);

      const firstUserText = (redacted.messages[0].content[0] as TextContentBlock).text;
      expect(firstUserText).toContain("[REDACTED:openai-project-key]");
      expect(firstUserText).toContain("[REDACTED:devlog-test-secret-token-parse]");
      expect(firstUserText).not.toContain("sk-proj-123456789012345678901234");
      expect(firstUserText).not.toContain("literal-secret-token-12345");

      const toolUse = redacted.messages[1].content[0] as ToolUseContentBlock;
      expect(toolUse.toolInput).toContain("Bearer [REDACTED]");
      expect(toolUse.toolInput).toContain("[REDACTED:github-token]");
      expect(toolUse.toolInput).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz123456");

      const toolResult = redacted.messages[2].content[0] as ToolResultContentBlock;
      expect(toolResult.toolOutput).toContain("[REDACTED:jwt]");
      expect(toolResult.toolOutput).toContain("[REDACTED:huggingface-token]");
      expect(toolResult.toolOutput).not.toContain("hf_abcdefghijklmnopqrstuvwxyz12");

      expect(redacted.prLinks[0]?.prUrl).toContain("[REDACTED:devlog-test-secret-token-parse]");
      expect(redacted.prLinks[0]?.prUrl).not.toContain("literal-secret-token-12345");
    });
  });

  test("extracts agentId for agent sessions", async () => {
    const result = expectParsed(
      await parseClaudeSession(path.join(FIXTURES_DIR, "claude-agent.jsonl"), "test-project"),
    );

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].agentId).toBe("agent-123");
    expect(result.messages[1].agentId).toBe("agent-123");
  });

  test("filters out noise records and preserves thinking blocks", async () => {
    const result = expectParsed(
      await parseClaudeSession(path.join(FIXTURES_DIR, "claude-noise.jsonl"), "test-project"),
    );

    expect(result.messages).toHaveLength(2);

    const userMsg = result.messages[0];
    expect((userMsg.content[0] as TextContentBlock).text).toBe("Real user message");

    const asstMsg = result.messages[1];
    expect(asstMsg.content).toHaveLength(2);
    expect(asstMsg.content[0].type).toBe("thinking");
    expect((asstMsg.content[0] as ThinkingContentBlock).thinking).toBe(
      "Let me think about this...",
    );
    expect(asstMsg.content[1].type).toBe("text");
    expect((asstMsg.content[1] as TextContentBlock).text).toBe("Here is my response.");
  });

  test("preserves thinking blocks and token data from thinking-only assistant messages", async () => {
    const result = expectParsed(
      await parseClaudeSession(
        path.join(FIXTURES_DIR, "claude-thinking-only.jsonl"),
        "test-project",
      ),
    );

    expect(result.messages).toHaveLength(2);

    const asstMsg = result.messages[1];
    expect(asstMsg.role).toBe("assistant");
    expect(asstMsg.content).toHaveLength(1);
    expect(asstMsg.content[0].type).toBe("thinking");
    expect((asstMsg.content[0] as ThinkingContentBlock).thinking).toBe(
      "Let me reason through this carefully...",
    );
    expect(asstMsg.tokensIn).toBe(500);
    expect(asstMsg.tokensOut).toBe(200);
    expect(asstMsg.cacheReadTokens).toBe(10000);
  });

  test("extracts pr-link records", async () => {
    const result = expectParsed(
      await parseClaudeSession(path.join(FIXTURES_DIR, "claude-noise.jsonl"), "test-project"),
    );

    expect(result.prLinks).toHaveLength(1);
    expect(result.prLinks[0]).toEqual({
      sessionId: "test-session-4",
      prNumber: 109,
      prUrl: "https://github.com/example-org/web-app/pull/109",
      prRepository: "example-org/web-app",
      timestamp: "2026-01-20T10:00:02.000Z",
    });
  });

  test("extracts session title from summary record", async () => {
    const result = expectParsed(
      await parseClaudeSession(path.join(FIXTURES_DIR, "claude-noise.jsonl"), "test-project"),
    );

    expect(result.meta.title).toBe("Test session summary");
  });

  test("extracts session title from custom-title record", async () => {
    const result = expectParsed(
      await parseClaudeSession(
        path.join(FIXTURES_DIR, "claude-custom-title.jsonl"),
        "test-project",
      ),
    );

    expect(result.meta.title).toBe("My custom session title");
    expect(result.messages).toHaveLength(2);
  });

  test("returns empty prLinks when none present", async () => {
    const result = expectParsed(
      await parseClaudeSession(path.join(FIXTURES_DIR, "claude-simple.jsonl"), "test-project"),
    );

    expect(result.prLinks).toEqual([]);
  });

  test("populates parentSessionId from subagent archive path", async () => {
    const parentUuid = "a1b2c3d4-5678-4abc-9def-0123456789ab";
    const subagentPath = path.join(
      FIXTURES_DIR,
      "..",
      "synthetic-archive",
      "claude",
      parentUuid,
      "subagents",
      "agent-abc.jsonl",
    );

    const fs = await import("node:fs");
    fs.mkdirSync(path.dirname(subagentPath), { recursive: true });
    fs.copyFileSync(path.join(FIXTURES_DIR, "claude-agent.jsonl"), subagentPath);

    try {
      const result = expectParsed(await parseClaudeSession(subagentPath, "test-project"));
      expect(result.meta.parentSessionId).toBe(parentUuid);
    } finally {
      fs.rmSync(path.join(FIXTURES_DIR, "..", "synthetic-archive"), {
        recursive: true,
        force: true,
      });
    }
  });

  test("does not set parentSessionId for non-subagent sessions", async () => {
    const result = expectParsed(
      await parseClaudeSession(path.join(FIXTURES_DIR, "claude-simple.jsonl"), "test-project"),
    );
    expect(result.meta.parentSessionId).toBeUndefined();
  });

  test("preserves redacted thinking blocks (empty thinking string)", async () => {
    const result = expectParsed(
      await parseClaudeSession(
        path.join(FIXTURES_DIR, "claude-redacted-thinking.jsonl"),
        "test-project",
      ),
    );

    expect(result.messages).toHaveLength(3);
    const firstAsst = result.messages[1];
    expect(firstAsst.content).toHaveLength(2);
    expect(firstAsst.content[0].type).toBe("redacted_thinking");
    expect(firstAsst.content[1].type).toBe("text");

    const secondAsst = result.messages[2];
    expect(secondAsst.content[0].type).toBe("redacted_thinking");
    expect(secondAsst.content[1].type).toBe("text");
  });

  test("preserves document content blocks with mediaType", async () => {
    const result = expectParsed(
      await parseClaudeSession(path.join(FIXTURES_DIR, "claude-document.jsonl"), "test-project"),
    );

    const userMsg = result.messages[0];
    expect(userMsg.content).toHaveLength(2);
    expect(userMsg.content[0].type).toBe("text");
    expect(userMsg.content[1].type).toBe("document");
    const doc = userMsg.content[1] as { type: "document"; mediaType?: string };
    expect(doc.mediaType).toBe("application/pdf");
  });

  test("deduplicates messages with the same uuid, keeping the last", async () => {
    const result = expectParsed(
      await parseClaudeSession(
        path.join(FIXTURES_DIR, "claude-duplicate-uuids.jsonl"),
        "test-project",
      ),
    );

    expect(result.messages).toHaveLength(3);

    const asstMsg = result.messages[1];
    expect(asstMsg.id).toBe("msg-asst-1");
    expect((asstMsg.content[0] as TextContentBlock).text).toBe("Full response with more detail.");
    expect(asstMsg.tokensOut).toBe(20);
  });
});

describe("OpenCode parser", () => {
  test("parses simple session", async () => {
    const result = expectParsed(
      await parseOpenCodeSession(path.join(FIXTURES_DIR, "opencode-simple.jsonl"), "test-project"),
    );

    expect(result.meta.id).toBe("ses_test123");
    expect(result.meta.source).toBe("opencode");
    expect(result.meta.project).toBe("test-project");

    expect(result.messages).toHaveLength(3);

    const userMsg = result.messages[0];
    expect(userMsg.role).toBe("user");
    expect((userMsg.content[0] as TextContentBlock).text).toBe("Hello");

    const asstMsg = result.messages[1];
    expect(asstMsg.role).toBe("assistant");
    expect(asstMsg.tokensIn).toBe(100);
    expect(asstMsg.tokensOut).toBe(50);
  });

  test("parses tool use with inline results", async () => {
    const result = expectParsed(
      await parseOpenCodeSession(path.join(FIXTURES_DIR, "opencode-simple.jsonl"), "test-project"),
    );

    const toolMsg = result.messages[2];
    expect(toolMsg.content).toHaveLength(2);
    expect(toolMsg.content[0].type).toBe("tool_use");
    expect((toolMsg.content[0] as ToolUseContentBlock).toolName).toBe("bash");
    expect((toolMsg.content[0] as ToolUseContentBlock).toolUseId).toBe("tool-1");
    expect(toolMsg.content[1].type).toBe("tool_result");
    expect((toolMsg.content[1] as ToolResultContentBlock).toolOutput).toContain("file1.txt");
    expect((toolMsg.content[1] as ToolResultContentBlock).toolUseId).toBe("tool-1");
  });

  test("extracts title from first user message", async () => {
    const result = expectParsed(
      await parseOpenCodeSession(path.join(FIXTURES_DIR, "opencode-simple.jsonl"), "test-project"),
    );

    expect(result.meta.title).toBe("Hello");
  });

  test("keeps OpenCode parsing separate from redaction transform", async () => {
    const parsed = expectParsed(
      await parseOpenCodeSession(
        path.join(FIXTURES_DIR, "opencode-redaction.jsonl"),
        "test-project",
      ),
    );

    const parsedUserText = (parsed.messages[0].content[0] as TextContentBlock).text;
    expect(parsedUserText).toContain(
      "github_pat_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_abc",
    );

    const redacted = redactParseResult(parsed);
    const firstUserText = (redacted.messages[0].content[0] as TextContentBlock).text;
    expect(firstUserText).toBe("Use [REDACTED:github-token] for testing");

    const toolUse = redacted.messages[1].content[0] as ToolUseContentBlock;
    expect(toolUse.toolInput).toContain("Bearer [REDACTED]");
    expect(toolUse.toolInput).toContain("[REDACTED:github-token]");

    const toolResult = redacted.messages[1].content[1] as ToolResultContentBlock;
    expect(toolResult.toolOutput).toContain("[REDACTED:huggingface-token]");
    expect(toolResult.toolOutput).toContain("[REDACTED:jwt]");
  });
});

describe("Pi parser", () => {
  test("parses pi session format", async () => {
    const result = expectParsed(
      await parsePiSession(path.join(FIXTURES_DIR, "pi-simple.jsonl"), "test-project"),
    );

    expect(result.meta.id).toBe("pi-session-1");
    expect(result.meta.source).toBe("pi");
    expect(result.meta.project).toBe("test-project");
    expect(result.meta.cwd).toBe("/home/user/project");
    expect(result.meta.title).toBe("Refactor auth module");
    expect(result.meta.model).toBe("gpt-5.4");

    expect(result.messages).toHaveLength(3);

    const assistant = result.messages[1];
    expect(assistant.role).toBe("assistant");
    expect(assistant.tokensIn).toBe(120);
    expect(assistant.tokensOut).toBe(45);
    expect(assistant.cacheReadTokens).toBe(10);
    expect(assistant.cacheWriteTokens).toBe(5);
    expect(assistant.content).toHaveLength(2);
    expect(assistant.content[0].type).toBe("text");
    expect(assistant.content[1].type).toBe("tool_use");
    expect((assistant.content[1] as ToolUseContentBlock).toolName).toBe("read");
    expect((assistant.content[1] as ToolUseContentBlock).toolUseId).toBe("call_1");

    const toolResult = result.messages[2];
    expect(toolResult.role).toBe("user");
    expect(toolResult.content).toHaveLength(1);
    expect(toolResult.content[0].type).toBe("tool_result");
    expect((toolResult.content[0] as ToolResultContentBlock).toolOutput).toContain("auth");
    expect((toolResult.content[0] as ToolResultContentBlock).toolUseId).toBe("call_1");
  });

  test("surfaces pi custom_message entries as user messages with wrapping", async () => {
    const result = expectParsed(
      await parsePiSession(path.join(FIXTURES_DIR, "pi-custom-message.jsonl"), "test-project"),
    );

    const customMsg = result.messages.find((m) =>
      m.content.some(
        (b) => b.type === "text" && (b as TextContentBlock).text.includes("custom-message"),
      ),
    );
    if (!customMsg) {
      throw new Error("Expected a custom_message to be surfaced");
    }
    expect(customMsg.role).toBe("user");

    const text = (customMsg.content[0] as TextContentBlock).text;
    expect(text).toContain('customType="subagent-slash-result"');
    expect(text).toContain("Subagent finished: here is the synthesized finding.");
  });

  test("silently skips pi thinking_level_change records", async () => {
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(" "));
    };

    try {
      const result = expectParsed(
        await parsePiSession(path.join(FIXTURES_DIR, "pi-custom-message.jsonl"), "test-project"),
      );

      expect(
        warnings.some((w) => w.includes("thinking_level_change") && w.includes("Unknown")),
      ).toBe(false);

      expect(
        result.messages.some((m) =>
          m.content.some((b) => b.type === "text" && (b as TextContentBlock).text.includes("high")),
        ),
      ).toBe(false);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("keeps Pi parsing separate from redaction transform", async () => {
    const parsed = expectParsed(
      await parsePiSession(path.join(FIXTURES_DIR, "pi-redaction.jsonl"), "test-project"),
    );

    const parsedUserText = (parsed.messages[0].content[0] as TextContentBlock).text;
    expect(parsedUserText).toContain("sk-or-abcdefghijklmnopqrstuvwxyz123456");

    const redacted = redactParseResult(parsed);

    const firstUserText = (redacted.messages[0].content[0] as TextContentBlock).text;
    expect(firstUserText).toContain("[REDACTED:openrouter-key]");
    expect(firstUserText).not.toContain("sk-or-abcdefghijklmnopqrstuvwxyz123456");

    const toolUse = redacted.messages[1].content[1] as ToolUseContentBlock;
    expect(toolUse.toolInput).toContain("Bearer [REDACTED]");
    expect(toolUse.toolInput).toContain("[REDACTED:github-token]");

    const toolResult = redacted.messages[2].content[0] as ToolResultContentBlock;
    expect(toolResult.toolOutput).toContain("[REDACTED:huggingface-token]");
    expect(toolResult.toolOutput).toContain("[REDACTED:jwt]");
  });
});

describe("shared parser helpers", () => {
  test("skips tool_result blocks that are missing content", () => {
    const parsed = parseContentBlock({ type: "tool_result" }, "test-parser");
    expect(parsed).toBeUndefined();
  });
});
