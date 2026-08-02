import { describe, expect, test } from "bun:test";
import path from "node:path";

import { parsePiSession } from "../parsers/pi.ts";
import type {
  ContentBlock,
  ParseOutcome,
  ParseResult,
  TextContentBlock,
  ThinkingContentBlock,
  ToolResultContentBlock,
  ToolUseContentBlock,
} from "../parsers/types.ts";
import { redactForIndexing } from "../redaction.ts";
import { at } from "./archive-fixtures.ts";

const FIXTURES_DIR = path.join(import.meta.dir, "fixtures");

function expectParsed(outcome: ParseOutcome): ParseResult {
  expect(outcome.result).toBeDefined();
  if (!outcome.result) {
    throw new Error("Expected parser to return a result");
  }
  return outcome.result;
}

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
    // pi preserves thinking blocks like claude/opencode — the indexer and
    // redaction both support them, so reasoning stays searchable.
    expect(assistant.content).toHaveLength(3);
    expect(at(assistant.content, 0).type).toBe("thinking");
    expect((at(assistant.content, 0) as ThinkingContentBlock).thinking).toBe("private reasoning");
    expect(at(assistant.content, 1).type).toBe("text");
    expect(at(assistant.content, 2).type).toBe("tool_use");
    expect((at(assistant.content, 2) as ToolUseContentBlock).toolName).toBe("read");
    expect((at(assistant.content, 2) as ToolUseContentBlock).toolUseId).toBe("call_1");

    const toolResult = at(result.messages, 2);
    expect(toolResult.role).toBe("user");
    expect(toolResult.content).toHaveLength(1);
    expect(at(toolResult.content, 0).type).toBe("tool_result");
    expect((at(toolResult.content, 0) as ToolResultContentBlock).toolOutput).toContain("auth");
    expect((at(toolResult.content, 0) as ToolResultContentBlock).toolUseId).toBe("call_1");
  });

  const customEntriesPath = path.join(FIXTURES_DIR, "pi-custom-entries.jsonl");
  const customMessagePath = path.join(FIXTURES_DIR, "pi-custom-message.jsonl");

  function piCustomText(result: ParseResult, id: string): string {
    const msg = result.messages.find((m) => m.id === id);
    const content: ContentBlock[] = msg?.content ?? [];
    const text = content.find((b): b is TextContentBlock => b.type === "text")?.text;
    if (msg?.role !== "user" || text === undefined) {
      throw new Error(`Expected a custom text message for id=${id}`);
    }
    return text;
  }

  test("surfaces every custom payload generically with stable envelope metadata", async () => {
    const result = expectParsed(await parsePiSession(customEntriesPath, "test-project"));
    const ids = [
      "c-vault",
      "c-array",
      "c-string",
      "c-number",
      "c-boolean",
      "c-null",
      "c-omitted",
      "c-unknown",
      "c-missing-type",
      "c-bad-type",
    ];
    const surfaced = result.messages.filter((m) => ids.includes(m.id));
    expect(surfaced).toHaveLength(ids.length);
    expect(surfaced.every((m) => m.role === "user")).toBe(true);

    // Stable envelope metadata and file ordering are preserved.
    const vault = result.messages.find((m) => m.id === "c-vault");
    expect(vault?.parentId).toBe("u1");
    expect(vault?.timestamp).toBe("2026-03-15T20:10:01.000Z");
    expect(vault?.sessionId).toBe("pi-custom-entries");
    const order = result.messages.map((m) => m.id);
    expect(order.indexOf("u1")).toBeLessThan(order.indexOf("c-vault"));
    expect(order.indexOf("c-bad-type")).toBeLessThan(order.indexOf("a1"));
  });

  test("preserves custom payload JSON verbatim and distinguishes null from omitted data", async () => {
    const result = expectParsed(await parsePiSession(customEntriesPath, "test-project"));
    // Exact assertions on the generic envelope so payload interpretation cannot
    // quietly return.
    expect(piCustomText(result, "c-vault")).toBe(
      '<pi:custom>{"customType":"fart-vault","data":{"credential":"ghp_abcdefghijklmnopqrstuvwxyz123456","note":"vault fart"}}</pi:custom>',
    );
    expect(piCustomText(result, "c-array")).toBe(
      '<pi:custom>{"customType":"fart-array","data":["toot","poot","blorp"]}</pi:custom>',
    );
    expect(piCustomText(result, "c-string")).toBe(
      '<pi:custom>{"customType":"fart-string","data":"silent-but-deadly"}</pi:custom>',
    );
    expect(piCustomText(result, "c-number")).toBe(
      '<pi:custom>{"customType":"fart-number","data":42}</pi:custom>',
    );
    expect(piCustomText(result, "c-boolean")).toBe(
      '<pi:custom>{"customType":"fart-boolean","data":true}</pi:custom>',
    );
    // Explicit null carries a data key; an omitted data field does not.
    expect(piCustomText(result, "c-null")).toBe(
      '<pi:custom>{"customType":"fart-null","data":null}</pi:custom>',
    );
    expect(piCustomText(result, "c-omitted")).toBe(
      '<pi:custom>{"customType":"fart-omitted"}</pi:custom>',
    );
  });

  test("arbitrary custom types and non-object payloads never warn; only envelope problems do", async () => {
    const outcome = await parsePiSession(customEntriesPath, "test-project");
    const result = expectParsed(outcome);

    // Envelope-broken records still surface their data verbatim.
    expect(piCustomText(result, "c-missing-type")).toBe(
      '<pi:custom>{"data":{"missingType":true}}</pi:custom>',
    );
    expect(piCustomText(result, "c-bad-type")).toBe(
      '<pi:custom>{"data":{"invalidType":true}}</pi:custom>',
    );

    // The well-formed fixture warns only on the missing/invalid customType
    // envelope (one coalesced warning covering both records); arbitrary types
    // and every payload form never warn.
    expect(outcome.warnings).toHaveLength(1);
    expect(outcome.warnings[0]).toEqual(
      expect.objectContaining({ kind: "missing-field", count: 2 }),
    );
    expect(outcome.warnings[0]?.message).toContain("customType");
  });

  test("custom-message strings stay searchable through the provenance wrapper", async () => {
    const result = expectParsed(await parsePiSession(customMessagePath, "test-project"));
    const msg = result.messages.find((m) => m.id === "cm1");
    const content: ContentBlock[] = msg?.content ?? [];
    const text = content.find((b): b is TextContentBlock => b.type === "text")?.text;
    expect(msg?.role).toBe("user");
    expect(text).toContain('<pi:custom-message customType="fart-string">');
    expect(text).toContain("silent but deadly string fart");
  });

  test("custom-message text arrays stay searchable with a provenance marker", async () => {
    const result = expectParsed(await parsePiSession(customMessagePath, "test-project"));
    const content: ContentBlock[] = result.messages.find((m) => m.id === "cm2")?.content ?? [];
    const texts = content
      .filter((b): b is TextContentBlock => b.type === "text")
      .map((b) => b.text);
    expect(texts.some((t) => t.includes('customType="fart-text-array"'))).toBe(true);
    expect(texts).toContain("first fart");
    expect(texts).toContain("second fart");
  });

  test("custom-message images retain their media type, including image-only messages", async () => {
    const result = expectParsed(await parsePiSession(customMessagePath, "test-project"));
    const mediaTypes = (id: string) => {
      const content: ContentBlock[] = result.messages.find((m) => m.id === id)?.content ?? [];
      return content
        .filter((b) => b.type === "image")
        .map((b) => (b as { mediaType?: string }).mediaType);
    };
    // Image-only messages are not dropped for lack of a text body.
    expect(mediaTypes("cm3")).toEqual(["image/png"]);
    expect(mediaTypes("cm4")).toEqual(["image/jpeg"]);
  });

  test("well-formed custom-message records warn only on unsupported content blocks", async () => {
    const outcome = await parsePiSession(customMessagePath, "test-project");
    expectParsed(outcome);
    expect(outcome.warnings).toEqual([
      expect.objectContaining({
        kind: "unknown-content-block-type",
        type: "fart-unknown-block",
        context: "content block",
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

  test("surfaces pi bashExecution messages as synthetic user messages", async () => {
    const result = expectParsed(
      await parsePiSession(path.join(FIXTURES_DIR, "pi-bash-execution.jsonl"), "test-project"),
    );

    const bash = result.messages.find((m) =>
      m.content.some((b) => b.type === "text" && b.text.includes("bash-execution")),
    );
    if (!bash) {
      throw new Error("Expected a bash-execution message");
    }
    expect(bash.role).toBe("user");
    expect(bash.id).toBe("b1");

    const text = (bash.content[0] as TextContentBlock).text;
    expect(text).toContain("<pi:bash-execution>");
    expect(text).toContain("$ ls fart-dir");
    expect(text).toContain("[exit: 0]");
    expect(text).toContain("fart_a.txt");
    expect(text).toContain("</pi:bash-execution>");
  });

  test("warns on unrecognized pi message roles instead of dropping silently", async () => {
    const filePath = path.join(FIXTURES_DIR, "pi-unknown-role.jsonl");
    const outcome = await parsePiSession(filePath, "test-project");
    expectParsed(outcome);

    expect(outcome.warnings).toEqual([
      expect.objectContaining({
        kind: "unknown-message-role",
        parserName: "pi-parser",
        message: '[pi-parser] Unknown message role: "fartEvent"',
        filePath,
        lineNumber: 3,
        count: 1,
        context: "message role",
        type: "fartEvent",
      }),
    ]);

    // The unrecognized-role message is surfaced as a warning, not as content.
    expect(outcome.result?.messages.some((m) => m.id === "x1")).toBe(false);
  });
});
