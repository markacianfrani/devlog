import fs from "node:fs";
import { parseContent, warnUnknownType, type RawContentBlock } from "./shared.ts";
import type {
  AssistantMessage,
  CleanMessage,
  ContentBlock,
  ImageContentBlock,
  ParseResult,
  SessionMeta,
  TextContentBlock,
  ToolResultContentBlock,
  UserMessage,
} from "./types.ts";

const KNOWN_TYPES = new Set(["user", "assistant"]);

interface OpenCodeRecord {
  type: string;
  sessionId?: string;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  cwd?: string;
  provider?: string;
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: {
      read?: number;
      write?: number;
    };
  };
  message?: {
    role?: string;
    model?: string;
    content?: string | RawContentBlock[];
  };
}

interface SessionState {
  sessionId?: string;
  cwd?: string;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  model?: string;
}

function shouldSkipOpenCodeRecord(record: OpenCodeRecord): boolean {
  if (record.type !== "user" && record.type !== "assistant") {
    if (!KNOWN_TYPES.has(record.type)) {
      warnUnknownType(record.type, "record", "opencode-parser");
    }
    return true;
  }
  return false;
}

function updateSessionState(
  state: SessionState,
  record: OpenCodeRecord,
  contentBlocks: ContentBlock[],
): void {
  if (!state.sessionId && record.sessionId) {
    state.sessionId = record.sessionId;
  }
  if (!state.cwd && record.cwd) {
    state.cwd = record.cwd;
  }
  if (!state.createdAt && record.timestamp) {
    state.createdAt = record.timestamp;
  }
  if (record.timestamp) {
    state.updatedAt = record.timestamp;
  }
  if (!state.model && record.message?.model) {
    state.model = record.message.model;
  }
  if (!state.title && record.type === "user") {
    const firstText = contentBlocks.find((b) => b.type === "text");
    if (firstText && firstText.type === "text") {
      state.title = firstText.text.slice(0, 200);
    }
  }
}

interface TokenFields {
  tokensIn?: number;
  tokensOut?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

function extractTokenFields(tokens: OpenCodeRecord["tokens"]): TokenFields {
  const fields: TokenFields = {};
  if (tokens?.input !== undefined) {
    fields.tokensIn = tokens.input;
  }
  if (tokens?.output !== undefined) {
    fields.tokensOut = tokens.output;
  }
  if (tokens?.reasoning !== undefined) {
    fields.reasoningTokens = tokens.reasoning;
  }
  if (tokens?.cache?.read !== undefined) {
    fields.cacheReadTokens = tokens.cache.read;
  }
  if (tokens?.cache?.write !== undefined) {
    fields.cacheWriteTokens = tokens.cache.write;
  }
  return fields;
}

function buildOpenCodeMessage(
  record: OpenCodeRecord,
  sessionId: string | undefined,
  contentBlocks: ContentBlock[],
): CleanMessage {
  const baseMsg = {
    id: record.uuid ?? "",
    sessionId: record.sessionId ?? sessionId ?? "",
    timestamp: record.timestamp ?? "",
    ...(record.parentUuid && { parentId: record.parentUuid }),
    ...(record.message?.model && { model: record.message.model }),
    ...extractTokenFields(record.tokens),
  };

  if (record.type === "user") {
    return {
      ...baseMsg,
      role: "user",
      content: contentBlocks.filter(
        (b): b is TextContentBlock | ToolResultContentBlock | ImageContentBlock =>
          b.type === "text" || b.type === "tool_result" || b.type === "image",
      ),
    } satisfies UserMessage;
  }

  return {
    ...baseMsg,
    role: "assistant",
    content: contentBlocks,
  } satisfies AssistantMessage;
}

export async function parseOpenCodeSession(
  jsonlPath: string,
  project: string,
): Promise<ParseResult> {
  const content = fs.readFileSync(jsonlPath, "utf-8");
  const lines = content.trim().split("\n").filter(Boolean);

  const messages: CleanMessage[] = [];
  const state: SessionState = {};
  let malformedLines = 0;

  for (const line of lines) {
    let record: OpenCodeRecord;
    try {
      record = JSON.parse(line);
    } catch {
      malformedLines++;
      continue;
    }

    if (shouldSkipOpenCodeRecord(record)) {
      continue;
    }

    const contentBlocks = parseContent(record.message?.content, "opencode-parser");
    if (contentBlocks.length === 0) {
      continue;
    }

    updateSessionState(state, record, contentBlocks);
    messages.push(buildOpenCodeMessage(record, state.sessionId, contentBlocks));
  }

  if (malformedLines > 0) {
    console.warn(`[opencode-parser] Skipped ${malformedLines} malformed line(s) in ${jsonlPath}`);
  }

  const meta: SessionMeta = {
    id: state.sessionId ?? "",
    source: "opencode",
    project,
    cwd: state.cwd,
    title: state.title,
    model: state.model,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
  };

  return { meta, messages, prLinks: [] };
}
