import path from "node:path";

import {
  isObjectRecord,
  ParseWarningCollector,
  readJsonlLines,
  type ParseLineContext,
  type RawContentBlock,
} from "./shared.ts";
import {
  createArtifactLink,
  createAssistantMessage,
  createPrLink,
  createUserMessage,
  finalizeParseResult,
  isUserContentBlock,
  type ArtifactLink,
  type CleanMessage,
  type ContentBlock,
  type ParseOutcome,
  type PrLink,
  type UsageIdentity,
  type WorktreeInfo,
} from "./types.ts";

// Record types that exist in the transcript but do not produce a CleanMessage.
// Some are pure noise (progress, file-history-snapshot, attachment); others are
// consumed for session state by explicit handler branches in classifyClaudeRecord
// (summary, ai-title, custom-title, worktree-state), which are guarded on the field
// they read -- a record omitting it falls through to here. This is the only set that
// suppresses the "Unknown record type" warning. To refresh it after a CLI upgrade,
// read the record-type retention table in the claude binary (grep for "atis-latch").
const NON_MESSAGE_TYPES = new Set([
  "progress",
  "file-history-snapshot",
  "file-history-delta",
  "summary",
  "custom-title",
  "ai-title",
  "system",
  "queue-operation",
  "last-prompt",
  "agent-name",
  "permission-mode",
  "mode",
  "attachment",
  "worktree-state",
  // Session cost and token totals, rewritten on every turn. devlog derives its own
  // token counts from the assistant records and stores no cost, so this is noise.
  "cost-state",
  "relocated",
  "bridge-session",
  "agent-setting",
  "agent-color",
  "ended-by-model",
  "tag",
  "history-suppression",
  "attribution-snapshot",
  "content-replacement",
  "observer-ref",
  "isolation-latch",
  // Server-issued token naming the feature-flag snapshot the conversation is pinned
  // to, echoed back to the API as the x-cc-atis header. Rewritten on every turn.
  "atis-latch",
  // Which published artifacts this session watches for new comments, so a resumed
  // session can re-arm the watch.
  "artifact-comment-monitor",
  "artifact-autoreact-ledger",
  "marble-origami-commit",
  "marble-origami-snapshot",
  "marble-origami-reset",
]);

// Content blocks that carry session metadata, not conversation content.
// "fallback" records a mid-session model switch (e.g. fable-5 -> opus-4-8).
const SKIP_BLOCK_TYPES = new Set(["fallback"]);

interface ClaudeRecord {
  type: string;
  sessionId?: string;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  cwd?: string;
  isMeta?: boolean;
  agentId?: string;
  requestId?: string;
  isSidechain?: boolean;
  summary?: string;
  customTitle?: string;
  aiTitle?: string;
  leafUuid?: string;
  parentSessionId?: unknown; // narrowed at runtime, unlike the rest of this shape
  prNumber?: number;
  prUrl?: string;
  prRepository?: string;
  path?: string;
  frameUrl?: string;
  worktreeSession?: {
    originalCwd?: string;
    worktreePath?: string;
    worktreeName?: string;
    worktreeBranch?: string;
    originalBranch?: string;
    originalHeadCommit?: string;
  };
  message?: {
    id?: string;
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
  parentSessionId?: string;
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
  return candidate !== undefined && UUID_PATTERN.test(candidate) ? candidate : undefined;
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
  lineContext: ParseLineContext,
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
  // Header of a forked subagent transcript; parentLastUuid and contextLength are
  // unread. This link outranks the archive path, so an unusable one warns instead of
  // falling back to a path guess that nothing downstream could tell apart.
  if (record.type === "fork-context-ref") {
    const parent = record.parentSessionId;
    if (typeof parent !== "string" || parent === "") {
      lineContext.missingField(
        `fork-context-ref has no usable parentSessionId (${JSON.stringify(parent)}); falling back to the archive path`,
      );
      return "skip";
    }
    // First wins, matching updateSessionState.
    if (state.parentSessionId !== undefined && state.parentSessionId !== parent) {
      lineContext.missingField(
        `fork-context-ref disagrees with an earlier one (kept ${state.parentSessionId}, ignored ${parent})`,
      );
      return "skip";
    }
    state.parentSessionId = parent;
    return "skip";
  }
  if (NON_MESSAGE_TYPES.has(record.type) || record.isMeta) {
    return "skip";
  }
  if (record.type !== "user" && record.type !== "assistant") {
    lineContext.unknownType(record.type, "record");
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

/**
 * Claude Code streams one API response as several JSONL records, one per content
 * block, each repeating the response's
 * `message.id` and `requestId`. Like ccusage, a response is identified by
 * `message.id` + `requestId`; without a request id (some gateways reuse one
 * message id for every response) it is scoped to the session and timestamp.
 * Records that are not assistant responses are identified by their uuid.
 */
function claudeFoldKey(record: ClaudeRecord, sessionId: string | undefined): string | undefined {
  const messageId = record.message?.id;
  if (record.type !== "assistant" || !messageId) {
    return record.uuid;
  }
  return record.requestId
    ? `${messageId}\0${record.requestId}`
    : `${messageId}\0${record.sessionId ?? sessionId ?? ""}\0${record.timestamp ?? ""}`;
}

function claudeUsageIdentity(record: ClaudeRecord): UsageIdentity | undefined {
  const messageId = record.message?.id;
  if (record.type !== "assistant" || !messageId) {
    return undefined;
  }
  return {
    messageId,
    ...(record.requestId && { requestId: record.requestId }),
    isSidechain: record.isSidechain === true,
  };
}

function usageTotal(msg: CleanMessage): number {
  return (
    (msg.tokensIn ?? 0) +
    (msg.tokensOut ?? 0) +
    (msg.cacheReadTokens ?? 0) +
    (msg.cacheWriteTokens ?? 0)
  );
}

/** ccusage's survivor rule: a main-chain record beats a sidechain one, then larger usage wins. */
function shouldReplaceUsage(candidate: CleanMessage, existing: CleanMessage): boolean {
  const candidateSidechain = candidate.usageIdentity?.isSidechain === true;
  const existingSidechain = existing.usageIdentity?.isSidechain === true;
  if (candidateSidechain !== existingSidechain) {
    return existingSidechain;
  }
  return usageTotal(candidate) > usageTotal(existing);
}

function buildClaudeMessage(
  record: ClaudeRecord,
  sessionId: string | undefined,
  contentBlocks: ContentBlock[],
  id: string | undefined,
  parentId: string | undefined,
): CleanMessage | undefined {
  const usage = record.message?.usage;
  const usageIdentity = claudeUsageIdentity(record);
  const messageDraft = {
    id,
    sessionId: record.sessionId ?? sessionId,
    timestamp: record.timestamp,
    ...(parentId && { parentId }),
    ...(record.message?.model && { model: record.message.model }),
    ...(record.agentId && { agentId: record.agentId }),
    ...(usageIdentity && { usageIdentity }),
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

interface ClaudeMessageAccumulator {
  /** Keyed by fold key; Map insertion order is the transcript order. */
  messages: Map<string, CleanMessage>;
  /** Record uuid -> stored id of the message it was folded into. */
  storedIdByUuid: Map<string, string>;
  /** Fold key -> uuids of the records already folded in, so a replayed record adds nothing. */
  foldedUuids: Map<string, Set<string>>;
}

/**
 * Adds a record's message to the session, folding streaming records of one API
 * response into a single message. The folded message keeps the first record's
 * uuid and parent; its usage comes from the survivor per ccusage's rule; content
 * blocks from every distinct record are kept in the order they streamed in. Blocks
 * are not compared by content: distinct blocks can be identical (e.g. several
 * empty-text thinking or redacted_thinking blocks).
 */
function storeClaudeMessage(
  record: ClaudeRecord,
  state: SessionState,
  contentBlocks: ContentBlock[],
  acc: ClaudeMessageAccumulator,
): void {
  const foldKey = claudeFoldKey(record, state.sessionId);
  if (!foldKey) {
    return;
  }
  const existing = acc.messages.get(foldKey);
  const id = existing?.id ?? record.uuid;
  if (record.uuid && id) {
    acc.storedIdByUuid.set(record.uuid, id);
  }
  const parentId = record.parentUuid
    ? (acc.storedIdByUuid.get(record.parentUuid) ?? record.parentUuid)
    : undefined;

  const msg = buildClaudeMessage(record, state.sessionId, contentBlocks, id, parentId);
  if (!msg) {
    return;
  }

  const folded = acc.foldedUuids.get(foldKey) ?? new Set<string>();
  acc.foldedUuids.set(foldKey, folded);
  const isReplay = record.uuid !== undefined && folded.has(record.uuid);
  if (record.uuid) {
    folded.add(record.uuid);
  }

  if (existing?.role !== "assistant" || msg.role !== "assistant") {
    acc.messages.set(foldKey, msg);
    return;
  }

  const { parentId: _ignored, ...survivor } = shouldReplaceUsage(msg, existing) ? msg : existing;
  acc.messages.set(foldKey, {
    ...survivor,
    id: existing.id,
    ...(existing.parentId && { parentId: existing.parentId }),
    content: isReplay ? existing.content : [...existing.content, ...msg.content],
  });
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

function collectArtifactLink(
  record: ClaudeRecord,
  artifactLinkMap: Map<string, ArtifactLink>,
): void {
  const link = createArtifactLink({
    sessionId: record.sessionId,
    path: record.path,
    artifactUrl: record.frameUrl,
    timestamp: record.timestamp,
  });

  if (link) {
    artifactLinkMap.set(link.artifactUrl, link);
  }
}

export async function parseClaudeSession(
  jsonlPath: string,
  project: string,
): Promise<ParseOutcome> {
  const lines = readJsonlLines(jsonlPath);

  const acc: ClaudeMessageAccumulator = {
    messages: new Map(),
    storedIdByUuid: new Map(),
    foldedUuids: new Map(),
  };
  const prLinkMap = new Map<string, PrLink>();
  const artifactLinkMap = new Map<string, ArtifactLink>();
  const state: SessionState = {};
  const warnings = new ParseWarningCollector("claude-parser", jsonlPath);
  let malformedLines = 0;

  for (const [index, line] of lines.entries()) {
    const lineContext = warnings.line(index + 1);
    const record = parseClaudeJsonLine(line);
    if (!record) {
      malformedLines++;
      continue;
    }

    if (record.type === "pr-link") {
      collectPrLink(record, prLinkMap);
      continue;
    }

    if (record.type === "frame-link") {
      collectArtifactLink(record, artifactLinkMap);
      continue;
    }

    if (classifyClaudeRecord(record, state, lineContext) === "skip") {
      continue;
    }

    updateSessionState(state, record);

    const contentBlocks = lineContext.parseContent(record.message?.content, SKIP_BLOCK_TYPES);
    const usage = record.message?.usage;
    const hasUsage = (usage?.input_tokens ?? 0) > 0 || (usage?.output_tokens ?? 0) > 0;
    if (contentBlocks.length === 0 && !hasUsage) {
      continue;
    }

    storeClaudeMessage(record, state, contentBlocks, acc);
  }

  const messages = [...acc.messages.values()];

  warnings.malformedLines(malformedLines);

  const result = finalizeParseResult({
    meta: {
      id: state.sessionId,
      source: "claude",
      project,
      cwd: state.cwd,
      title: state.title,
      model: state.model,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      // The path is only an inference from the archive layout, so the record wins.
      // A fork reuses its parent's sessionId, so id === parentSessionId is normal.
      parentSessionId: state.parentSessionId ?? extractParentSessionIdFromPath(jsonlPath),
      worktree: state.worktree,
    },
    messages,
    prLinks: [...prLinkMap.values()],
    artifactLinks: [...artifactLinkMap.values()],
  });

  return { result, warnings: warnings.toArray() };
}
