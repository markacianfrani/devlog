export const SOURCES = ["claude", "opencode", "pi"] as const;
export type Source = (typeof SOURCES)[number];

export const MESSAGE_ROLES = ["user", "assistant"] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

export const CONTENT_BLOCK_TYPES = [
  "text",
  "tool_use",
  "tool_result",
  "thinking",
  "redacted_thinking",
  "image",
  "document",
] as const;
export type ContentBlockType = (typeof CONTENT_BLOCK_TYPES)[number];

export interface TextContentBlock {
  type: "text";
  text: string;
}

export interface ToolUseContentBlock {
  type: "tool_use";
  toolName: string;
  toolInput?: string;
  toolUseId?: string;
}

export interface ToolResultContentBlock {
  type: "tool_result";
  toolOutput: string;
  toolUseId?: string;
}

export interface ThinkingContentBlock {
  type: "thinking";
  thinking: string;
}

export interface RedactedThinkingContentBlock {
  type: "redacted_thinking";
}

export interface ImageContentBlock {
  type: "image";
  mediaType?: string;
}

export interface DocumentContentBlock {
  type: "document";
  mediaType?: string;
}

export type UserContentBlock =
  | TextContentBlock
  | ToolResultContentBlock
  | ImageContentBlock
  | DocumentContentBlock;

export type ContentBlock =
  | TextContentBlock
  | ToolUseContentBlock
  | ToolResultContentBlock
  | ThinkingContentBlock
  | RedactedThinkingContentBlock
  | ImageContentBlock
  | DocumentContentBlock;

interface BaseMessage {
  id: string;
  sessionId: string;
  parentId?: string;
  timestamp: string;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  agentId?: string;
}

export interface UserMessage extends BaseMessage {
  role: "user";
  content: UserContentBlock[];
}

export interface AssistantMessage extends BaseMessage {
  role: "assistant";
  content: ContentBlock[];
}

export type CleanMessage = UserMessage | AssistantMessage;

export interface SessionMeta {
  id: string;
  source: Source;
  project: string;
  cwd?: string;
  title?: string;
  model?: string;
  createdAt?: string;
  updatedAt?: string;
  parentSessionId?: string;
}

export interface PrLink {
  sessionId: string;
  prNumber: number;
  prUrl: string;
  prRepository: string;
  timestamp: string;
}

export interface ParseResult {
  meta: SessionMeta;
  messages: CleanMessage[];
  prLinks: PrLink[];
}

export interface MessageDraft {
  id?: string;
  sessionId?: string;
  parentId?: string;
  timestamp?: string;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  agentId?: string;
}

export interface SessionMetaDraft {
  id?: string;
  source: Source;
  project: string;
  cwd?: string;
  title?: string;
  model?: string;
  createdAt?: string;
  updatedAt?: string;
  parentSessionId?: string;
}

export interface PrLinkDraft {
  sessionId?: string;
  prNumber?: number;
  prUrl?: string;
  prRepository?: string;
  timestamp?: string;
}

export interface ParseResultDraft {
  meta: SessionMetaDraft;
  messages: CleanMessage[];
  prLinks: PrLink[];
}

function isNonEmptyString(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

export function isUserContentBlock(block: ContentBlock): block is UserContentBlock {
  return (
    block.type === "text" ||
    block.type === "tool_result" ||
    block.type === "image" ||
    block.type === "document"
  );
}

function createBaseMessage(draft: MessageDraft): BaseMessage | undefined {
  if (
    !isNonEmptyString(draft.id) ||
    !isNonEmptyString(draft.sessionId) ||
    !isNonEmptyString(draft.timestamp)
  ) {
    return undefined;
  }

  return {
    id: draft.id,
    sessionId: draft.sessionId,
    timestamp: draft.timestamp,
    ...(draft.parentId && { parentId: draft.parentId }),
    ...(draft.model && { model: draft.model }),
    ...(draft.tokensIn !== undefined && { tokensIn: draft.tokensIn }),
    ...(draft.tokensOut !== undefined && { tokensOut: draft.tokensOut }),
    ...(draft.cacheReadTokens !== undefined && { cacheReadTokens: draft.cacheReadTokens }),
    ...(draft.cacheWriteTokens !== undefined && { cacheWriteTokens: draft.cacheWriteTokens }),
    ...(draft.reasoningTokens !== undefined && { reasoningTokens: draft.reasoningTokens }),
    ...(draft.agentId && { agentId: draft.agentId }),
  };
}

export function createUserMessage(
  draft: MessageDraft,
  content: readonly UserContentBlock[],
): UserMessage | undefined {
  const base = createBaseMessage(draft);
  if (!base) {
    return undefined;
  }

  return {
    ...base,
    role: "user",
    content: [...content],
  };
}

export function createAssistantMessage(
  draft: MessageDraft,
  content: readonly ContentBlock[],
): AssistantMessage | undefined {
  const base = createBaseMessage(draft);
  if (!base) {
    return undefined;
  }

  return {
    ...base,
    role: "assistant",
    content: [...content],
  };
}

export function createSessionMeta(draft: SessionMetaDraft): SessionMeta | undefined {
  if (!isNonEmptyString(draft.id)) {
    return undefined;
  }

  return {
    id: draft.id,
    source: draft.source,
    project: draft.project,
    ...(draft.cwd && { cwd: draft.cwd }),
    ...(draft.title && { title: draft.title }),
    ...(draft.model && { model: draft.model }),
    ...(draft.createdAt && { createdAt: draft.createdAt }),
    ...(draft.updatedAt && { updatedAt: draft.updatedAt }),
    ...(draft.parentSessionId && { parentSessionId: draft.parentSessionId }),
  };
}

export function createPrLink(draft: PrLinkDraft): PrLink | undefined {
  const prNumber = draft.prNumber;

  if (
    !isNonEmptyString(draft.sessionId) ||
    typeof prNumber !== "number" ||
    !Number.isInteger(prNumber) ||
    prNumber <= 0 ||
    !isNonEmptyString(draft.prUrl) ||
    !isNonEmptyString(draft.prRepository) ||
    !isNonEmptyString(draft.timestamp)
  ) {
    return undefined;
  }

  return {
    sessionId: draft.sessionId,
    prNumber,
    prUrl: draft.prUrl,
    prRepository: draft.prRepository,
    timestamp: draft.timestamp,
  };
}

export function finalizeParseResult(draft: ParseResultDraft): ParseResult | undefined {
  const sessionId = draft.meta.id ?? draft.messages[0]?.sessionId ?? draft.prLinks[0]?.sessionId;
  const meta = createSessionMeta({ ...draft.meta, id: sessionId });
  if (!meta) {
    return undefined;
  }

  const messages = draft.messages.filter((message) => message.sessionId === meta.id);
  if (messages.length === 0) {
    return undefined;
  }

  const prLinks = draft.prLinks.filter((link) => link.sessionId === meta.id);
  return { meta, messages, prLinks };
}
