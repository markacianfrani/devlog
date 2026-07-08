import { describe, expect, test } from "bun:test";
import path from "node:path";

import { parseClaudeSession } from "../parsers/claude.ts";
import { parseOpenCodeSession } from "../parsers/opencode.ts";
import { parsePiSession } from "../parsers/pi.ts";
import { parseContentBlock, ParseWarningCollector } from "../parsers/shared.ts";
import type {
  ParseOutcome,
  ParseResult,
  ParseWarning,
  TextContentBlock,
  ThinkingContentBlock,
  ToolResultContentBlock,
  ToolUseContentBlock,
} from "../parsers/types.ts";
import { formatParseWarning } from "../progress.ts";
import { redactForIndexing } from "../redaction.ts";
import { at } from "./archive-fixtures.ts";

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

function expectParsed(outcome: ParseOutcome): ParseResult {
  expect(outcome.result).toBeDefined();
  if (!outcome.result) {
    throw new Error("Expected parser to return a result");
  }
  return outcome.result;
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

    const userMsg = at(result.messages, 0);
    expect(userMsg.id).toBe("msg-user-1");
    expect(userMsg.role).toBe("user");
    expect(userMsg.content).toHaveLength(1);
    expect(at(userMsg.content, 0).type).toBe("text");
    expect((at(userMsg.content, 0) as TextContentBlock).text).toBe("Hello, how are you?");

    const asstMsg = at(result.messages, 1);
    expect(asstMsg.id).toBe("msg-asst-1");
    expect(asstMsg.role).toBe("assistant");
    expect(asstMsg.parentId).toBe("msg-user-1");
    expect(asstMsg.model).toBe("claude-opus-4-5-20251101");
    expect(asstMsg.tokensIn).toBe(100);
    expect(asstMsg.tokensOut).toBe(50);
    expect(asstMsg.cacheReadTokens).toBe(20);
    expect(asstMsg.cacheWriteTokens).toBe(15);
    expect((at(asstMsg.content, 0) as TextContentBlock).text).toBe(
      "I'm doing well, thank you for asking!",
    );
  });

  test("parses tool use and tool results", async () => {
    const result = expectParsed(
      await parseClaudeSession(path.join(FIXTURES_DIR, "claude-with-tools.jsonl"), "test-project"),
    );

    expect(result.messages).toHaveLength(4);

    const toolUseMsg = at(result.messages, 1);
    expect(toolUseMsg.content).toHaveLength(1);
    expect(at(toolUseMsg.content, 0).type).toBe("tool_use");
    expect((at(toolUseMsg.content, 0) as ToolUseContentBlock).toolName).toBe("Read");
    expect((at(toolUseMsg.content, 0) as ToolUseContentBlock).toolInput).toContain("package.json");
    expect((at(toolUseMsg.content, 0) as ToolUseContentBlock).toolUseId).toBe("tool-1");

    const toolResultMsg = at(result.messages, 2);
    expect(toolResultMsg.role).toBe("user");
    expect(toolResultMsg.content).toHaveLength(1);
    expect(at(toolResultMsg.content, 0).type).toBe("tool_result");
    expect((at(toolResultMsg.content, 0) as ToolResultContentBlock).toolOutput).toContain(
      "my-project",
    );
    expect((at(toolResultMsg.content, 0) as ToolResultContentBlock).toolUseId).toBe("tool-1");
  });

  test("keeps parsing separate from redaction transform", async () => {
    await withEnv("DEVLOG_TEST_SECRET_TOKEN_PARSE", "literal-secret-token-12345", async () => {
      const parsed = expectParsed(
        await parseClaudeSession(path.join(FIXTURES_DIR, "claude-redaction.jsonl"), "test-project"),
      );

      const parsedUserText = (at(at(parsed.messages, 0).content, 0) as TextContentBlock).text;
      expect(parsedUserText).toContain("sk-proj-123456789012345678901234");
      expect(parsedUserText).toContain("literal-secret-token-12345");

      const redacted = redactForIndexing(parsed);

      const firstUserText = (at(at(redacted.messages, 0).content, 0) as TextContentBlock).text;
      expect(firstUserText).toContain("[REDACTED:openai-project-key]");
      expect(firstUserText).toContain("[REDACTED:devlog-test-secret-token-parse]");
      expect(firstUserText).not.toContain("sk-proj-123456789012345678901234");
      expect(firstUserText).not.toContain("literal-secret-token-12345");

      const toolUse = at(at(redacted.messages, 1).content, 0) as ToolUseContentBlock;
      expect(toolUse.toolInput).toContain("Bearer [REDACTED]");
      expect(toolUse.toolInput).toContain("[REDACTED:github-token]");
      expect(toolUse.toolInput).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz123456");

      const toolResult = at(at(redacted.messages, 2).content, 0) as ToolResultContentBlock;
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
    expect(at(result.messages, 0).agentId).toBe("agent-123");
    expect(at(result.messages, 1).agentId).toBe("agent-123");
  });

  test("filters out noise records and preserves thinking blocks", async () => {
    const result = expectParsed(
      await parseClaudeSession(path.join(FIXTURES_DIR, "claude-noise.jsonl"), "test-project"),
    );

    expect(result.messages).toHaveLength(2);

    const userMsg = at(result.messages, 0);
    expect((at(userMsg.content, 0) as TextContentBlock).text).toBe("Real user message");

    const asstMsg = at(result.messages, 1);
    expect(asstMsg.content).toHaveLength(2);
    expect(at(asstMsg.content, 0).type).toBe("thinking");
    expect((at(asstMsg.content, 0) as ThinkingContentBlock).thinking).toBe(
      "Let me think about this...",
    );
    expect(at(asstMsg.content, 1).type).toBe("text");
    expect((at(asstMsg.content, 1) as TextContentBlock).text).toBe("Here is my response.");
  });

  test("skips bridge-session records without an unknown-type warning", async () => {
    const outcome = await parseClaudeSession(
      path.join(FIXTURES_DIR, "claude-noise.jsonl"),
      "test-project",
    );

    const unknownBridge = outcome.warnings.filter(
      (w) => w.kind === "unknown-record-type" && w.type === "bridge-session",
    );
    expect(unknownBridge).toEqual([]);
  });

  test("skips fallback content blocks without an unknown-type warning", async () => {
    const outcome = await parseClaudeSession(
      path.join(FIXTURES_DIR, "claude-noise.jsonl"),
      "test-project",
    );

    const unknownFallback = outcome.warnings.filter(
      (w) => w.kind === "unknown-content-block-type" && w.type === "fallback",
    );
    expect(unknownFallback).toEqual([]);
  });

  test("preserves thinking blocks and token data from thinking-only assistant messages", async () => {
    const result = expectParsed(
      await parseClaudeSession(
        path.join(FIXTURES_DIR, "claude-thinking-only.jsonl"),
        "test-project",
      ),
    );

    expect(result.messages).toHaveLength(2);

    const asstMsg = at(result.messages, 1);
    expect(asstMsg.role).toBe("assistant");
    expect(asstMsg.content).toHaveLength(1);
    expect(at(asstMsg.content, 0).type).toBe("thinking");
    expect((at(asstMsg.content, 0) as ThinkingContentBlock).thinking).toBe(
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

  test("extracts frame-link records as artifact links", async () => {
    const result = expectParsed(
      await parseClaudeSession(path.join(FIXTURES_DIR, "claude-noise.jsonl"), "test-project"),
    );

    expect(result.artifactLinks).toHaveLength(1);
    expect(result.artifactLinks[0]).toEqual({
      sessionId: "test-session-4",
      path: "/home/user/project/scratchpad/fart-chart.html",
      artifactUrl: "https://claude.ai/code/artifact/fart-a-doodle-doo",
      timestamp: "2026-01-20T10:00:03.000Z",
    });
  });

  test("skips frame-link records without an unknown-type warning", async () => {
    const outcome = await parseClaudeSession(
      path.join(FIXTURES_DIR, "claude-noise.jsonl"),
      "test-project",
    );

    const unknownFrame = outcome.warnings.filter(
      (w) => w.kind === "unknown-record-type" && w.type === "frame-link",
    );
    expect(unknownFrame).toEqual([]);
  });

  test("skips relocated records without an unknown-type warning", async () => {
    const outcome = await parseClaudeSession(
      path.join(FIXTURES_DIR, "claude-noise.jsonl"),
      "test-project",
    );

    const unknownRelocated = outcome.warnings.filter(
      (w) => w.kind === "unknown-record-type" && w.type === "relocated",
    );
    expect(unknownRelocated).toEqual([]);
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

  test("custom-title beats ai-title regardless of file order", async () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg: string) => warnings.push(msg);

    try {
      const result = expectParsed(
        await parseClaudeSession(path.join(FIXTURES_DIR, "claude-ai-title.jsonl"), "test-project"),
      );

      expect(result.meta.title).toBe("User custom title");
      expect(result.messages).toHaveLength(2);
      expect(warnings.filter((w) => w.includes("ai-title"))).toHaveLength(0);
    } finally {
      console.warn = originalWarn;
    }
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

  test("captures worktree-state: last valid record wins, malformed records are ignored, cwd untouched", async () => {
    const result = expectParsed(
      await parseClaudeSession(path.join(FIXTURES_DIR, "claude-worktree.jsonl"), "test-project"),
    );

    // cwd stays where work actually happens (message cwd), even though
    // worktreeSession.originalCwd points elsewhere -- pin both sides so a
    // regression that overwrites cwd with originalCwd fails loudly.
    expect(result.meta.cwd).toBe("/home/user/project/.claude/worktrees/feature-spike");
    expect(result.meta.cwd).not.toBe(result.meta.worktree?.originalCwd);

    // Fixture has, in order: valid (commit=abc), user, assistant, valid
    // (commit=def), malformed (missing worktreePath), malformed (missing
    // worktreeName). Last-valid-wins should land on def; either malformed
    // record clobbering state would fail this assertion.
    expect(result.meta.worktree).toEqual({
      worktreePath: "/home/user/project/.claude/worktrees/feature-spike",
      worktreeName: "feature-spike",
      originalCwd: "/home/user/project",
      worktreeBranch: "worktree-feature-spike",
      originalBranch: "main",
      originalHeadCommit: "def4567890abc",
    });
  });

  test("preserves redacted thinking blocks (empty thinking string)", async () => {
    const result = expectParsed(
      await parseClaudeSession(
        path.join(FIXTURES_DIR, "claude-redacted-thinking.jsonl"),
        "test-project",
      ),
    );

    expect(result.messages).toHaveLength(3);
    const firstAsst = at(result.messages, 1);
    expect(firstAsst.content).toHaveLength(2);
    expect(at(firstAsst.content, 0).type).toBe("redacted_thinking");
    expect(at(firstAsst.content, 1).type).toBe("text");

    const secondAsst = at(result.messages, 2);
    expect(at(secondAsst.content, 0).type).toBe("redacted_thinking");
    expect(at(secondAsst.content, 1).type).toBe("text");
  });

  test("preserves document content blocks with mediaType", async () => {
    const result = expectParsed(
      await parseClaudeSession(path.join(FIXTURES_DIR, "claude-document.jsonl"), "test-project"),
    );

    const userMsg = at(result.messages, 0);
    expect(userMsg.content).toHaveLength(2);
    expect(at(userMsg.content, 0).type).toBe("text");
    expect(at(userMsg.content, 1).type).toBe("document");
    const doc = at(userMsg.content, 1) as { type: "document"; mediaType?: string };
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

    const asstMsg = at(result.messages, 1);
    expect(asstMsg.id).toBe("msg-asst-1");
    expect((at(asstMsg.content, 0) as TextContentBlock).text).toBe(
      "Full response with more detail.",
    );
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

    const userMsg = at(result.messages, 0);
    expect(userMsg.role).toBe("user");
    expect((at(userMsg.content, 0) as TextContentBlock).text).toBe("Hello");

    const asstMsg = at(result.messages, 1);
    expect(asstMsg.role).toBe("assistant");
    expect(asstMsg.tokensIn).toBe(100);
    expect(asstMsg.tokensOut).toBe(50);
  });

  test("parses tool use with inline results", async () => {
    const result = expectParsed(
      await parseOpenCodeSession(path.join(FIXTURES_DIR, "opencode-simple.jsonl"), "test-project"),
    );

    const toolMsg = at(result.messages, 2);
    expect(toolMsg.content).toHaveLength(2);
    expect(at(toolMsg.content, 0).type).toBe("tool_use");
    expect((at(toolMsg.content, 0) as ToolUseContentBlock).toolName).toBe("bash");
    expect((at(toolMsg.content, 0) as ToolUseContentBlock).toolUseId).toBe("tool-1");
    expect(at(toolMsg.content, 1).type).toBe("tool_result");
    expect((at(toolMsg.content, 1) as ToolResultContentBlock).toolOutput).toContain("file1.txt");
    expect((at(toolMsg.content, 1) as ToolResultContentBlock).toolUseId).toBe("tool-1");
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

    const parsedUserText = (at(at(parsed.messages, 0).content, 0) as TextContentBlock).text;
    expect(parsedUserText).toContain(
      "github_pat_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_abc",
    );

    const redacted = redactForIndexing(parsed);
    const firstUserText = (at(at(redacted.messages, 0).content, 0) as TextContentBlock).text;
    expect(firstUserText).toBe("Use [REDACTED:github-token] for testing");

    const toolUse = at(at(redacted.messages, 1).content, 0) as ToolUseContentBlock;
    expect(toolUse.toolInput).toContain("Bearer [REDACTED]");
    expect(toolUse.toolInput).toContain("[REDACTED:github-token]");

    const toolResult = at(at(redacted.messages, 1).content, 1) as ToolResultContentBlock;
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

    const assistant = at(result.messages, 1);
    expect(assistant.role).toBe("assistant");
    expect(assistant.tokensIn).toBe(120);
    expect(assistant.tokensOut).toBe(45);
    expect(assistant.cacheReadTokens).toBe(10);
    expect(assistant.cacheWriteTokens).toBe(5);
    expect(assistant.content).toHaveLength(2);
    expect(at(assistant.content, 0).type).toBe("text");
    expect(at(assistant.content, 1).type).toBe("tool_use");
    expect((at(assistant.content, 1) as ToolUseContentBlock).toolName).toBe("read");
    expect((at(assistant.content, 1) as ToolUseContentBlock).toolUseId).toBe("call_1");

    const toolResult = at(result.messages, 2);
    expect(toolResult.role).toBe("user");
    expect(toolResult.content).toHaveLength(1);
    expect(at(toolResult.content, 0).type).toBe("tool_result");
    expect((at(toolResult.content, 0) as ToolResultContentBlock).toolOutput).toContain("auth");
    expect((at(toolResult.content, 0) as ToolResultContentBlock).toolUseId).toBe("call_1");
  });

  test("surfaces pi custom_message entries as user messages with wrapping", async () => {
    const result = expectParsed(
      await parsePiSession(path.join(FIXTURES_DIR, "pi-custom-message.jsonl"), "test-project"),
    );

    const customMsg = result.messages.find((m) =>
      m.content.some((b) => b.type === "text" && b.text.includes("custom-message")),
    );
    if (!customMsg) {
      throw new Error("Expected a custom_message to be surfaced");
    }
    expect(customMsg.role).toBe("user");

    const text = (customMsg.content[0] as TextContentBlock).text;
    expect(text).toContain('customType="subagent-slash-result"');
    expect(text).toContain("Subagent finished: here is the synthesized finding.");
  });

  test("renders pi web-search-results custom records with truncated snippets", async () => {
    const result = expectParsed(
      await parsePiSession(path.join(FIXTURES_DIR, "pi-custom-extensions.jsonl"), "test-project"),
    );

    const search = result.messages.find((m) =>
      m.content.some((b) => b.type === "text" && b.text.includes("HEADMARKER_FART")),
    );
    if (!search) {
      throw new Error("Expected a web-search-results fetch message to be surfaced");
    }
    expect(search.role).toBe("user");

    const text = (search.content[0] as TextContentBlock).text;
    expect(text).toContain("https://example.com/fart-facts");
    expect(text).toContain("The Science of Farts");
    // Snippet is truncated, so the head survives but the tail past ~300 chars is dropped.
    expect(text).toContain("HEADMARKER_FART");
    expect(text).not.toContain("TAILMARKER_FART");
    // Failed fetches surface their error, not silent emptiness.
    expect(text).toContain("https://example.com/missing-fart");
    expect(text).toContain("timed out smelling the fart");
  });

  test("renders pi web-search-results search records with query, answer snippet, and sources", async () => {
    const result = expectParsed(
      await parsePiSession(path.join(FIXTURES_DIR, "pi-custom-extensions.jsonl"), "test-project"),
    );

    const search = result.messages.find((m) =>
      m.content.some((b) => b.type === "text" && b.text.includes("FART_QUERY")),
    );
    if (!search) {
      throw new Error("Expected a web-search-results search message to be surfaced");
    }
    expect(search.role).toBe("user");

    const text = (search.content[0] as TextContentBlock).text;
    expect(text).toContain("FART_QUERY beans nutrition facts");
    // The synthesized answer is the payload, but still snippet-truncated.
    expect(text).toContain("ANSWER_HEAD");
    expect(text).not.toContain("ANSWER_TAIL");
    // Sources keep title + url so the search stays traceable.
    expect(text).toContain("Bean Science");
    expect(text).toContain("https://example.com/bean-science");
  });

  test("renders an active goal-state and silently skips a null goal", async () => {
    const outcome = await parsePiSession(
      path.join(FIXTURES_DIR, "pi-custom-extensions.jsonl"),
      "test-project",
    );
    const result = expectParsed(outcome);

    const goals = result.messages.filter((m) =>
      m.content.some((b) => b.type === "text" && b.text.includes("pi:goal-state")),
    );
    // Two goal-state records in the fixture: the active one renders, the null one does not.
    expect(goals).toHaveLength(1);
    const goal = goals[0];
    if (!goal) {
      throw new Error("Expected a goal-state message to be surfaced");
    }

    const text = (goal.content[0] as TextContentBlock).text;
    expect(text).toContain("ship the fart detector");
    expect(text).toContain("active");
    expect(text).toContain("4242");
    expect(text).toContain("617");

    // A null goal is legitimately empty, not malformed: skipped without a warning.
    expect(outcome.warnings.some((w) => w.message.includes("goal-state"))).toBe(false);
  });

  test("warns when a recognized pi extension carries a malformed payload", async () => {
    const outcome = await parsePiSession(
      path.join(FIXTURES_DIR, "pi-custom-extensions.jsonl"),
      "test-project",
    );
    expectParsed(outcome);

    // A recognized extension (web-search-results) whose `data` is a string, not an
    // object — a silent drop would hide a real record, so it must warn.
    expect(
      outcome.warnings.some(
        (w) => w.kind === "missing-field" && w.message.includes("web-search-results"),
      ),
    ).toBe(true);
  });

  test("warns by extension name for unrecognized pi custom records", async () => {
    const filePath = path.join(FIXTURES_DIR, "pi-custom-extensions.jsonl");
    const outcome = await parsePiSession(filePath, "test-project");
    expectParsed(outcome);

    const unknown = outcome.warnings.filter((w) => w.kind === "unknown-record-type");
    expect(unknown).toEqual([
      expect.objectContaining({
        kind: "unknown-record-type",
        parserName: "pi-parser",
        message: '[pi-parser] Unknown record type: "fart-o-matic"',
        type: "fart-o-matic",
        context: "record",
      }),
    ]);
  });

  test("returns structured warnings for unknown pi record types", async () => {
    const filePath = path.join(FIXTURES_DIR, "pi-unknown-record.jsonl");
    const outcome = await parsePiSession(filePath, "test-project");
    expectParsed(outcome);

    expect(outcome.warnings).toEqual([
      expect.objectContaining({
        kind: "unknown-record-type",
        parserName: "pi-parser",
        message: '[pi-parser] Unknown record type: "fart-record"',
        filePath,
        lineNumber: 3,
        count: 1,
        context: "record",
        type: "fart-record",
      }),
    ]);
  });

  test("returns warnings even when no parse result can be finalized", async () => {
    const filePath = path.join(FIXTURES_DIR, "pi-warning-only.jsonl");
    const outcome = await parsePiSession(filePath, "test-project");

    expect(outcome.result).toBeUndefined();
    expect(outcome.warnings).toEqual([
      expect.objectContaining({
        kind: "unknown-record-type",
        parserName: "pi-parser",
        message: '[pi-parser] Unknown record type: "fart-record"',
        filePath,
        lineNumber: 2,
        count: 1,
        context: "record",
        type: "fart-record",
      }),
    ]);
  });

  test("produces no warnings for well-formed sessions", async () => {
    const outcome = await parsePiSession(
      path.join(FIXTURES_DIR, "pi-simple.jsonl"),
      "test-project",
    );
    expectParsed(outcome);
    expect(outcome.warnings).toEqual([]);
  });

  test("coalesces repeated unknown record types into count > 1", async () => {
    const filePath = path.join(FIXTURES_DIR, "pi-duplicate-unknown.jsonl");
    const outcome = await parsePiSession(filePath, "test-project");
    expectParsed(outcome);

    const unknownWarnings = outcome.warnings.filter((w) => w.kind === "unknown-record-type");
    expect(unknownWarnings).toHaveLength(1);
    expect(unknownWarnings[0]).toEqual(
      expect.objectContaining({
        type: "fart-record",
        count: 3,
        lineNumber: 3,
      }),
    );
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
          m.content.some((b) => b.type === "text" && b.text.includes("high")),
        ),
      ).toBe(false);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("parses pi compaction and branch summary records without noisy warnings", async () => {
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(" "));
    };

    try {
      const result = expectParsed(
        await parsePiSession(path.join(FIXTURES_DIR, "pi-new-records.jsonl"), "test-project"),
      );

      expect(warnings.filter((w) => w.includes("Unknown"))).toHaveLength(0);
      expect(result.messages).toHaveLength(3);

      const compaction = result.messages.find((m) => m.id === "compact1");
      expect(compaction).toBeDefined();
      if (!compaction) {
        throw new Error("Expected compaction message");
      }
      expect(at(compaction.content, 0).type).toBe("text");
      expect((at(compaction.content, 0) as TextContentBlock).text).toContain(
        "<pi:compaction>Compacted progress summary</pi:compaction>",
      );

      const branchSummary = result.messages.find((m) => m.id === "branch1");
      expect(branchSummary).toBeDefined();
      if (!branchSummary) {
        throw new Error("Expected branch summary message");
      }
      expect(at(branchSummary.content, 0).type).toBe("text");
      expect((at(branchSummary.content, 0) as TextContentBlock).text).toContain(
        '<pi:branch-summary fromId="u1">Branch exploration summary</pi:branch-summary>',
      );
    } finally {
      console.warn = originalWarn;
    }
  });

  test("keeps Pi parsing separate from redaction transform", async () => {
    const parsed = expectParsed(
      await parsePiSession(path.join(FIXTURES_DIR, "pi-redaction.jsonl"), "test-project"),
    );

    const parsedUserText = (at(at(parsed.messages, 0).content, 0) as TextContentBlock).text;
    expect(parsedUserText).toContain("sk-or-abcdefghijklmnopqrstuvwxyz123456");

    const redacted = redactForIndexing(parsed);

    const firstUserText = (at(at(redacted.messages, 0).content, 0) as TextContentBlock).text;
    expect(firstUserText).toContain("[REDACTED:openrouter-key]");
    expect(firstUserText).not.toContain("sk-or-abcdefghijklmnopqrstuvwxyz123456");

    const toolUse = at(at(redacted.messages, 1).content, 1) as ToolUseContentBlock;
    expect(toolUse.toolInput).toContain("Bearer [REDACTED]");
    expect(toolUse.toolInput).toContain("[REDACTED:github-token]");

    const toolResult = at(at(redacted.messages, 2).content, 0) as ToolResultContentBlock;
    expect(toolResult.toolOutput).toContain("[REDACTED:huggingface-token]");
    expect(toolResult.toolOutput).toContain("[REDACTED:jwt]");
  });
});

describe("shared parser helpers", () => {
  test("parses text blocks", () => {
    expect(parseContentBlock({ type: "text", text: "hi" }, "test-parser")).toEqual({
      type: "text",
      text: "hi",
    });
  });

  test("parses tool_use blocks", () => {
    expect(
      parseContentBlock(
        {
          type: "tool_use",
          id: "tool-1",
          name: "Read",
          input: { file_path: "README.md" },
        },
        "test-parser",
      ),
    ).toEqual({
      type: "tool_use",
      toolName: "Read",
      toolInput: '{"file_path":"README.md"}',
      toolUseId: "tool-1",
    });
  });

  test("skips tool_use blocks that are missing name", () => {
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(" "));
    };

    try {
      const parsed = parseContentBlock({ type: "tool_use" }, "test-parser");
      expect(parsed).toBeUndefined();
      expect(warnings).toEqual(["[test-parser] tool_use block missing name"]);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("parses tool_result object content", () => {
    expect(
      parseContentBlock(
        { type: "tool_result", tool_use_id: "tool-1", content: { ok: true } },
        "test-parser",
      ),
    ).toEqual({
      type: "tool_result",
      toolOutput: '{"ok":true}',
      toolUseId: "tool-1",
    });
  });

  test("skips tool_result blocks that are missing content", () => {
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(" "));
    };

    try {
      const parsed = parseContentBlock({ type: "tool_result" }, "test-parser");
      expect(parsed).toBeUndefined();
      expect(warnings).toEqual(["[test-parser] tool_result block missing content"]);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("treats empty thinking blocks as redacted thinking", () => {
    expect(parseContentBlock({ type: "thinking", thinking: "" }, "test-parser")).toEqual({
      type: "redacted_thinking",
    });
  });

  test("parses image blocks with media type", () => {
    expect(
      parseContentBlock(
        { type: "image", source: { type: "base64", media_type: "image/png" } },
        "test-parser",
      ),
    ).toEqual({
      type: "image",
      mediaType: "image/png",
    });
  });

  test("warns for each unknown content block type via public API", () => {
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(" "));
    };

    try {
      expect(
        parseContentBlock({ type: "shared-test-unknown-block" }, "test-parser"),
      ).toBeUndefined();
      expect(
        parseContentBlock({ type: "shared-test-unknown-block" }, "test-parser"),
      ).toBeUndefined();
      expect(warnings).toEqual([
        '[test-parser] Unknown content block type: "shared-test-unknown-block"',
        '[test-parser] Unknown content block type: "shared-test-unknown-block"',
      ]);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("deduplicates identical warnings within a collector", () => {
    const collector = new ParseWarningCollector("test-parser", "test.jsonl");
    const line1 = collector.line(1);
    const line5 = collector.line(5);
    const line10 = collector.line(10);

    line1.unknownType("some-type", "record");
    line5.unknownType("some-type", "record");
    line10.unknownType("other-type", "record");

    const warnings = collector.toArray();
    expect(warnings).toHaveLength(2);

    // First occurrence lineNumber is preserved, count incremented
    expect(warnings[0]).toEqual(
      expect.objectContaining({
        kind: "unknown-record-type",
        type: "some-type",
        count: 2,
        lineNumber: 1,
      }),
    );

    // Different type gets its own entry
    expect(warnings[1]).toEqual(
      expect.objectContaining({
        kind: "unknown-record-type",
        type: "other-type",
        count: 1,
        lineNumber: 10,
      }),
    );
  });

  test("skips configured content block types without warning", () => {
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(" "));
    };

    try {
      const parsed = parseContentBlock(
        { type: "shared-test-skipped-block" },
        "test-parser",
        new Set(["shared-test-skipped-block"]),
      );
      expect(parsed).toBeUndefined();
      expect(warnings).toEqual([]);
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe("formatParseWarning", () => {
  test("omits count suffix for malformed-lines (avoids double-count)", () => {
    const warning: ParseWarning = {
      kind: "malformed-lines",
      parserName: "claude-parser",
      message: "[claude-parser] Skipped 5 malformed line(s)",
      filePath: "/test/file.jsonl",
      count: 5,
    };
    const formatted = formatParseWarning(warning);
    expect(formatted).not.toContain("occurrences");
    expect(formatted).toContain("Skipped 5 malformed line(s)");
  });

  test("includes count suffix for coalesced unknown-type warnings", () => {
    const warning: ParseWarning = {
      kind: "unknown-record-type",
      parserName: "pi-parser",
      message: '[pi-parser] Unknown record type: "fart-record"',
      filePath: "/test/file.jsonl",
      lineNumber: 3,
      count: 4,
      context: "record",
      type: "fart-record",
    };
    const formatted = formatParseWarning(warning);
    expect(formatted).toContain("(4 occurrences)");
  });

  test("omits count suffix when count is 1", () => {
    const warning: ParseWarning = {
      kind: "unknown-record-type",
      parserName: "pi-parser",
      message: '[pi-parser] Unknown record type: "fart-record"',
      filePath: "/test/file.jsonl",
      lineNumber: 2,
      count: 1,
      context: "record",
      type: "fart-record",
    };
    const formatted = formatParseWarning(warning);
    expect(formatted).not.toContain("occurrences");
  });
});
