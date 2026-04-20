import {
  getFirstTextPreview,
  isObjectRecord,
  parseContent,
  readJsonlLines,
  warnSkippedMalformedLines,
  warnUnknownType,
  type RawContentBlock,
} from "./shared.ts";
import {
  MESSAGE_ROLES,
  createAssistantMessage,
  createUserMessage,
  finalizeParseResult,
  isUserContentBlock,
  type CleanMessage,
  type ContentBlock,
  type ParseResult,
} from "./types.ts";

const KNOWN_TYPES = new Set<string>(MESSAGE_ROLES);

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

interface TokenFields {
  tokensIn?: number;
  tokensOut?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

function isOpenCodeRecord(value: unknown): value is OpenCodeRecord {
  return isObjectRecord(value) && typeof value["type"] === "string";
}

function parseOpenCodeJsonLine(line: string): OpenCodeRecord | undefined {
  try {
    const value = JSON.parse(line) as unknown;
    return isOpenCodeRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
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
    state.title = getFirstTextPreview(contentBlocks) ?? state.title;
  }
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
): CleanMessage | undefined {
  const messageDraft = {
    id: record.uuid,
    sessionId: record.sessionId ?? sessionId,
    timestamp: record.timestamp,
    ...(record.parentUuid && { parentId: record.parentUuid }),
    ...(record.message?.model && { model: record.message.model }),
    ...extractTokenFields(record.tokens),
  };

  if (record.type === "user") {
    return createUserMessage(messageDraft, contentBlocks.filter(isUserContentBlock));
  }

  return createAssistantMessage(messageDraft, contentBlocks);
}

export async function parseOpenCodeSession(
  jsonlPath: string,
  project: string,
): Promise<ParseResult | undefined> {
  const lines = readJsonlLines(jsonlPath);

  const messages: CleanMessage[] = [];
  const state: SessionState = {};
  let malformedLines = 0;

  for (const line of lines) {
    const record = parseOpenCodeJsonLine(line);
    if (!record) {
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
    const message = buildOpenCodeMessage(record, state.sessionId, contentBlocks);
    if (message) {
      messages.push(message);
    }
  }

  warnSkippedMalformedLines("opencode-parser", malformedLines, jsonlPath);

  return finalizeParseResult({
    meta: {
      id: state.sessionId,
      source: "opencode",
      project,
      cwd: state.cwd,
      title: state.title,
      model: state.model,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
    },
    messages,
    prLinks: [],
  });
}
