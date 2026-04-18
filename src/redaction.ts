import type { CleanMessage, ContentBlock, ParseResult, SessionMeta } from "./parsers/types.ts";

interface SecretPattern {
  regex: RegExp;
  replacement: string;
}

export interface LiteralSecret {
  value: string;
  replacement: string;
}

export interface IndexRedactionContext {
  literalSecrets?: LiteralSecret[];
}

export interface RedactionContext extends IndexRedactionContext {}

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

export function collectLiteralSecrets(env: Environment = process.env): LiteralSecret[] {
  const byValue = new Map<string, string>();

  for (const [name, value] of Object.entries(env)) {
    if (!value || !looksSensitiveEnvName(name)) {
      continue;
    }

    if (value.length < 8 || /^\d+$/.test(value) || looksLikeFilesystemPath(value)) {
      continue;
    }

    if (!byValue.has(value)) {
      byValue.set(value, `[REDACTED:${normalizeSecretLabel(name)}]`);
    }
  }

  return [...byValue.entries()]
    .map(([value, replacement]) => ({ value, replacement }))
    .sort((a, b) => b.value.length - a.value.length);
}

function redactText(text: string, literalSecrets: LiteralSecret[]): string {
  let result = text;

  for (const secret of literalSecrets) {
    if (result.includes(secret.value)) {
      result = result.replaceAll(secret.value, secret.replacement);
    }
  }

  for (const { regex, replacement } of SECRET_PATTERNS) {
    result = result.replace(regex, replacement);
  }

  return result;
}

function redactMeta(meta: SessionMeta, literalSecrets: LiteralSecret[]): SessionMeta {
  if (!meta.title) {
    return meta;
  }

  const redactedTitle = redactText(meta.title, literalSecrets);
  if (redactedTitle === meta.title) {
    return meta;
  }

  return { ...meta, title: redactedTitle };
}

function redactContentBlock<T extends ContentBlock>(block: T, literalSecrets: LiteralSecret[]): T {
  switch (block.type) {
    case "text": {
      const redactedText = redactText(block.text, literalSecrets);
      return redactedText === block.text ? block : ({ ...block, text: redactedText } as T);
    }
    case "thinking": {
      const redactedThinking = redactText(block.thinking, literalSecrets);
      return redactedThinking === block.thinking
        ? block
        : ({ ...block, thinking: redactedThinking } as T);
    }
    case "tool_use": {
      if (!block.toolInput) {
        return block;
      }
      const redactedInput = redactText(block.toolInput, literalSecrets);
      return redactedInput === block.toolInput
        ? block
        : ({ ...block, toolInput: redactedInput } as T);
    }
    case "tool_result": {
      if (!block.toolOutput) {
        return block;
      }
      const redactedOutput = redactText(block.toolOutput, literalSecrets);
      return redactedOutput === block.toolOutput
        ? block
        : ({ ...block, toolOutput: redactedOutput } as T);
    }
    case "image":
      return block;
  }
}

function redactMessage(message: CleanMessage, literalSecrets: LiteralSecret[]): CleanMessage {
  if (message.role === "assistant") {
    return {
      ...message,
      content: message.content.map((block) => redactContentBlock(block, literalSecrets)),
    };
  }

  return {
    ...message,
    content: message.content.map((block) => redactContentBlock(block, literalSecrets)),
  };
}

export function createIndexRedactionContext(env: Environment = process.env): IndexRedactionContext {
  return {
    literalSecrets: collectLiteralSecrets(env),
  };
}

export function redactForIndexing(
  result: ParseResult,
  context: IndexRedactionContext = {},
): ParseResult {
  const literalSecrets = context.literalSecrets ?? collectLiteralSecrets();

  return {
    ...result,
    meta: redactMeta(result.meta, literalSecrets),
    messages: result.messages.map((message) => redactMessage(message, literalSecrets)),
    prLinks: result.prLinks,
  };
}

export function redactParseResult(
  result: ParseResult,
  context: RedactionContext = {},
): ParseResult {
  return redactForIndexing(result, context);
}
