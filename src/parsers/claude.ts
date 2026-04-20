import path from "node:path";
import {
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
  createPrLink,
  createUserMessage,
  finalizeParseResult,
  isUserContentBlock,
  type CleanMessage,
  type ContentBlock,
  type ParseResult,
  type PrLink,
} from "./types.ts";

const SKIP_TYPES = new Set([
  "progress",
  "file-history-snapshot",
  "summary",
  "custom-title",
  "system",
  "queue-operation",
  "last-prompt",
  "agent-name",
  "permission-mode",
  "attachment",
]);
const KNOWN_TYPES = new Set([...SKIP_TYPES, ...MESSAGE_ROLES, "pr-link"]);

interface ClaudeRecord {
  type: string;
  sessionId?: string;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  cwd?: string;
  isMeta?: boolean;
  agentId?: string;
  summary?: string;
  customTitle?: string;
  leafUuid?: string;
  prNumber?: number;
  prUrl?: string;
  prRepository?: string;
  message?: {
    role?: string;
    model?: string;
    content?: string | RawContentBlock[];
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
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

function isClaudeRecord(value: unknown): value is ClaudeRecord {
  return isObjectRecord(value) && typeof value["type"] === "string";
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Claude Code subagent transcripts live at <parent-uuid>/subagents/<agent>.jsonl.
// Archive preserves that layout, so we can recover parent linkage from the path.
function extractParentSessionIdFromPath(jsonlPath: string): string | undefined {
  const parts = jsonlPath.split(path.sep);
  const subagentsIndex = parts.lastIndexOf("subagents");
  if (subagentsIndex < 1) {
    return undefined;
  }
  const candidate = parts[subagentsIndex - 1];
  return UUID_PATTERN.test(candidate) ? candidate : undefined;
}

function parseClaudeJsonLine(line: string): ClaudeRecord | undefined {
  try {
    const value = JSON.parse(line) as unknown;
    return isClaudeRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

// Returns "skip" if the record should not produce a message.
// Mutates state.title when record.type === "summary".
function classifyClaudeRecord(record: ClaudeRecord, state: SessionState): "skip" | "process" {
  if (record.type === "summary" && record.summary) {
    state.title = record.summary;
    return "skip";
  }
  if (record.type === "custom-title" && record.customTitle) {
    state.title = record.customTitle;
    return "skip";
  }
  if (SKIP_TYPES.has(record.type) || record.isMeta) {
    return "skip";
  }
  if (record.type !== "user" && record.type !== "assistant") {
    if (!KNOWN_TYPES.has(record.type)) {
      warnUnknownType(record.type, "record", "claude-parser");
    }
    return "skip";
  }
  return "process";
}

function updateSessionState(state: SessionState, record: ClaudeRecord): void {
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
}

function buildClaudeMessage(
  record: ClaudeRecord,
  sessionId: string | undefined,
  contentBlocks: ContentBlock[],
): CleanMessage | undefined {
  const usage = record.message?.usage;
  const messageDraft = {
    id: record.uuid,
    sessionId: record.sessionId ?? sessionId,
    timestamp: record.timestamp,
    ...(record.parentUuid && { parentId: record.parentUuid }),
    ...(record.message?.model && { model: record.message.model }),
    ...(record.agentId && { agentId: record.agentId }),
    ...(usage?.input_tokens !== undefined && { tokensIn: usage.input_tokens }),
    ...(usage?.output_tokens !== undefined && { tokensOut: usage.output_tokens }),
    ...(usage?.cache_read_input_tokens !== undefined && {
      cacheReadTokens: usage.cache_read_input_tokens,
    }),
    ...(usage?.cache_creation_input_tokens !== undefined && {
      cacheWriteTokens: usage.cache_creation_input_tokens,
    }),
  };

  if (record.type === "user") {
    return createUserMessage(messageDraft, contentBlocks.filter(isUserContentBlock));
  }

  return createAssistantMessage(messageDraft, contentBlocks);
}

function collectPrLink(record: ClaudeRecord, prLinkMap: Map<string, PrLink>): void {
  const link = createPrLink({
    sessionId: record.sessionId,
    prNumber: record.prNumber,
    prUrl: record.prUrl,
    prRepository: record.prRepository,
    timestamp: record.timestamp,
  });

  if (link) {
    prLinkMap.set(link.prUrl, link);
  }
}

export async function parseClaudeSession(
  jsonlPath: string,
  project: string,
): Promise<ParseResult | undefined> {
  const lines = readJsonlLines(jsonlPath);

  const messageMap = new Map<string, CleanMessage>();
  const messageOrder: string[] = [];
  const prLinkMap = new Map<string, PrLink>();
  const state: SessionState = {};
  let malformedLines = 0;

  for (const line of lines) {
    const record = parseClaudeJsonLine(line);
    if (!record) {
      malformedLines++;
      continue;
    }

    if (record.type === "pr-link") {
      collectPrLink(record, prLinkMap);
      continue;
    }

    if (classifyClaudeRecord(record, state) === "skip") {
      continue;
    }

    updateSessionState(state, record);

    const contentBlocks = parseContent(record.message?.content, "claude-parser");
    const usage = record.message?.usage;
    const hasUsage = (usage?.input_tokens ?? 0) > 0 || (usage?.output_tokens ?? 0) > 0;
    if (contentBlocks.length === 0 && !hasUsage) {
      continue;
    }

    const msg = buildClaudeMessage(record, state.sessionId, contentBlocks);
    if (!msg) {
      continue;
    }

    if (!messageMap.has(msg.id)) {
      messageOrder.push(msg.id);
    }
    messageMap.set(msg.id, msg);
  }

  const messages = messageOrder.flatMap((id) => {
    const msg = messageMap.get(id);
    return msg ? [msg] : [];
  });

  warnSkippedMalformedLines("claude-parser", malformedLines, jsonlPath);

  return finalizeParseResult({
    meta: {
      id: state.sessionId,
      source: "claude",
      project,
      cwd: state.cwd,
      title: state.title,
      model: state.model,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      parentSessionId: extractParentSessionIdFromPath(jsonlPath),
    },
    messages,
    prLinks: [...prLinkMap.values()],
  });
}
