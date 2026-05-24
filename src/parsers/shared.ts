import fs from "node:fs";
import type {
  ContentBlock,
  ContentBlockType,
  ParseWarning,
  ParseWarningKind,
  DocumentContentBlock,
  ImageContentBlock,
  RedactedThinkingContentBlock,
  TextContentBlock,
  ThinkingContentBlock,
  ToolResultContentBlock,
  ToolUseContentBlock,
} from "./types.ts";
import { CONTENT_BLOCK_TYPES } from "./types.ts";

const seenUnknownTypes = new Set<string>();

interface WarningDraft {
  kind: ParseWarningKind;
  message: string;
  lineNumber?: number;
  count?: number;
  context?: string;
  type?: string;
}

export class ParseWarningCollector {
  private readonly warnings: ParseWarning[] = [];
  private readonly warningIndexes = new Map<string, number>();

  constructor(
    private readonly parserName: string,
    private readonly filePath: string,
  ) {}

  add(draft: WarningDraft): void {
    const key = [draft.kind, draft.context ?? "", draft.type ?? "", draft.message].join("\0");
    const existingIndex = this.warningIndexes.get(key);
    if (existingIndex !== undefined) {
      const existing = this.warnings[existingIndex];
      if (existing) {
        existing.count = (existing.count ?? 1) + 1;
      }
      return;
    }

    this.warningIndexes.set(key, this.warnings.length);
    this.warnings.push({
      parserName: this.parserName,
      filePath: this.filePath,
      count: 1,
      ...draft,
    });
  }

  unknownType(type: string, context: string, lineNumber?: number): void {
    const kind = `unknown-${context.replaceAll(" ", "-")}-type` as ParseWarningKind;
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
    return this.warnings.map((warning) => ({ ...warning }));
  }
}

export function readJsonlLines(jsonlPath: string): string[] {
  return fs.readFileSync(jsonlPath, "utf-8").trim().split("\n").filter(Boolean);
}

export function warnSkippedMalformedLines(
  parserName: string,
  malformedLines: number,
  jsonlPath: string,
) {
  if (malformedLines > 0) {
    console.warn(`[${parserName}] Skipped ${malformedLines} malformed line(s) in ${jsonlPath}`);
  }
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

export function warnUnknownType(
  type: string,
  context: string,
  parserName: string,
  collector?: ParseWarningCollector,
  lineNumber?: number,
) {
  if (collector) {
    collector.unknownType(type, context, lineNumber);
    return;
  }

  const key = `${context}:${type}`;
  if (!seenUnknownTypes.has(key)) {
    seenUnknownTypes.add(key);
    console.warn(`[${parserName}] Unknown ${context} type: "${type}"`);
  }
}

const KNOWN_CONTENT_TYPES = new Set<string>(CONTENT_BLOCK_TYPES);

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
  parserName: string,
  collector?: ParseWarningCollector,
  lineNumber?: number,
) => ContentBlock | undefined;

function isKnownContentBlockType(type: string): type is ContentBlockType {
  return KNOWN_CONTENT_TYPES.has(type);
}

function parseTextBlock(block: RawContentBlock): TextContentBlock | undefined {
  return block.text ? { type: "text", text: block.text } : undefined;
}

function parseToolUseBlock(
  block: RawContentBlock,
  parserName: string,
  collector?: ParseWarningCollector,
  lineNumber?: number,
): ToolUseContentBlock | undefined {
  if (!block.name) {
    if (collector) {
      collector.missingField("tool_use block missing name", lineNumber);
    } else {
      console.warn(`[${parserName}] tool_use block missing name`);
    }
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
  parserName: string,
  collector?: ParseWarningCollector,
  lineNumber?: number,
): ToolResultContentBlock | undefined {
  const output = block.content;
  const raw = typeof output === "string" ? output : stringifyJson(output);

  if (raw === undefined) {
    if (collector) {
      collector.missingField("tool_result block missing content", lineNumber);
    } else {
      console.warn(`[${parserName}] tool_result block missing content`);
    }
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

export function parseContentBlock(
  block: RawContentBlock,
  parserName: string,
  skipTypes?: Set<string>,
  collector?: ParseWarningCollector,
  lineNumber?: number,
): ContentBlock | undefined {
  if (skipTypes?.has(block.type)) {
    return undefined;
  }

  if (isKnownContentBlockType(block.type)) {
    return CONTENT_BLOCK_PARSERS[block.type](block, parserName, collector, lineNumber);
  }

  warnUnknownType(block.type, "content block", parserName, collector, lineNumber);
  return undefined;
}

export function parseContent(
  content: string | RawContentBlock[] | undefined,
  parserName: string,
  skipTypes?: Set<string>,
  collector?: ParseWarningCollector,
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
    const parsed = parseContentBlock(block, parserName, skipTypes, collector, lineNumber);
    if (parsed) {
      blocks.push(parsed);
    }
  }
  return blocks;
}
