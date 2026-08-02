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
  // bashExecution messages carry the command + output at the message level
  // instead of as content blocks.
  command?: string;
  output?: string;
  exitCode?: number;
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

/** pi image blocks carry their media type as `mimeType`; map to the canonical block. */
function piImageBlock(mimeType: unknown): ImageContentBlock {
  return {
    type: "image",
    mediaType: typeof mimeType === "string" ? mimeType : undefined,
  };
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
      blocks.push(piImageBlock(block.mimeType));
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

/** Escapes a value for safe use inside a synthetic `<pi:...>` attribute. */
function escapePiAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
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
    .map(([name, value]) => ` ${name}="${escapePiAttribute(value)}"`)
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

function parsePiCustomMessageContent(
  content: unknown,
  lineContext: ParseLineContext,
): UserContentBlock[] {
  if (!Array.isArray(content)) {
    return [];
  }

  const blocks: UserContentBlock[] = [];
  for (const block of content) {
    if (!isObjectRecord(block)) {
      lineContext.missingField("custom_message content block must be an object");
      continue;
    }

    const type = typeof block["type"] === "string" ? block["type"] : "(missing)";
    if (type === "text") {
      const text = typeof block["text"] === "string" ? block["text"] : "";
      if (text.length > 0) {
        blocks.push({ type: "text", text });
      }
      continue;
    }

    if (type === "image") {
      blocks.push(piImageBlock(block["mimeType"]));
      continue;
    }

    lineContext.unknownType(type, "content block");
  }

  return blocks;
}

/**
 * `custom_message` is pi's extension-owned message record. Its public contract
 * is a `customType` plus `content` that is either a string or an array of
 * text/image blocks. Devlog normalizes only that stable content surface; it
 * never inspects `customType` or the extension-owned `details` field.
 *
 * String content keeps the existing provenance wrapper. Array content is
 * parsed into real text/image blocks (so images keep their media type and text
 * stays searchable), with a deterministic provenance marker prepended so the
 * custom type stays searchable even for image-only messages. Unsupported block
 * types warn through the normal content-block warning path.
 */
function buildCustomMessage(
  entry: PiGenericEntry,
  sessionId: string | undefined,
  lineContext: ParseLineContext,
): CleanMessage | undefined {
  const customType = typeof entry.customType === "string" ? entry.customType : undefined;
  const content = entry.content;

  if (typeof content === "string") {
    return buildSyntheticPiTextMessage(entry, sessionId, "custom-message", content, {
      customType: customType ?? "unknown",
    });
  }

  if (Array.isArray(content)) {
    const blocks = parsePiCustomMessageContent(content, lineContext);
    // Always emit a provenance marker so customType stays searchable, even for
    // image-only messages that have no text body of their own.
    const marker = customType
      ? `<pi:custom-message customType="${escapePiAttribute(customType)}"/>`
      : `<pi:custom-message/>`;
    return createUserMessage(
      {
        id: entry.id,
        sessionId,
        timestamp: entry.timestamp,
        ...(entry.parentId && { parentId: entry.parentId }),
      },
      [{ type: "text", text: marker }, ...blocks],
    );
  }

  return undefined;
}

/**
 * Serializes a pi `custom` record's stable envelope into deterministic JSON.
 * Only stable envelope fields are read: `customType` (when it is a string) and
 * `data` (when the field is present, including an explicit `null`). The value
 * of `data` stays opaque JSON and is never inspected field-by-field.
 *
 * Carrying the custom type inside the JSON body (rather than as an XML-like
 * attribute) keeps the output deterministic, avoids attribute-escaping
 * problems for arbitrary custom type names, and preserves the distinction
 * between an omitted `data` field and an explicitly present `null`.
 */
function buildPiCustomEnvelope(entry: PiGenericEntry): string {
  const envelope: Record<string, unknown> = {};
  if (typeof entry.customType === "string") {
    envelope["customType"] = entry.customType;
  }
  if ("data" in entry) {
    envelope["data"] = entry.data;
  }
  return JSON.stringify(envelope);
}

/**
 * `custom` is pi's generic extension envelope: a `customType` plus an
 * extension-owned `data` payload. Devlog depends only on the public envelope,
 * never on any extension's private payload schema, so every well-formed custom
 * record is surfaced verbatim inside a `<pi:custom>` block.
 *
 * A missing or non-string `customType` is a stable-envelope problem (not an
 * extension payload problem), so it warns through the normal missing-field
 * path while the record is still surfaced using whatever envelope fields were
 * present. The payload itself is never warned about: pi's public contract lets
 * `data` be any JSON value (object, array, string, number, boolean, null) or
 * omitted entirely, so devlog cannot call an extension-owned value malformed.
 */
function buildCustomRecord(
  entry: PiGenericEntry,
  sessionId: string | undefined,
  lineContext: ParseLineContext,
): CleanMessage | undefined {
  if (typeof entry.customType !== "string") {
    lineContext.missingField("custom record missing a valid customType field");
  }

  return buildSyntheticPiTextMessage(entry, sessionId, "custom", buildPiCustomEnvelope(entry));
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

/**
 * pi emits raw shell executions as `bashExecution` messages (command + output +
 * exitCode). They carry no content blocks, so they fall outside the
 * user/assistant/toolResult dispatch — surface them as a synthetic
 * `<pi:bash-execution>` user message shaped like a shell transcript so the
 * command and its output stay searchable instead of being dropped. Everything
 * goes in the body (no attributes), so commands containing quotes can't break
 * the wrapper.
 */
function buildBashExecutionMessage(
  entry: PiGenericEntry,
  sessionId: string | undefined,
): CleanMessage | undefined {
  const message = entry.message;
  const command = typeof message?.command === "string" ? message.command : "";
  const output = typeof message?.output === "string" ? message.output : "";

  if (!command && !output) {
    return undefined;
  }

  const lines: string[] = [];
  if (command) {
    lines.push(`$ ${command}`);
  }
  if (output) {
    lines.push(output);
  }
  if (typeof message?.exitCode === "number") {
    lines.push(`[exit: ${message.exitCode}]`);
  }

  return buildSyntheticPiTextMessage(entry, sessionId, "bash-execution", lines.join("\n"));
}

/**
 * Handles `message` records once the top-level dispatcher has confirmed the
 * type. bashExecution is a self-contained event (command + output) with no
 * content blocks, so it lives outside the user/assistant/toolResult union.
 * Any other unrecognized role is a real record we'd otherwise drop silently —
 * warn so novel pi roles surface instead of vanishing.
 */
function buildPiMessageEntry(
  entry: PiMessageEntry,
  state: SessionState,
  lineContext: ParseLineContext,
): { malformed: boolean; message?: CleanMessage } {
  if (entry.message?.role === "bashExecution") {
    return { malformed: false, message: buildBashExecutionMessage(entry, state.sessionId) };
  }

  if (!isPiMessageRole(entry.message?.role)) {
    lineContext.unknownType(entry.message?.role ?? "(missing)", "message role");
    return { malformed: false };
  }

  const parsedContent = parsePiMessageContent(entry, entry.message.role, lineContext);
  updateStateFromEntry(state, entry, parsedContent);

  if (parsedContent.length === 0 && !hasPiUsage(entry)) {
    return { malformed: false };
  }

  return { malformed: false, message: buildPiMessage(entry, state.sessionId, parsedContent) };
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
    return { malformed: false, message: buildCustomMessage(entry, state.sessionId, lineContext) };
  }

  if (entry.type === "custom") {
    return {
      malformed: false,
      message: buildCustomRecord(entry, state.sessionId, lineContext),
    };
  }

  if (entry.type === "compaction" || entry.type === "branch_summary") {
    return { malformed: false, message: buildPiSummaryMessage(entry, state.sessionId) };
  }

  if (entry.type === "label") {
    return { malformed: false };
  }

  if (!isPiMessageEntry(entry)) {
    if (entry.type && !KNOWN_TYPES.has(entry.type)) {
      lineContext.unknownType(entry.type, "record");
    }
    return { malformed: false };
  }

  return buildPiMessageEntry(entry, state, lineContext);
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
