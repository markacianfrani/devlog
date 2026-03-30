import { describe, expect, test } from "bun:test";
import path from "node:path";
import { parseClaudeSession } from "../parsers/claude.ts";
import { parseOpenCodeSession } from "../parsers/opencode.ts";
import { parsePiSession } from "../parsers/pi.ts";
import type {
  TextContentBlock,
  ThinkingContentBlock,
  ToolResultContentBlock,
  ToolUseContentBlock,
} from "../parsers/types.ts";

const FIXTURES_DIR = path.join(import.meta.dir, "fixtures");

describe("Claude parser", () => {
  test("parses simple user/assistant exchange", async () => {
    const result = await parseClaudeSession(
      path.join(FIXTURES_DIR, "claude-simple.jsonl"),
      "test-project",
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
    const result = await parseClaudeSession(
      path.join(FIXTURES_DIR, "claude-with-tools.jsonl"),
      "test-project",
    );

    expect(result.messages).toHaveLength(4);

    const toolUseMsg = result.messages[1];
    expect(toolUseMsg.content).toHaveLength(1);
    expect(toolUseMsg.content[0].type).toBe("tool_use");
    expect((toolUseMsg.content[0] as ToolUseContentBlock).toolName).toBe("Read");
    expect((toolUseMsg.content[0] as ToolUseContentBlock).toolInput).toContain("package.json");

    const toolResultMsg = result.messages[2];
    expect(toolResultMsg.role).toBe("user");
    expect(toolResultMsg.content).toHaveLength(1);
    expect(toolResultMsg.content[0].type).toBe("tool_result");
    expect((toolResultMsg.content[0] as ToolResultContentBlock).toolOutput).toContain("my-project");
  });

  test("extracts agentId for agent sessions", async () => {
    const result = await parseClaudeSession(
      path.join(FIXTURES_DIR, "claude-agent.jsonl"),
      "test-project",
    );

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].agentId).toBe("agent-123");
    expect(result.messages[1].agentId).toBe("agent-123");
  });

  test("filters out noise records and preserves thinking blocks", async () => {
    const result = await parseClaudeSession(
      path.join(FIXTURES_DIR, "claude-noise.jsonl"),
      "test-project",
    );

    // Should only have 2 messages: real user + assistant (meta message filtered)
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
    const result = await parseClaudeSession(
      path.join(FIXTURES_DIR, "claude-thinking-only.jsonl"),
      "test-project",
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
    const result = await parseClaudeSession(
      path.join(FIXTURES_DIR, "claude-noise.jsonl"),
      "test-project",
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
    const result = await parseClaudeSession(
      path.join(FIXTURES_DIR, "claude-noise.jsonl"),
      "test-project",
    );

    expect(result.meta.title).toBe("Test session summary");
  });

  test("extracts session title from custom-title record", async () => {
    const result = await parseClaudeSession(
      path.join(FIXTURES_DIR, "claude-custom-title.jsonl"),
      "test-project",
    );

    expect(result.meta.title).toBe("My custom session title");
    expect(result.messages).toHaveLength(2);
  });

  test("returns empty prLinks when none present", async () => {
    const result = await parseClaudeSession(
      path.join(FIXTURES_DIR, "claude-simple.jsonl"),
      "test-project",
    );

    expect(result.prLinks).toEqual([]);
  });

  test("deduplicates messages with the same uuid, keeping the last", async () => {
    const result = await parseClaudeSession(
      path.join(FIXTURES_DIR, "claude-duplicate-uuids.jsonl"),
      "test-project",
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
    const result = await parseOpenCodeSession(
      path.join(FIXTURES_DIR, "opencode-simple.jsonl"),
      "test-project",
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
    const result = await parseOpenCodeSession(
      path.join(FIXTURES_DIR, "opencode-simple.jsonl"),
      "test-project",
    );

    const toolMsg = result.messages[2];
    expect(toolMsg.content).toHaveLength(2);
    expect(toolMsg.content[0].type).toBe("tool_use");
    expect((toolMsg.content[0] as ToolUseContentBlock).toolName).toBe("bash");
    expect(toolMsg.content[1].type).toBe("tool_result");
    expect((toolMsg.content[1] as ToolResultContentBlock).toolOutput).toContain("file1.txt");
  });

  test("extracts title from first user message", async () => {
    const result = await parseOpenCodeSession(
      path.join(FIXTURES_DIR, "opencode-simple.jsonl"),
      "test-project",
    );

    expect(result.meta.title).toBe("Hello");
  });
});

describe("Pi parser", () => {
  test("parses pi session format", async () => {
    const result = await parsePiSession(path.join(FIXTURES_DIR, "pi-simple.jsonl"), "test-project");

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

    const toolResult = result.messages[2];
    expect(toolResult.role).toBe("user");
    expect(toolResult.content).toHaveLength(1);
    expect(toolResult.content[0].type).toBe("tool_result");
    expect((toolResult.content[0] as ToolResultContentBlock).toolOutput).toContain("auth");
  });
});
