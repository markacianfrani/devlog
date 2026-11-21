import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ParseResult } from "./parsers/types.ts";

// A trufflehog step's mode. "Off" is not a mode: the scan is on if the step
// appears in redaction.steps and absent otherwise.
//
// warn: print masked findings, index anyway.
// redact: scrub every finding's raw secret from the result before it reaches
// the index, then index — the wire-safe mode: what MCP serves up never
// contains what the scanner found.
export type TruffleHogMode = "warn" | "redact";

export type TruffleHogFindingStatus = "verified" | "unverified" | "unknown";

export interface TruffleHogFinding {
  readonly detector: string;
  readonly status: TruffleHogFindingStatus;
  // Line in the serialized temp copy; orders findings, never displayed.
  readonly line?: number;
  readonly masked: string;
  readonly rawSha256?: string;
  // The live secret value, kept in-process for "redact" mode to scrub with.
  // Never print or log this; masked is the only display form.
  readonly raw?: string;
}

export interface TruffleHogScan {
  readonly findings: readonly TruffleHogFinding[];
  readonly error?: string;
  // Non-empty stdout lines that parsed to no finding, so a partial scan is
  // never reported as clean. The count is all that ever surfaces — the lines
  // themselves may carry raw secrets.
  readonly dropped?: number;
}

// Verification calls provider APIs with candidate secrets, so the scan can be
// slow; give it a generous ceiling before killing the child process.
const TRUFFLEHOG_TIMEOUT_MS = 60_000;

const TRUFFLEHOG_ARGS = [
  "-j",
  "--results=verified,unknown,unverified",
  "--no-color",
  "--no-update",
] as const;

export interface TruffleHogAvailability {
  readonly available: boolean;
  // `missing` is true only when the binary is not on PATH at all. A binary
  // that exists but fails its probe carries the failure in `problem` — the
  // caller's warning must tell "install it" from "fix it" instead of sending
  // the user to reinstall a binary that is already there.
  readonly missing: boolean;
  readonly problem?: string;
}

let availabilityCache: TruffleHogAvailability | undefined;

export function checkTruffleHogAvailability(): TruffleHogAvailability {
  if (availabilityCache === undefined) {
    const probe = spawnSync("trufflehog", ["--version"], { encoding: "utf8", timeout: 10_000 });
    if (probe.error) {
      availabilityCache =
        (probe.error as NodeJS.ErrnoException).code === "ENOENT"
          ? { available: false, missing: true, problem: "not found on PATH" }
          : {
              available: false,
              missing: false,
              problem: `failed to start: ${probe.error.message}`,
            };
    } else if (probe.status !== 0) {
      // status is null when the probe was killed by a signal: unusable either way.
      availabilityCache = {
        available: false,
        missing: false,
        problem: `--version probe exited ${probe.status ?? "by signal"}`,
      };
    } else {
      availabilityCache = { available: true, missing: false };
    }
  }
  return availabilityCache;
}

export function isTruffleHogAvailable(): boolean {
  return checkTruffleHogAvailability().available;
}

/** Test-only: reset the availability probe cache. */
export function resetTruffleHogAvailabilityCache(): void {
  availabilityCache = undefined;
}

// One session per scan: devlog indexes sessions one at a time, so there is
// nothing to batch. TruffleHog sees only the redacted result — a secret the
// built-in redaction already replaced never reaches verification.
export function scanRedactedResult(result: ParseResult): TruffleHogScan {
  const dir = mkdtempSync(join(tmpdir(), "devlog-trufflehog-"));
  try {
    writeFileSync(join(dir, "session.json"), JSON.stringify(result));
    const scan = spawnSync("trufflehog", ["filesystem", dir, ...TRUFFLEHOG_ARGS], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: TRUFFLEHOG_TIMEOUT_MS,
    });

    if (scan.error) {
      if ((scan.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
        // A ran-too-long scan is not a missing binary; point at the ceiling.
        return {
          findings: [],
          error: `trufflehog timed out after ${TRUFFLEHOG_TIMEOUT_MS}ms`,
        };
      }
      return { findings: [], error: `trufflehog failed to start: ${scan.error.message}` };
    }
    if (scan.status !== 0) {
      const stderr = scan.stderr.trim();
      // status is null when the scanner was killed by a signal (OOM, a
      // sandbox kill): as unusable as a non-zero exit, never a clean scan.
      const died =
        scan.status === null
          ? `was killed by ${scan.signal ?? "an unknown signal"}`
          : `exited ${scan.status}`;
      return {
        findings: [],
        error: `trufflehog ${died}${stderr ? `: ${stderr.slice(0, 300)}` : ""}`,
      };
    }
    const { findings, dropped } = parseTruffleHogOutput(scan.stdout);
    if (findings.length === 0 && scan.stdout.trim() !== "") {
      // Empty stdout is a clean scan; output we cannot read as findings is
      // not. Report the shape only — stdout carries raw secrets.
      return {
        findings: [],
        error: `trufflehog printed ${scan.stdout.length} bytes of output that parsed to no findings`,
      };
    }
    return { findings, dropped };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// TruffleHog prints one JSON object per line when it finds something. Lines
// it printed that parse to no finding are counted and reported — never
// silently dropped, since a dropped line may carry the one secret in the
// session.
function parseTruffleHogOutput(stdout: string): {
  findings: TruffleHogFinding[];
  dropped: number;
} {
  const findings = new Map<string, TruffleHogFinding>();
  let dropped = 0;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      dropped++;
      continue;
    }

    const finding = parseTruffleHogFinding(parsed);
    if (!finding) {
      dropped++;
      continue;
    }

    const key = JSON.stringify([
      finding.detector,
      finding.status,
      finding.line ?? -1,
      finding.rawSha256 ?? "",
    ]);
    if (!findings.has(key)) {
      findings.set(key, finding);
    }
  }

  return {
    findings: [...findings.values()].sort((a, b) => {
      const lineA = a.line ?? Number.MAX_SAFE_INTEGER;
      const lineB = b.line ?? Number.MAX_SAFE_INTEGER;
      if (lineA !== lineB) {
        return lineA - lineB;
      }
      return a.detector.localeCompare(b.detector);
    }),
    dropped,
  };
}

function parseTruffleHogFinding(value: unknown): TruffleHogFinding | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record["DetectorName"] !== "string") {
    return undefined;
  }

  const raw =
    typeof record["Raw"] === "string" && record["Raw"].length > 0 ? record["Raw"] : undefined;

  return {
    detector: record["DetectorName"],
    status: parseFindingStatus(record),
    line: readSourceLine(record),
    // Never print a finding raw; keep a short hash so two findings can be
    // compared without either secret being recoverable.
    masked: raw ? maskSecret(raw) : "[REDACTED]",
    rawSha256: raw ? createHash("sha256").update(raw).digest("hex").slice(0, 16) : undefined,
    raw,
  };
}

function parseFindingStatus(record: Record<string, unknown>): TruffleHogFindingStatus {
  if (record["Verified"] === true) {
    return "verified";
  }

  // TruffleHog reports why verification could not conclude; surface that as
  // "unknown" rather than pretending the secret is fine.
  const extraData =
    typeof record["ExtraData"] === "object" && record["ExtraData"] !== null
      ? (record["ExtraData"] as Record<string, unknown>)
      : undefined;
  if (extraData) {
    for (const key of ["verification_error", "verificationError", "error"]) {
      const value = extraData[key];
      if (typeof value === "string" && value.trim() !== "") {
        return "unknown";
      }
    }
  }

  return "unverified";
}

function readSourceLine(record: Record<string, unknown>): number | undefined {
  const sourceMetadata = record["SourceMetadata"];
  if (typeof sourceMetadata !== "object" || sourceMetadata === null) {
    return undefined;
  }
  const data = (sourceMetadata as Record<string, unknown>)["Data"];
  if (typeof data !== "object" || data === null) {
    return undefined;
  }
  const filesystem = (data as Record<string, unknown>)["Filesystem"];
  if (typeof filesystem !== "object" || filesystem === null) {
    return undefined;
  }
  const line = (filesystem as Record<string, unknown>)["line"];
  return typeof line === "number" ? line : undefined;
}

// Keep enough context to recognize a finding without revealing the secret.
// The floor must keep a meaningful tail hidden: at length 9 the 4+4 reveal
// would expose 8 of 9 characters, defeating the mask entirely.
function maskSecret(raw: string): string {
  if (raw.length < 12) {
    return "***";
  }
  const prefixLength = Math.min(4, raw.length - 4);
  const suffixLength = Math.min(4, raw.length - prefixLength);
  return `${raw.slice(0, prefixLength)}***${raw.slice(raw.length - suffixLength)}`;
}

// No line number: the scan runs on a serialized temp copy, so any location
// would point at the temp file, not at the user's session.
export function formatTruffleHogFinding(finding: TruffleHogFinding): string {
  return `trufflehog ${finding.status} ${finding.detector}: ${finding.masked}`;
}
