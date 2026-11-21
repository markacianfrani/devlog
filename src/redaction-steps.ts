import type { Source } from "./config.ts";
import {
  CONTENT_BLOCK_TYPES,
  isSource,
  MESSAGE_ROLES,
  RELATION_KINDS,
  type ParseResult,
  type SessionMeta,
} from "./parsers/types.ts";
import { normalizeSecretLabel, redactLiterals, type LiteralSecret } from "./redaction.ts";
import {
  formatTruffleHogFinding,
  scanRedactedResult,
  type TruffleHogMode,
  type TruffleHogScan,
} from "./trufflehog.ts";

// A consumer-provided transform: devlog writes the redacted session JSON to
// the command's stdin and indexes what the command writes to stdout.
export interface RedactHookStep {
  readonly kind: "redact";
  readonly name: string;
  readonly command: string;
  readonly timeoutMs?: number;
  readonly cwd?: string;
}

// The built-in TruffleHog scan as a step, so it composes and orders like any
// other. `warn` prints masked findings; `redact` additionally scrubs them from
// the result. Neither ever drops a session.
export interface TruffleHogStep {
  readonly kind: "trufflehog";
  readonly mode: TruffleHogMode;
}

export type RedactionStep = RedactHookStep | TruffleHogStep;

export interface RedactionSessionInfo {
  readonly filePath: string;
  readonly source: Source;
  readonly project: string;
}

export interface RedactionOutcome {
  readonly result: ParseResult;
  // Whether any trufflehog step actually scanned, and what it found — a scan
  // that errored counts as unscanned, never as clean.
  readonly trufflehogScanned: boolean;
  readonly trufflehogFindings: number;
}

// Run the configured steps in order. A broken redact step must not lose a
// session from a local private index: every failure mode (non-zero exit,
// timeout, unparsable output) becomes a warning while the previous result
// stands, and no trufflehog mode ever drops a session.
export async function applyRedactionSteps(
  result: ParseResult,
  steps: readonly RedactionStep[],
  session: RedactionSessionInfo,
  onWarning: (message: string) => void,
): Promise<RedactionOutcome> {
  let current = result;
  let trufflehogScanned = false;
  let trufflehogFindings = 0;

  for (const step of steps) {
    if (step.kind === "redact") {
      current = await runRedactHookStep(step, current, session, onWarning);
      continue;
    }

    let scan: TruffleHogScan;
    try {
      scan = scanRedactedResult(current);
    } catch (err) {
      // A broken scanner must not lose a session either (a full or read-only
      // tmpdir throwing before the scan even starts counts): surface the
      // failure and carry on, reporting nothing as scanned.
      onWarning(`trufflehog scan failed: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (scan.error) {
      onWarning(scan.error);
      continue;
    }

    if (scan.dropped !== undefined && scan.dropped > 0) {
      // Partial output is not a clean scan: a dropped line may carry the
      // one secret in the session, and in redact mode it would never be
      // scrubbed. Report the count only — the lines carry raw secrets.
      onWarning(
        `trufflehog printed ${scan.dropped} line${
          scan.dropped === 1 ? "" : "s"
        } that parsed to no findings`,
      );
    }

    trufflehogScanned = true;
    trufflehogFindings += scan.findings.length;

    if (step.mode === "redact") {
      // Scrub every finding — verified or not — from the result before it
      // reaches the index. No session is dropped.
      const secrets: LiteralSecret[] = scan.findings.flatMap((finding) =>
        finding.raw
          ? [
              {
                value: finding.raw,
                replacement: `[REDACTED:${normalizeSecretLabel(finding.detector)}]`,
              },
            ]
          : [],
      );
      if (secrets.length > 0) {
        current = redactLiterals(current, secrets);
      }
    }

    // The claim is checked, not assumed: the scrub covers the content and
    // metadata fields the index binds, so a finding that survives somewhere
    // it cannot reach (a session id, say) is reported without the promise.
    const scrubbedJson = step.mode === "redact" ? JSON.stringify(current) : undefined;
    for (const finding of scan.findings) {
      const scrubbed =
        scrubbedJson !== undefined &&
        finding.raw !== undefined &&
        !scrubbedJson.includes(finding.raw) &&
        // JSON escapes quotes/backslashes inside string values; a raw secret
        // containing either would otherwise hide from the raw-text check.
        !scrubbedJson.includes(JSON.stringify(finding.raw).slice(1, -1));
      onWarning(
        scrubbed
          ? `${formatTruffleHogFinding(finding)} (redacted from the index)`
          : formatTruffleHogFinding(finding),
      );
    }
  }

  return { result: current, trufflehogScanned, trufflehogFindings };
}

const DEFAULT_HOOK_TIMEOUT_MS = 30_000;

async function runRedactHookStep(
  step: RedactHookStep,
  result: ParseResult,
  session: RedactionSessionInfo,
  onWarning: (message: string) => void,
): Promise<ParseResult> {
  try {
    return await runHook(step, result, session);
  } catch (err) {
    onWarning(
      `redaction hook "${step.name}" failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return result;
  }
}

async function runHook(
  hook: RedactHookStep,
  result: ParseResult,
  session: RedactionSessionInfo,
): Promise<ParseResult> {
  const proc = Bun.spawn(["/bin/sh", "-c", hook.command], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: hook.cwd,
    env: {
      ...process.env,
      DEVLOG_SESSION_FILE: session.filePath,
      DEVLOG_SOURCE: session.source,
      DEVLOG_PROJECT: session.project,
    },
  });

  const timeoutMs = hook.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
  const timer = setTimeout(() => {
    // SIGKILL, not SIGTERM: a hook that traps SIGTERM must not outlive its
    // timeout still holding the session JSON.
    proc.kill("SIGKILL");
  }, timeoutMs);

  let raceTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await proc.stdin.write(JSON.stringify(result));
    await proc.stdin.end();

    const outcome = await Promise.race([
      Promise.all([new Response(proc.stdout).text(), proc.exited]),
      new Promise<null>((resolve) => {
        // The losing arm's timer must be cleared in the finally below, or it
        // holds the event loop (and the CLI open) for the full timeout.
        raceTimer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);

    if (outcome === null) {
      throw new Error(`timed out after ${timeoutMs}ms`);
    }
    const [stdout, exitCode] = outcome;

    if (exitCode !== 0) {
      const stderr = (await new Response(proc.stderr).text()).trim();
      throw new Error(`exit ${exitCode}${stderr ? `: ${stderr.slice(0, 300)}` : ""}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout) as unknown;
    } catch {
      throw new Error("stdout was not valid JSON");
    }

    if (!isParseResult(parsed, result.meta)) {
      throw new Error(
        "stdout was not a session result (expected { meta, messages, prLinks, artifactLinks })",
      );
    }

    return parsed;
  } finally {
    clearTimeout(timer);
    if (raceTimer) {
      clearTimeout(raceTimer);
    }
  }
}

// `undefined` maps through toSqlValue to SQL NULL. JSON null is not "absent"
// and the types carry no null, so the gate rejects it: a hook that emits it
// lands on the warn-and-keep path instead of breaking the ParseResult claim.
function isNullableString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isNullableNumber(value: unknown): boolean {
  return value === undefined || typeof value === "number";
}

// Gate for hook output: the value must be indexable — every field the DB
// inserts bind must exist and hold a value the schema accepts (toSqlValue
// only maps undefined; JSON can still carry null and objects). Anything less
// and a misbehaving hook would throw on a CHECK or NOT NULL constraint (or
// fail the bind) inside indexSession, losing the session on every run
// instead of hitting the documented warn-and-keep-previous path.
function isParseResult(value: unknown, input: SessionMeta): value is ParseResult {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { meta, messages, prLinks, artifactLinks } = value as Record<string, unknown>;
  if (
    !Array.isArray(messages) ||
    !Array.isArray(prLinks) ||
    !Array.isArray(artifactLinks) ||
    !isIndexableMeta(meta)
  ) {
    return false;
  }
  // Identity is not the hook's to change: the session is archived under this
  // id/source/project, and a hook that relabels it (or swaps in another
  // session's messages) would silently corrupt the row this gate exists to
  // protect — the same harm class as a constraint crash, minus the crash.
  const metaRecord = meta as Record<string, unknown>;
  if (
    metaRecord["id"] !== input.id ||
    metaRecord["source"] !== input.source ||
    metaRecord["project"] !== input.project
  ) {
    return false;
  }
  if (!prLinks.every(isIndexablePrLink) || !artifactLinks.every(isIndexableArtifactLink)) {
    return false;
  }
  // messages PRIMARY KEY is (file_path, id): a duplicated id would throw on
  // the second insert inside indexSession, failing the session every run.
  const messageIds = new Set<unknown>();
  return messages.every((message) => {
    if (!isIndexableMessage(message)) {
      return false;
    }
    const record = message as Record<string, unknown>;
    if (record["sessionId"] !== metaRecord["id"]) {
      return false;
    }
    const id = record["id"];
    if (messageIds.has(id)) {
      return false;
    }
    messageIds.add(id);
    return true;
  });
}

// sessions columns: id/source/project are NOT NULL (source also CHECKed by
// SOURCES), the rest bind through toSqlValue, and relation_kind has its own
// CHECK (fork, subagent).
function isIndexableMeta(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const meta = value as Record<string, unknown>;
  const source = meta["source"];
  if (
    typeof meta["id"] !== "string" ||
    typeof source !== "string" ||
    !isSource(source) ||
    typeof meta["project"] !== "string" ||
    !isNullableString(meta["cwd"]) ||
    !isNullableString(meta["title"]) ||
    !isNullableString(meta["model"]) ||
    !isNullableString(meta["createdAt"]) ||
    !isNullableString(meta["updatedAt"]) ||
    !isNullableString(meta["parentSessionId"])
  ) {
    return false;
  }
  const relationKind = meta["relationKind"];
  // The type union has no null, and JSON null is not "absent": reject it
  // instead of binding NULL past the CHECK constraint.
  if (
    relationKind !== undefined &&
    !(RELATION_KINDS as readonly string[]).includes(relationKind as string)
  ) {
    return false;
  }
  return isIndexableWorktree(meta["worktree"]);
}

// session_worktrees columns: worktreePath/worktreeName are NOT NULL.
function isIndexableWorktree(value: unknown): boolean {
  if (value === undefined || value === null) {
    return true;
  }
  if (typeof value !== "object") {
    return false;
  }
  const w = value as Record<string, unknown>;
  return (
    typeof w["worktreePath"] === "string" &&
    typeof w["worktreeName"] === "string" &&
    isNullableString(w["originalCwd"]) &&
    isNullableString(w["worktreeBranch"]) &&
    isNullableString(w["originalBranch"]) &&
    isNullableString(w["originalHeadCommit"])
  );
}

function isIndexableMessage(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const role = record["role"];
  const usageIdentity = record["usageIdentity"];
  return (
    typeof record["id"] === "string" &&
    typeof record["sessionId"] === "string" &&
    typeof record["timestamp"] === "string" &&
    typeof role === "string" &&
    (MESSAGE_ROLES as readonly string[]).includes(role) &&
    Array.isArray(record["content"]) &&
    (record["content"] as unknown[]).every((block) => isIndexableBlock(block, role)) &&
    isNullableString(record["parentId"]) &&
    isNullableString(record["model"]) &&
    isNullableString(record["agentId"]) &&
    isNullableNumber(record["tokensIn"]) &&
    isNullableNumber(record["tokensOut"]) &&
    isNullableNumber(record["cacheReadTokens"]) &&
    isNullableNumber(record["cacheWriteTokens"]) &&
    isNullableNumber(record["reasoningTokens"]) &&
    (usageIdentity === undefined || isIndexableUsageIdentity(usageIdentity))
  );
}

// messages.api_message_id/request_id bind through toSqlValue from here.
// messageId and isSidechain are required by UsageIdentity — JSON null is not
// "absent" — so the predicate checks exactly what the type asserts.
function isIndexableUsageIdentity(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const identity = value as Record<string, unknown>;
  return (
    typeof identity["messageId"] === "string" &&
    isNullableString(identity["requestId"]) &&
    typeof identity["isSidechain"] === "boolean"
  );
}

// Each block type must carry the field(s) its insert binds without a
// fallback: text/thinking/tool_use/tool_result would otherwise push
// undefined into a NOT NULL or FTS column. The role narrows the union:
// UserContentBlock has no tool_use/thinking member, so a gate-passed
// thinking block on a user message would fall out of
// redactUserContentBlock's exhaustive switch as undefined and throw inside
// indexSession instead of hitting this gate's warn-and-keep path.
const USER_BLOCK_TYPES = new Set(["text", "tool_result", "image", "document"]);

function isIndexableBlock(value: unknown, role: string): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const type = record["type"];
  if (typeof type !== "string") {
    return false;
  }
  if (!(CONTENT_BLOCK_TYPES as readonly string[]).includes(type)) {
    return false;
  }
  if (role === "user" && !USER_BLOCK_TYPES.has(type)) {
    return false;
  }
  switch (type) {
    case "text":
      return typeof record["text"] === "string";
    case "tool_use":
      return (
        typeof record["toolName"] === "string" &&
        isNullableString(record["toolInput"]) &&
        isNullableString(record["toolUseId"])
      );
    case "tool_result":
      return typeof record["toolOutput"] === "string" && isNullableString(record["toolUseId"]);
    case "thinking":
      return typeof record["thinking"] === "string";
    default:
      // redacted_thinking binds nothing; image/document bind mediaType.
      return isNullableString(record["mediaType"]);
  }
}

function isIndexablePrLink(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record["sessionId"] === "string" &&
    typeof record["prNumber"] === "number" &&
    typeof record["prUrl"] === "string" &&
    typeof record["prRepository"] === "string" &&
    typeof record["timestamp"] === "string"
  );
}

function isIndexableArtifactLink(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record["sessionId"] === "string" &&
    typeof record["path"] === "string" &&
    typeof record["artifactUrl"] === "string" &&
    typeof record["timestamp"] === "string"
  );
}
