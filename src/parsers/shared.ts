import fs from "node:fs";
import type {
  ContentBlock,
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

export function warnUnknownType(type: string, context: string, parserName: string) {
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

export function parseContentBlock(
  block: RawContentBlock,
  parserName: string,
  skipTypes?: Set<string>,
): ContentBlock | undefined {
  if (skipTypes?.has(block.type)) {
    return undefined;
  }

  if (block.type === "text" && block.text) {
    return { type: "text", text: block.text } satisfies TextContentBlock;
  }

  if (block.type === "tool_use") {
    if (!block.name) {
      console.warn(`[${parserName}] tool_use block missing name`);
      return undefined;
    }

    return {
      type: "tool_use",
      toolName: block.name,
      toolInput: stringifyJson(block.input),
      ...(block.id && { toolUseId: block.id }),
    } satisfies ToolUseContentBlock;
  }

  if (block.type === "tool_result") {
    const output = block.content;
    const raw = typeof output === "string" ? output : stringifyJson(output);

    if (raw === undefined) {
      console.warn(`[${parserName}] tool_result block missing content`);
      return undefined;
    }

    return {
      type: "tool_result",
      toolOutput: raw,
      ...(block.tool_use_id && { toolUseId: block.tool_use_id }),
    } satisfies ToolResultContentBlock;
  }

  if (block.type === "thinking") {
    if (block.thinking) {
      return {
        type: "thinking",
        thinking: block.thinking,
      } satisfies ThinkingContentBlock;
    }
    return { type: "redacted_thinking" } satisfies RedactedThinkingContentBlock;
  }

  if (block.type === "redacted_thinking") {
    return { type: "redacted_thinking" } satisfies RedactedThinkingContentBlock;
  }

  if (block.type === "image") {
    return {
      type: "image",
      mediaType: block.source?.media_type,
    } satisfies ImageContentBlock;
  }

  if (block.type === "document") {
    return {
      type: "document",
      mediaType: block.source?.media_type,
    } satisfies DocumentContentBlock;
  }

  if (!KNOWN_CONTENT_TYPES.has(block.type) && !skipTypes?.has(block.type)) {
    warnUnknownType(block.type, "content block", parserName);
  }

  return undefined;
}

export function parseContent(
  content: string | RawContentBlock[] | undefined,
  parserName: string,
  skipTypes?: Set<string>,
): ContentBlock[] {
  if (!content) {
    return [];
  }

  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }

  const blocks: ContentBlock[] = [];
  for (const block of content) {
    const parsed = parseContentBlock(block, parserName, skipTypes);
    if (parsed) {
      blocks.push(parsed);
    }
  }
  return blocks;
}
