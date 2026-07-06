import { getPiExtensionRenderer } from "./pi-extensions.ts";
import {
  getFirstTextPreview,
  isObjectRecord,
  ParseWarningCollector,
  readJsonlLines,
  type ParseLineContext,
  type RawContentBlock,
} from "./shared.ts";
import {
  createAssistantMessage,
  createUserMessage,
  finalizeParseResult,
  type CleanMessage,
  type ContentBlock,
  type ImageContentBlock,
  type ParseOutcome,
  type UserContentBlock,
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
  customType?: string;
  content?: unknown;
  data?: unknown;
  summary?: string;
  label?: string;
  targetId?: string;
  fromId?: string;
}

const SKIP_TYPES = new Set(["thinking_level_change"]);
const KNOWN_TYPES = new Set([
  "session",
  "message",
  "model_change",
  "session_info",
  "custom_message",
  "custom",
  "compaction",
  "branch_summary",
  "label",
  ...SKIP_TYPES,
]);

interface SessionState {
  sessionId?: string;
  cwd?: string;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  model?: string;
  parentSessionId?: string;
}

function isPiGenericEntry(value: unknown): value is PiGenericEntry {
  return isObjectRecord(value);
}

function parsePiJsonLine(line: string): PiGenericEntry | undefined {
  try {
    const value = JSON.parse(line) as unknown;
    return isPiGenericEntry(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isPiSessionHeader(entry: PiGenericEntry): entry is PiSessionHeader {
  return entry.type === "session";
}

function isPiMessageEntry(entry: PiGenericEntry): entry is PiMessageEntry {
  return entry.type === "message";
}

function isPiMessageRole(role: string | undefined): role is "user" | "assistant" | "toolResult" {
  return role === "user" || role === "assistant" || role === "toolResult";
}

function parsePiContent(
  content: string | PiRawContentBlock[] | undefined,
  lineContext: ParseLineContext,
): ContentBlock[] {
  if (!content) {
    return [];
  }

  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }

  const blocks: ContentBlock[] = [];
  for (const block of content) {
    if (block.type === "thinking") {
      continue;
    }

    if (block.type === "toolCall") {
      if (!block.name) {
        lineContext.missingField("toolCall block missing name");
        continue;
      }

      blocks.push({
        type: "tool_use",
        toolName: block.name,
        toolInput: block.arguments ? JSON.stringify(block.arguments) : undefined,
        ...(block.id && { toolUseId: block.id }),
      });
      continue;
    }

    if (block.type === "image") {
      blocks.push({
        type: "image",
        mediaType: block.mimeType,
      });
      continue;
    }

    const parsed = lineContext.parseContentBlock(block);
    if (parsed) {
      blocks.push(parsed);
    }
  }

  return blocks;
}

function buildPiToolResultContent(
  content: string | PiRawContentBlock[] | undefined,
  toolUseId: string | undefined,
  lineContext: ParseLineContext,
): UserContentBlock[] {
  const idFields = toolUseId ? { toolUseId } : {};

  if (!content) {
    return [];
  }

  if (typeof content === "string") {
    return [{ type: "tool_result", toolOutput: content, ...idFields }];
  }

  const textParts: string[] = [];
  const images: ImageContentBlock[] = [];

  for (const block of content) {
    if (block.type === "text") {
      if (block.text) {
        textParts.push(block.text);
      }
    } else if (block.type === "image") {
      images.push({ type: "image", mediaType: block.mimeType });
    } else if (block.type !== "thinking") {
      lineContext.unknownType(block.type, "content block");
    }
  }

  const blocks: UserContentBlock[] = [];
  if (textParts.length > 0) {
    blocks.push({ type: "tool_result", toolOutput: textParts.join("\n"), ...idFields });
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
    state.title = getFirstTextPreview(contentBlocks) ?? state.title;
  }
}

function buildPiMessage(
  entry: PiMessageEntry,
  sessionId: string | undefined,
  content: ContentBlock[],
): CleanMessage | undefined {
  const role = entry.message?.role;
  if (!role) {
    return undefined;
  }

  const messageDraft = {
    id: entry.id,
    sessionId,
    timestamp: entry.timestamp,
    ...(entry.parentId && { parentId: entry.parentId }),
    ...(entry.message?.model && { model: entry.message.model }),
    ...extractTokenFields(entry.message),
  };

  if (role === "user") {
    return createUserMessage(
      messageDraft,
      content.filter(
        (block): block is UserContentBlock =>
          block.type === "text" || block.type === "tool_result" || block.type === "image",
      ),
    );
  }

  if (role === "assistant") {
    return createAssistantMessage(messageDraft, content);
  }

  if (role === "toolResult") {
    return createUserMessage(
      messageDraft,
      content.filter(
        (block): block is UserContentBlock =>
          block.type === "tool_result" || block.type === "image",
      ),
    );
  }

  return undefined;
}

function parsePiMessageContent(
  entry: PiGenericEntry,
  role: "user" | "assistant" | "toolResult",
  lineContext: ParseLineContext,
) {
  return role === "toolResult"
    ? buildPiToolResultContent(entry.message?.content, entry.message?.toolCallId, lineContext)
    : parsePiContent(entry.message?.content, lineContext);
}

function hasPiUsage(entry: PiGenericEntry): boolean {
  return (entry.message?.usage?.input ?? 0) > 0 || (entry.message?.usage?.output ?? 0) > 0;
}

function buildSyntheticPiTextMessage(
  entry: PiGenericEntry,
  sessionId: string | undefined,
  tagName: string,
  body: string,
  attributes: Record<string, string | undefined> = {},
): CleanMessage | undefined {
  if (!body) {
    return undefined;
  }

  const serializedAttributes = Object.entries(attributes)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([name, value]) => ` ${name}="${value}"`)
    .join("");
  const wrapped = `<pi:${tagName}${serializedAttributes}>${body}</pi:${tagName}>`;

  return createUserMessage(
    {
      id: entry.id,
      sessionId,
      timestamp: entry.timestamp,
      ...(entry.parentId && { parentId: entry.parentId }),
    },
    [{ type: "text", text: wrapped }],
  );
}

function buildCustomMessage(
  entry: PiGenericEntry,
  sessionId: string | undefined,
): CleanMessage | undefined {
  const body = typeof entry.content === "string" ? entry.content : "";
  if (!body && !entry.customType) {
    return undefined;
  }

  return buildSyntheticPiTextMessage(entry, sessionId, "custom-message", body, {
    customType: entry.customType ?? "unknown",
  });
}

/**
 * `custom` is pi's generic extension envelope. We route by `customType` through
 * the extension registry. An unrecognized extension still warns, but named by
 * the extension itself rather than the opaque `"custom"`.
 */
function buildCustomExtensionMessage(
  entry: PiGenericEntry,
  sessionId: string | undefined,
  lineContext: ParseLineContext,
): CleanMessage | undefined {
  const renderer =
    typeof entry.customType === "string" ? getPiExtensionRenderer(entry.customType) : undefined;
  if (!renderer) {
    lineContext.unknownType(entry.customType ?? "custom", "record");
    return undefined;
  }

  // A recognized extension whose payload isn't even an object is malformed, not
  // empty — surface it instead of dropping it silently the way a null goal is.
  if (!isObjectRecord(entry.data)) {
    lineContext.missingField(`Malformed payload for custom extension "${entry.customType}"`);
    return undefined;
  }

  const rendered = renderer(entry.data);
  if (!rendered) {
    return undefined;
  }

  return buildSyntheticPiTextMessage(
    entry,
    sessionId,
    rendered.tagName,
    rendered.body,
    rendered.attributes,
  );
}

function buildPiSummaryMessage(
  entry: PiGenericEntry,
  sessionId: string | undefined,
): CleanMessage | undefined {
  if (typeof entry.summary !== "string") {
    return undefined;
  }

  if (entry.type === "compaction") {
    return buildSyntheticPiTextMessage(entry, sessionId, "compaction", entry.summary);
  }

  if (entry.type === "branch_summary") {
    return buildSyntheticPiTextMessage(entry, sessionId, "branch-summary", entry.summary, {
      fromId: entry.fromId,
    });
  }

  return undefined;
}

function parsePiEntry(
  line: string,
  state: SessionState,
  lineContext: ParseLineContext,
): { malformed: boolean; message?: CleanMessage } {
  const entry = parsePiJsonLine(line);
  if (!entry) {
    return { malformed: true };
  }

  if (isPiSessionHeader(entry)) {
    updateStateFromHeader(state, entry);
    return { malformed: false };
  }

  if (entry.type === "model_change" || entry.type === "session_info") {
    updateStateFromEntry(state, entry, []);
    return { malformed: false };
  }

  if (entry.type && SKIP_TYPES.has(entry.type)) {
    return { malformed: false };
  }

  if (entry.type === "custom_message") {
    return { malformed: false, message: buildCustomMessage(entry, state.sessionId) };
  }

  if (entry.type === "custom") {
    return {
      malformed: false,
      message: buildCustomExtensionMessage(entry, state.sessionId, lineContext),
    };
  }

  if (entry.type === "compaction" || entry.type === "branch_summary") {
    return { malformed: false, message: buildPiSummaryMessage(entry, state.sessionId) };
  }

  if (entry.type === "label") {
    return { malformed: false };
  }

  if (!isPiMessageEntry(entry) || !isPiMessageRole(entry.message?.role)) {
    if (entry.type && !KNOWN_TYPES.has(entry.type)) {
      lineContext.unknownType(entry.type, "record");
    }
    return { malformed: false };
  }

  const parsedContent = parsePiMessageContent(entry, entry.message.role, lineContext);
  updateStateFromEntry(state, entry, parsedContent);

  if (parsedContent.length === 0 && !hasPiUsage(entry)) {
    return { malformed: false };
  }

  return {
    malformed: false,
    message: buildPiMessage(entry, state.sessionId, parsedContent),
  };
}

export async function parsePiSession(jsonlPath: string, project: string): Promise<ParseOutcome> {
  const lines = readJsonlLines(jsonlPath);

  const messages: CleanMessage[] = [];
  const state: SessionState = {};
  const warnings = new ParseWarningCollector("pi-parser", jsonlPath);
  let malformedLines = 0;

  for (const [index, line] of lines.entries()) {
    const lineContext = warnings.line(index + 1);
    const result = parsePiEntry(line, state, lineContext);
    if (result.malformed) {
      malformedLines++;
      continue;
    }
    if (result.message) {
      messages.push(result.message);
    }
  }

  warnings.malformedLines(malformedLines);

  const result = finalizeParseResult({
    meta: {
      id: state.sessionId,
      source: "pi",
      project,
      cwd: state.cwd,
      title: state.title,
      model: state.model,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      parentSessionId: state.parentSessionId,
    },
    messages,
    prLinks: [],
    artifactLinks: [],
  });

  return { result, warnings: warnings.toArray() };
}
