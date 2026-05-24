import fs from "node:fs";
import type {
  ContentBlock,
  ContentBlockType,
  DocumentContentBlock,
  ImageContentBlock,
  ParseWarning,
  ParseWarningKind,
  RedactedThinkingContentBlock,
  TextContentBlock,
  ThinkingContentBlock,
  ToolResultContentBlock,
  ToolUseContentBlock,
  UnknownWarningContext,
} from "./types.ts";
import { CONTENT_BLOCK_TYPES } from "./types.ts";

const UNKNOWN_KIND_BY_CONTEXT: Record<UnknownWarningContext, ParseWarningKind> = {
  record: "unknown-record-type",
  "content block": "unknown-content-block-type",
};

interface WarningDraft {
  kind: ParseWarningKind;
  message: string;
  lineNumber?: number;
  count?: number;
  context?: UnknownWarningContext;
  type?: string;
}

export class ParseLineContext {
  constructor(
    private readonly collector: ParseWarningCollector,
    readonly lineNumber: number,
  ) {}

  missingField(message: string): void {
    this.collector.missingField(message, this.lineNumber);
  }

  unknownType(type: string, context: UnknownWarningContext): void {
    this.collector.unknownType(type, context, this.lineNumber);
  }

  parseContent(
    content: string | RawContentBlock[] | undefined,
    skipTypes?: Set<string>,
  ): ContentBlock[] {
    return parseContentImpl(content, this.collector, skipTypes, this.lineNumber);
  }

  parseContentBlock(block: RawContentBlock, skipTypes?: Set<string>): ContentBlock | undefined {
    return parseContentBlockImpl(block, this.collector, skipTypes, this.lineNumber);
  }
}

export class ParseWarningCollector {
  private readonly warnings: ParseWarning[] = [];
  private readonly warningIndexes = new Map<string, number>();

  constructor(
    readonly parserName: string,
    private readonly filePath: string,
  ) {}

  line(lineNumber: number): ParseLineContext {
    return new ParseLineContext(this, lineNumber);
  }

  add(draft: WarningDraft): void {
    const key = [draft.kind, draft.context ?? "", draft.type ?? "", draft.message].join("\0");
    const existingIndex = this.warningIndexes.get(key);
    if (existingIndex !== undefined) {
      this.warnings[existingIndex].count = (this.warnings[existingIndex].count ?? 1) + 1;
      return;
    }

    this.warningIndexes.set(key, this.warnings.length);
    this.warnings.push({
      ...draft,
      parserName: this.parserName,
      filePath: this.filePath,
      count: 1,
    });
  }

  unknownType(type: string, context: UnknownWarningContext, lineNumber?: number): void {
    const kind = UNKNOWN_KIND_BY_CONTEXT[context];
    this.add({
      kind,
      message: `[${this.parserName}] Unknown ${context} type: "${type}"`,
      lineNumber,
      context,
      type,
    });
  }

  malformedLines(count: number): void {
    if (count <= 0) {
      return;
    }

    this.add({
      kind: "malformed-lines",
      message: `[${this.parserName}] Skipped ${count} malformed line(s)`,
      count,
    });
  }

  missingField(message: string, lineNumber?: number): void {
    this.add({
      kind: "missing-field",
      message: `[${this.parserName}] ${message}`,
      lineNumber,
    });
  }

  toArray(): ParseWarning[] {
    return this.warnings.map((w) => ({ ...w }));
  }
}

export function readJsonlLines(jsonlPath: string): string[] {
  return fs.readFileSync(jsonlPath, "utf-8").trim().split("\n").filter(Boolean);
}

export function getFirstTextPreview(
  contentBlocks: readonly ContentBlock[],
  maxLength: number = 200,
): string | undefined {
  const firstText = contentBlocks.find((block) => block.type === "text");
  if (!firstText || firstText.type !== "text") {
    return undefined;
  }
  return firstText.text.slice(0, maxLength);
}

export interface RawContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  source?: { type?: string; media_type?: string; data?: string };
}

export function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringifyJson(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return JSON.stringify(value);
}

type ContentBlockParser = (
  block: RawContentBlock,
  collector: ParseWarningCollector,
  lineNumber?: number,
) => ContentBlock | undefined;

const KNOWN_CONTENT_TYPES = new Set<string>(CONTENT_BLOCK_TYPES);

function isKnownContentBlockType(type: string): type is ContentBlockType {
  return KNOWN_CONTENT_TYPES.has(type);
}

function parseTextBlock(block: RawContentBlock): TextContentBlock | undefined {
  return block.text ? { type: "text", text: block.text } : undefined;
}

function parseToolUseBlock(
  block: RawContentBlock,
  collector: ParseWarningCollector,
  lineNumber?: number,
): ToolUseContentBlock | undefined {
  if (!block.name) {
    collector.missingField("tool_use block missing name", lineNumber);
    return undefined;
  }

  return {
    type: "tool_use",
    toolName: block.name,
    toolInput: stringifyJson(block.input),
    ...(block.id && { toolUseId: block.id }),
  } satisfies ToolUseContentBlock;
}

function parseToolResultBlock(
  block: RawContentBlock,
  collector: ParseWarningCollector,
  lineNumber?: number,
): ToolResultContentBlock | undefined {
  const output = block.content;
  const raw = typeof output === "string" ? output : stringifyJson(output);

  if (raw === undefined) {
    collector.missingField("tool_result block missing content", lineNumber);
    return undefined;
  }

  return {
    type: "tool_result",
    toolOutput: raw,
    ...(block.tool_use_id && { toolUseId: block.tool_use_id }),
  } satisfies ToolResultContentBlock;
}

function parseThinkingBlock(
  block: RawContentBlock,
): ThinkingContentBlock | RedactedThinkingContentBlock {
  if (block.thinking) {
    return {
      type: "thinking",
      thinking: block.thinking,
    } satisfies ThinkingContentBlock;
  }
  return { type: "redacted_thinking" } satisfies RedactedThinkingContentBlock;
}

function parseRedactedThinkingBlock(): RedactedThinkingContentBlock {
  return { type: "redacted_thinking" };
}

function parseImageBlock(block: RawContentBlock): ImageContentBlock {
  return {
    type: "image",
    mediaType: block.source?.media_type,
  };
}

function parseDocumentBlock(block: RawContentBlock): DocumentContentBlock {
  return {
    type: "document",
    mediaType: block.source?.media_type,
  };
}

const CONTENT_BLOCK_PARSERS = {
  text: parseTextBlock,
  tool_use: parseToolUseBlock,
  tool_result: parseToolResultBlock,
  thinking: parseThinkingBlock,
  redacted_thinking: parseRedactedThinkingBlock,
  image: parseImageBlock,
  document: parseDocumentBlock,
} satisfies Record<ContentBlockType, ContentBlockParser>;

function parseContentBlockImpl(
  block: RawContentBlock,
  collector: ParseWarningCollector,
  skipTypes?: Set<string>,
  lineNumber?: number,
): ContentBlock | undefined {
  if (skipTypes?.has(block.type)) {
    return undefined;
  }

  if (isKnownContentBlockType(block.type)) {
    return CONTENT_BLOCK_PARSERS[block.type](block, collector, lineNumber);
  }

  collector.unknownType(block.type, "content block", lineNumber);
  return undefined;
}

function parseContentImpl(
  content: string | RawContentBlock[] | undefined,
  collector: ParseWarningCollector,
  skipTypes?: Set<string>,
  lineNumber?: number,
): ContentBlock[] {
  if (!content) {
    return [];
  }

  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }

  const blocks: ContentBlock[] = [];
  for (const block of content) {
    const parsed = parseContentBlockImpl(block, collector, skipTypes, lineNumber);
    if (parsed) {
      blocks.push(parsed);
    }
  }
  return blocks;
}

/**
 * Standalone content-block parse with warnings replayed to console.warn.
 * For session parsing, use ParseWarningCollector.line(n).parseContentBlock() instead.
 */
export function parseContentBlock(
  block: RawContentBlock,
  parserName: string,
  skipTypes?: Set<string>,
): ContentBlock | undefined {
  const collector = new ParseWarningCollector(parserName, "");
  const result = parseContentBlockImpl(block, collector, skipTypes);
  for (const w of collector.toArray()) {
    console.warn(w.message);
  }
  return result;
}
