import path from "node:path";
import {
  isObjectRecord,
  parseContent,
  ParseWarningCollector,
  readJsonlLines,
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
  type WorktreeInfo,
} from "./types.ts";

// Record types that exist in the transcript but do not produce a CleanMessage.
// Some are pure noise (progress, file-history-snapshot, attachment); others are
// consumed for session state by explicit handler branches in classifyClaudeRecord
// (summary, ai-title, custom-title, worktree-state). Both kinds live here so
// KNOWN_TYPES below can suppress the "Unknown record type" warning uniformly.
const NON_MESSAGE_TYPES = new Set([
  "progress",
  "file-history-snapshot",
  "summary",
  "custom-title",
  "ai-title",
  "system",
  "queue-operation",
  "last-prompt",
  "agent-name",
  "permission-mode",
  "attachment",
  "worktree-state",
]);
const KNOWN_TYPES = new Set([...NON_MESSAGE_TYPES, ...MESSAGE_ROLES, "pr-link"]);

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
  aiTitle?: string;
  leafUuid?: string;
  prNumber?: number;
  prUrl?: string;
  prRepository?: string;
  worktreeSession?: {
    originalCwd?: string;
    worktreePath?: string;
    worktreeName?: string;
    worktreeBranch?: string;
    originalBranch?: string;
    originalHeadCommit?: string;
  };
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

type TitleSource = "summary" | "ai-title" | "custom-title";

const TITLE_PRIORITY: Record<TitleSource, number> = {
  summary: 1,
  "ai-title": 2,
  "custom-title": 3,
};

interface SessionState {
  sessionId?: string;
  cwd?: string;
  title?: string;
  titleSource?: TitleSource;
  createdAt?: string;
  updatedAt?: string;
  model?: string;
  worktree?: WorktreeInfo;
}

function setTitle(state: SessionState, source: TitleSource, value: string): void {
  const currentPriority = state.titleSource ? TITLE_PRIORITY[state.titleSource] : 0;
  if (TITLE_PRIORITY[source] >= currentPriority) {
    state.title = value;
    state.titleSource = source;
  }
}

function captureWorktree(state: SessionState, record: ClaudeRecord): void {
  const w = record.worktreeSession;
  if (!w?.worktreePath || !w.worktreeName) {
    return;
  }
  state.worktree = {
    worktreePath: w.worktreePath,
    worktreeName: w.worktreeName,
    originalCwd: w.originalCwd,
    worktreeBranch: w.worktreeBranch,
    originalBranch: w.originalBranch,
    originalHeadCommit: w.originalHeadCommit,
  };
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
function classifyClaudeRecord(
  record: ClaudeRecord,
  state: SessionState,
  warnings: ParseWarningCollector,
  lineNumber: number,
): "skip" | "process" {
  if (record.type === "summary" && record.summary) {
    setTitle(state, "summary", record.summary);
    return "skip";
  }
  if (record.type === "ai-title" && record.aiTitle) {
    setTitle(state, "ai-title", record.aiTitle);
    return "skip";
  }
  if (record.type === "custom-title" && record.customTitle) {
    setTitle(state, "custom-title", record.customTitle);
    return "skip";
  }
  if (record.type === "worktree-state") {
    captureWorktree(state, record);
    return "skip";
  }
  if (NON_MESSAGE_TYPES.has(record.type) || record.isMeta) {
    return "skip";
  }
  if (record.type !== "user" && record.type !== "assistant") {
    if (!KNOWN_TYPES.has(record.type)) {
      warnUnknownType(record.type, "record", "claude-parser", warnings, lineNumber);
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
  const warnings = new ParseWarningCollector("claude-parser", jsonlPath);
  let malformedLines = 0;

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    const record = parseClaudeJsonLine(line);
    if (!record) {
      malformedLines++;
      continue;
    }

    if (record.type === "pr-link") {
      collectPrLink(record, prLinkMap);
      continue;
    }

    if (classifyClaudeRecord(record, state, warnings, lineNumber) === "skip") {
      continue;
    }

    updateSessionState(state, record);

    const contentBlocks = parseContent(
      record.message?.content,
      "claude-parser",
      undefined,
      warnings,
      lineNumber,
    );
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

  warnings.malformedLines(malformedLines);

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
      worktree: state.worktree,
    },
    messages,
    prLinks: [...prLinkMap.values()],
    warnings: warnings.toArray(),
  });
}
