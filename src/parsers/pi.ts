import fs from "node:fs";
import {
  parseContentBlock,
  scrubSecrets,
  warnUnknownType,
  type RawContentBlock,
} from "./shared.ts";
import type {
  AssistantMessage,
  CleanMessage,
  ContentBlock,
  ImageContentBlock,
  ParseResult,
  SessionMeta,
  TextContentBlock,
  ToolResultContentBlock,
  ToolUseContentBlock,
  UserMessage,
} from "./types.ts";

interface PiSessionHeader {
  type: "session";
  version?: number;
  id?: string;
  timestamp?: string;
  cwd?: string;
  parentSession?: string;
}

interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
}

interface PiRawContentBlock extends RawContentBlock {
  type: string;
  mimeType?: string;
  arguments?: Record<string, unknown>;
}

interface PiAgentMessage {
  role?: string;
  content?: string | PiRawContentBlock[];
  provider?: string;
  model?: string;
  usage?: PiUsage;
  toolCallId?: string;
  toolName?: string;
}

interface PiMessageEntry {
  type: "message";
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  message?: PiAgentMessage;
}

interface PiGenericEntry {
  type?: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  message?: PiAgentMessage;
  modelId?: string;
  name?: string;
  cwd?: string;
  parentSession?: string;
}

interface SessionState {
  sessionId?: string;
  cwd?: string;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  model?: string;
  parentSessionId?: string;
}

function parsePiContent(
  content: string | PiRawContentBlock[] | undefined,
  parserName: string,
): ContentBlock[] {
  if (!content) {
    return [];
  }

  if (typeof content === "string") {
    return [{ type: "text", text: scrubSecrets(content) }];
  }

  const blocks: ContentBlock[] = [];
  for (const block of content) {
    if (block.type === "thinking") {
      continue;
    }

    if (block.type === "toolCall") {
      blocks.push({
        type: "tool_use",
        toolName: block.name,
        toolInput: block.arguments ? scrubSecrets(JSON.stringify(block.arguments)) : undefined,
      } satisfies ToolUseContentBlock);
      continue;
    }

    if (block.type === "image") {
      blocks.push({
        type: "image",
        mediaType: block.mimeType,
      } satisfies ImageContentBlock);
      continue;
    }

    const parsed = parseContentBlock(block, parserName);
    if (parsed) {
      blocks.push(parsed);
    }
  }

  return blocks;
}

function buildPiToolResultContent(
  content: string | PiRawContentBlock[] | undefined,
): ContentBlock[] {
  if (!content) {
    return [];
  }

  if (typeof content === "string") {
    return [{ type: "tool_result", toolOutput: scrubSecrets(content) }];
  }

  const textParts: string[] = [];
  const images: ImageContentBlock[] = [];

  for (const block of content) {
    if (block.type === "text" && block.text) {
      textParts.push(scrubSecrets(block.text));
    } else if (block.type === "image") {
      images.push({ type: "image", mediaType: block.mimeType });
    } else if (block.type !== "thinking") {
      warnUnknownType(block.type, "content block", "pi-parser");
    }
  }

  const blocks: ContentBlock[] = [];
  if (textParts.length > 0) {
    blocks.push({ type: "tool_result", toolOutput: textParts.join("\n") });
  }
  blocks.push(...images);
  return blocks;
}

function extractTokenFields(message: PiAgentMessage | undefined) {
  return {
    ...(message?.usage?.input !== undefined && { tokensIn: message.usage.input }),
    ...(message?.usage?.output !== undefined && { tokensOut: message.usage.output }),
    ...(message?.usage?.cacheRead !== undefined && {
      cacheReadTokens: message.usage.cacheRead,
    }),
    ...(message?.usage?.cacheWrite !== undefined && {
      cacheWriteTokens: message.usage.cacheWrite,
    }),
    ...(message?.usage?.reasoning !== undefined && {
      reasoningTokens: message.usage.reasoning,
    }),
  };
}

function updateStateFromHeader(state: SessionState, header: PiSessionHeader) {
  state.sessionId = header.id ?? state.sessionId;
  state.cwd = header.cwd ?? state.cwd;
  state.createdAt = header.timestamp ?? state.createdAt;
  state.updatedAt = header.timestamp ?? state.updatedAt;
  state.parentSessionId = header.parentSession ?? state.parentSessionId;
}

function updateStateFromEntry(
  state: SessionState,
  entry: PiGenericEntry,
  contentBlocks: ContentBlock[],
): void {
  if (entry.timestamp) {
    state.updatedAt = entry.timestamp;
  }
  if (entry.type === "model_change" && entry.modelId) {
    state.model = entry.modelId;
  }
  if (entry.type === "session_info" && entry.name) {
    state.title = entry.name;
  }
  if (!state.model && entry.message?.model) {
    state.model = entry.message.model;
  }
  if (!state.title && entry.message?.role === "user") {
    const firstText = contentBlocks.find((block) => block.type === "text");
    if (firstText && firstText.type === "text") {
      state.title = firstText.text.slice(0, 200);
    }
  }
}

function buildPiMessage(
  entry: PiMessageEntry,
  sessionId: string,
  content: ContentBlock[],
): CleanMessage | undefined {
  const role = entry.message?.role;
  if (!role) {
    return undefined;
  }

  const baseMessage = {
    id: entry.id ?? "",
    sessionId,
    timestamp: entry.timestamp ?? "",
    ...(entry.parentId && { parentId: entry.parentId }),
    ...(entry.message?.model && { model: entry.message.model }),
    ...extractTokenFields(entry.message),
  };

  if (role === "user") {
    return {
      ...baseMessage,
      role: "user",
      content: content.filter(
        (block): block is TextContentBlock | ToolResultContentBlock | ImageContentBlock =>
          block.type === "text" || block.type === "tool_result" || block.type === "image",
      ),
    } satisfies UserMessage;
  }

  if (role === "assistant") {
    return {
      ...baseMessage,
      role: "assistant",
      content,
    } satisfies AssistantMessage;
  }

  if (role === "toolResult") {
    return {
      ...baseMessage,
      role: "user",
      content: content.filter(
        (block): block is ToolResultContentBlock | ImageContentBlock =>
          block.type === "tool_result" || block.type === "image",
      ),
    } satisfies UserMessage;
  }

  return undefined;
}

function parsePiJsonLine(line: string): PiGenericEntry | undefined {
  try {
    return JSON.parse(line) as PiGenericEntry;
  } catch {
    return undefined;
  }
}

function isPiMessageRole(role: string | undefined): role is "user" | "assistant" | "toolResult" {
  return role === "user" || role === "assistant" || role === "toolResult";
}

function parsePiMessageContent(entry: PiGenericEntry, role: "user" | "assistant" | "toolResult") {
  return role === "toolResult"
    ? buildPiToolResultContent(entry.message?.content)
    : parsePiContent(entry.message?.content, "pi-parser");
}

function hasPiUsage(entry: PiGenericEntry): boolean {
  return (entry.message?.usage?.input ?? 0) > 0 || (entry.message?.usage?.output ?? 0) > 0;
}

function parsePiEntry(
  line: string,
  state: SessionState,
): { malformed: boolean; message?: CleanMessage } {
  const entry = parsePiJsonLine(line);
  if (!entry) {
    return { malformed: true };
  }

  if (entry.type === "session") {
    updateStateFromHeader(state, entry as PiSessionHeader);
    return { malformed: false };
  }

  if (entry.type === "model_change" || entry.type === "session_info") {
    updateStateFromEntry(state, entry, []);
    return { malformed: false };
  }

  if (entry.type !== "message" || !isPiMessageRole(entry.message?.role)) {
    return { malformed: false };
  }

  const parsedContent = parsePiMessageContent(entry, entry.message.role);
  updateStateFromEntry(state, entry, parsedContent);

  if (parsedContent.length === 0 && !hasPiUsage(entry)) {
    return { malformed: false };
  }

  return {
    malformed: false,
    message: buildPiMessage(entry as PiMessageEntry, state.sessionId ?? "", parsedContent),
  };
}

export async function parsePiSession(jsonlPath: string, project: string): Promise<ParseResult> {
  const content = fs.readFileSync(jsonlPath, "utf-8");
  const lines = content.trim().split("\n").filter(Boolean);

  const messages: CleanMessage[] = [];
  const state: SessionState = {};
  let malformedLines = 0;

  for (const line of lines) {
    const result = parsePiEntry(line, state);
    if (result.malformed) {
      malformedLines++;
      continue;
    }
    if (result.message) {
      messages.push(result.message);
    }
  }

  if (malformedLines > 0) {
    console.warn(`[pi-parser] Skipped ${malformedLines} malformed line(s) in ${jsonlPath}`);
  }

  const meta: SessionMeta = {
    id: state.sessionId ?? "",
    source: "pi",
    project,
    cwd: state.cwd,
    title: state.title,
    model: state.model,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    parentSessionId: state.parentSessionId,
  };

  return { meta, messages, prLinks: [] };
}
