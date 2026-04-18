import type {
  ContentBlock,
  ImageContentBlock,
  TextContentBlock,
  ThinkingContentBlock,
  ToolResultContentBlock,
  ToolUseContentBlock,
} from "./types.ts";

const seenUnknownTypes = new Set<string>();

export function warnUnknownType(type: string, context: string, parserName: string) {
  const key = `${context}:${type}`;
  if (!seenUnknownTypes.has(key)) {
    seenUnknownTypes.add(key);
    console.warn(`[${parserName}] Unknown ${context} type: "${type}"`);
  }
}

const KNOWN_CONTENT_TYPES = new Set(["text", "tool_use", "tool_result", "thinking", "image"]);

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
    return {
      type: "tool_use",
      toolName: block.name,
      toolInput: stringifyJson(block.input),
    } satisfies ToolUseContentBlock;
  }

  if (block.type === "tool_result") {
    const output = block.content;
    const raw = typeof output === "string" ? output : stringifyJson(output);
    return {
      type: "tool_result",
      toolOutput: raw,
    } satisfies ToolResultContentBlock;
  }

  if (block.type === "thinking" && block.thinking) {
    return {
      type: "thinking",
      thinking: block.thinking,
    } satisfies ThinkingContentBlock;
  }

  if (block.type === "image") {
    return {
      type: "image",
      mediaType: block.source?.media_type,
    } satisfies ImageContentBlock;
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
