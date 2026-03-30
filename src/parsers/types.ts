export interface TextContentBlock {
  type: "text";
  text: string;
}

export interface ToolUseContentBlock {
  type: "tool_use";
  toolName?: string;
  toolInput?: string;
}

export interface ToolResultContentBlock {
  type: "tool_result";
  toolOutput?: string;
}

export interface ThinkingContentBlock {
  type: "thinking";
  thinking: string;
}

export interface ImageContentBlock {
  type: "image";
  mediaType?: string;
}

export type ContentBlock =
  | TextContentBlock
  | ToolUseContentBlock
  | ToolResultContentBlock
  | ThinkingContentBlock
  | ImageContentBlock;

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
  content: (TextContentBlock | ToolResultContentBlock | ImageContentBlock)[];
}

export interface AssistantMessage extends BaseMessage {
  role: "assistant";
  content: ContentBlock[];
}

export type CleanMessage = UserMessage | AssistantMessage;

export interface SessionMeta {
  id: string;
  source: "claude" | "opencode" | "pi";
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
