import type {
  AssistantMessage,
  CleanMessage,
  ContentBlock,
  ParseResult,
  PrLink,
  SessionMeta,
  UserContentBlock,
  UserMessage,
} from "./parsers/types.ts";

interface SecretPattern {
  regex: RegExp;
  replacement: string;
}

export interface LiteralSecret {
  readonly value: string;
  readonly replacement: string;
}

export interface NormalizedLiteralSecrets {
  readonly kind: "normalized-literal-secrets";
  readonly items: readonly LiteralSecret[];
}

export interface IndexRedactionContext {
  readonly literalSecrets: NormalizedLiteralSecrets;
}

export type RedactionContext = IndexRedactionContext;

export interface RedactedParseResult extends ParseResult {
  readonly redacted: true;
}

type Environment = Record<string, string | undefined>;

const SENSITIVE_ENV_NAME_PATTERN =
  /(?:^|_)(?:API_?KEY|ACCESS_?KEY|KEY|TOKEN|SECRET|PASSWORD|COOKIE|CREDENTIALS?|AUTH(?:ORIZATION)?|PAT)(?:_|$)/;

const SECRET_PATTERNS: SecretPattern[] = [
  { regex: /sk-proj-[A-Za-z0-9_-]{20,}/g, replacement: "[REDACTED:openai-project-key]" },
  { regex: /sk-ant-[A-Za-z0-9_-]{20,}/g, replacement: "[REDACTED:anthropic-key]" },
  { regex: /sk-or-[A-Za-z0-9_-]{20,}/g, replacement: "[REDACTED:openrouter-key]" },
  { regex: /sk-[A-Za-z0-9]{48}/g, replacement: "[REDACTED:openai-key]" },
  { regex: /gsk_[A-Za-z0-9]{20,}/g, replacement: "[REDACTED:groq-key]" },
  { regex: /gh[pousr]_[A-Za-z0-9]{30,}/g, replacement: "[REDACTED:github-token]" },
  { regex: /github_pat_[A-Za-z0-9_]{20,}/g, replacement: "[REDACTED:github-token]" },
  { regex: /hf_[A-Za-z0-9]{20,}/g, replacement: "[REDACTED:huggingface-token]" },
  { regex: /xai-[A-Za-z0-9_-]{20,}/g, replacement: "[REDACTED:xai-key]" },
  { regex: /AIza[A-Za-z0-9_-]{30,}/g, replacement: "[REDACTED:google-ai-key]" },
  { regex: /csk-[A-Za-z0-9_-]{20,}/g, replacement: "[REDACTED:cerebras-key]" },
  { regex: /(?:AKIA|ASIA)[0-9A-Z]{16}/g, replacement: "[REDACTED:aws-key]" },
  {
    regex: /-----BEGIN [\w ]+ KEY-----[\s\S]+?-----END [\w ]+ KEY-----/g,
    replacement: "[REDACTED:private-key]",
  },
  { regex: /\bBearer\s+[A-Za-z0-9+/=._-]{20,}/g, replacement: "Bearer [REDACTED]" },
  { regex: /\bBasic\s+[A-Za-z0-9+/=]{20,}/g, replacement: "Basic [REDACTED]" },
  {
    regex: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    replacement: "[REDACTED:jwt]",
  },
  {
    regex:
      /((?:API_?KEY|AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|COOKIE)S?["']?\s*[=:]\s*["']?)([A-Za-z0-9+/._~-]{16,})(['";,\s]|$)/gi,
    replacement: "$1[REDACTED]$3",
  },
];

function normalizeEnvName(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
}

function looksSensitiveEnvName(name: string): boolean {
  return SENSITIVE_ENV_NAME_PATTERN.test(normalizeEnvName(name));
}

function looksLikeFilesystemPath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

function normalizeSecretLabel(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeLiteralSecrets(secrets: Iterable<LiteralSecret>): NormalizedLiteralSecrets {
  const byValue = new Map<string, string>();

  for (const secret of secrets) {
    if (!byValue.has(secret.value)) {
      byValue.set(secret.value, secret.replacement);
    }
  }

  return {
    kind: "normalized-literal-secrets",
    items: [...byValue.entries()]
      .map(([value, replacement]) => ({ value, replacement }))
      .sort((a, b) => b.value.length - a.value.length),
  };
}

export function collectLiteralSecrets(env: Environment = process.env): NormalizedLiteralSecrets {
  const secrets: LiteralSecret[] = [];

  for (const [name, value] of Object.entries(env)) {
    if (!value || !looksSensitiveEnvName(name)) {
      continue;
    }

    if (value.length < 8 || /^\d+$/.test(value) || looksLikeFilesystemPath(value)) {
      continue;
    }

    secrets.push({
      value,
      replacement: `[REDACTED:${normalizeSecretLabel(name)}]`,
    });
  }

  return normalizeLiteralSecrets(secrets);
}

function redactText(text: string, literalSecrets: NormalizedLiteralSecrets): string {
  let result = text;

  for (const secret of literalSecrets.items) {
    if (result.includes(secret.value)) {
      result = result.replaceAll(secret.value, secret.replacement);
    }
  }

  for (const { regex, replacement } of SECRET_PATTERNS) {
    result = result.replace(regex, replacement);
  }

  return result;
}

function redactMeta(meta: SessionMeta, literalSecrets: NormalizedLiteralSecrets): SessionMeta {
  if (!meta.title) {
    return meta;
  }

  const redactedTitle = redactText(meta.title, literalSecrets);
  return redactedTitle === meta.title ? meta : { ...meta, title: redactedTitle };
}

function redactContentBlock(
  block: ContentBlock,
  literalSecrets: NormalizedLiteralSecrets,
): ContentBlock {
  switch (block.type) {
    case "text": {
      const redactedText = redactText(block.text, literalSecrets);
      return redactedText === block.text ? block : { ...block, text: redactedText };
    }
    case "thinking": {
      const redactedThinking = redactText(block.thinking, literalSecrets);
      return redactedThinking === block.thinking ? block : { ...block, thinking: redactedThinking };
    }
    case "tool_use": {
      if (!block.toolInput) {
        return block;
      }
      const redactedInput = redactText(block.toolInput, literalSecrets);
      return redactedInput === block.toolInput ? block : { ...block, toolInput: redactedInput };
    }
    case "tool_result": {
      const redactedOutput = redactText(block.toolOutput, literalSecrets);
      return redactedOutput === block.toolOutput ? block : { ...block, toolOutput: redactedOutput };
    }
    case "image":
      return block;
  }
}

function redactUserContentBlock(
  block: UserContentBlock,
  literalSecrets: NormalizedLiteralSecrets,
): UserContentBlock {
  switch (block.type) {
    case "text": {
      const redactedText = redactText(block.text, literalSecrets);
      return redactedText === block.text ? block : { ...block, text: redactedText };
    }
    case "tool_result": {
      const redactedOutput = redactText(block.toolOutput, literalSecrets);
      return redactedOutput === block.toolOutput ? block : { ...block, toolOutput: redactedOutput };
    }
    case "image":
      return block;
  }
}

function redactMessage(message: UserMessage, literalSecrets: NormalizedLiteralSecrets): UserMessage;
function redactMessage(
  message: AssistantMessage,
  literalSecrets: NormalizedLiteralSecrets,
): AssistantMessage;
function redactMessage(
  message: CleanMessage,
  literalSecrets: NormalizedLiteralSecrets,
): CleanMessage {
  if (message.role === "assistant") {
    return {
      ...message,
      content: message.content.map((block) => redactContentBlock(block, literalSecrets)),
    };
  }

  return {
    ...message,
    content: message.content.map((block) => redactUserContentBlock(block, literalSecrets)),
  };
}

function redactPrLink(link: PrLink, literalSecrets: NormalizedLiteralSecrets): PrLink {
  const prUrl = redactText(link.prUrl, literalSecrets);
  const prRepository = redactText(link.prRepository, literalSecrets);

  if (prUrl === link.prUrl && prRepository === link.prRepository) {
    return link;
  }

  return {
    ...link,
    prUrl,
    prRepository,
  };
}

export function createIndexRedactionContext(env: Environment = process.env): IndexRedactionContext {
  return {
    literalSecrets: collectLiteralSecrets(env),
  };
}

export function redactForIndexing(
  result: ParseResult,
  context?: IndexRedactionContext,
): RedactedParseResult {
  const literalSecrets = context?.literalSecrets ?? collectLiteralSecrets();

  return {
    ...result,
    meta: redactMeta(result.meta, literalSecrets),
    messages: result.messages.map((message) => {
      if (message.role === "assistant") {
        return redactMessage(message, literalSecrets);
      }
      return redactMessage(message, literalSecrets);
    }),
    prLinks: result.prLinks.map((link) => redactPrLink(link, literalSecrets)),
    redacted: true,
  };
}

export const redactParseResult = redactForIndexing;
