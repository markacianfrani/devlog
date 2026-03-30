import type {
  ContentBlock,
  ImageContentBlock,
  TextContentBlock,
  ThinkingContentBlock,
  ToolResultContentBlock,
  ToolUseContentBlock,
} from "./types.ts";

const seenUnknownTypes = new Set<string>();

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/sk-ant-[A-Za-z0-9_-]{20,}/g, "[REDACTED:anthropic-key]"],
  [/sk-[A-Za-z0-9]{48}/g, "[REDACTED:openai-key]"],
  [/AKIA[0-9A-Z]{16}/g, "[REDACTED:aws-key]"],
  [/-----BEGIN [\w ]+ KEY-----[\s\S]+?-----END [\w ]+ KEY-----/g, "[REDACTED:private-key]"],
  [/\bBearer\s+[A-Za-z0-9+/=._-]{20,}/g, "Bearer [REDACTED]"],
  [/\bBasic\s+[A-Za-z0-9+/=]{20,}/g, "Basic [REDACTED]"],
  // env-var assignments whose names suggest a secret
  [
    /((?:API_?KEY|AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL)S?["']?\s*[=:]\s*["']?)([A-Za-z0-9+/._~-]{16,})(['";,\s]|$)/gi,
    "$1[REDACTED]$3",
  ],
];

export function scrubSecrets(text: string): string {
  let result = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

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
  content?: string;
  source?: { type?: string; media_type?: string; data?: string };
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
    return { type: "text", text: scrubSecrets(block.text) } satisfies TextContentBlock;
  }

  if (block.type === "tool_use") {
    const raw = block.input ? JSON.stringify(block.input) : undefined;
    return {
      type: "tool_use",
      toolName: block.name,
      toolInput: raw ? scrubSecrets(raw) : undefined,
    } satisfies ToolUseContentBlock;
  }

  if (block.type === "tool_result") {
    const output = block.content;
    const raw = typeof output === "string" ? output : JSON.stringify(output);
    return {
      type: "tool_result",
      toolOutput: scrubSecrets(raw),
    } satisfies ToolResultContentBlock;
  }

  if (block.type === "thinking" && block.thinking) {
    return {
      type: "thinking",
      thinking: scrubSecrets(block.thinking),
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
