import fs from "node:fs";
import { parseContent, warnUnknownType, type RawContentBlock } from "./shared.ts";
import type {
  AssistantMessage,
  CleanMessage,
  ContentBlock,
  ImageContentBlock,
  ParseResult,
  PrLink,
  SessionMeta,
  TextContentBlock,
  ToolResultContentBlock,
  UserMessage,
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
const KNOWN_TYPES = new Set([...SKIP_TYPES, "user", "assistant", "pr-link"]);

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
): CleanMessage {
  const usage = record.message?.usage;
  const baseMsg = {
    id: record.uuid ?? "",
    sessionId: record.sessionId ?? sessionId ?? "",
    timestamp: record.timestamp ?? "",
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

function collectPrLink(record: ClaudeRecord, prLinkMap: Map<string, PrLink>): void {
  if (record.prUrl) {
    prLinkMap.set(record.prUrl, {
      sessionId: record.sessionId ?? "",
      prNumber: record.prNumber ?? 0,
      prUrl: record.prUrl,
      prRepository: record.prRepository ?? "",
      timestamp: record.timestamp ?? "",
    });
  }
}

export async function parseClaudeSession(jsonlPath: string, project: string): Promise<ParseResult> {
  const content = fs.readFileSync(jsonlPath, "utf-8");
  const lines = content.trim().split("\n").filter(Boolean);

  const messageMap = new Map<string, CleanMessage>();
  const messageOrder: string[] = [];
  const prLinkMap = new Map<string, PrLink>();
  const state: SessionState = {};
  let malformedLines = 0;

  for (const line of lines) {
    let record: ClaudeRecord;
    try {
      record = JSON.parse(line);
    } catch {
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
    if (!messageMap.has(msg.id)) {
      messageOrder.push(msg.id);
    }
    messageMap.set(msg.id, msg);
  }

  const messages = messageOrder.flatMap((id) => {
    const msg = messageMap.get(id);
    return msg ? [msg] : [];
  });

  if (malformedLines > 0) {
    console.warn(`[claude-parser] Skipped ${malformedLines} malformed line(s) in ${jsonlPath}`);
  }

  const meta: SessionMeta = {
    id: state.sessionId ?? "",
    source: "claude",
    project,
    cwd: state.cwd,
    title: state.title,
    model: state.model,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
  };

  return { meta, messages, prLinks: [...prLinkMap.values()] };
}
