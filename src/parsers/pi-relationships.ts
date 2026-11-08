import path from "node:path";

import { piSubagents } from "./pi-subagents.ts";

export interface PiRelationshipAdapter {
  archiveEvidence(
    jsonlPath: string,
  ): { parentSessionId: string; relationKind: "fork" | "subagent" } | undefined;
  parentArchiveName?(jsonlPath: string): string | undefined;
}

// Only registered producers may classify a Pi session. A header alone has no kind.
const ADAPTERS: readonly PiRelationshipAdapter[] = [piSubagents];

export function resolvePiRelationship(
  headerParent: string | undefined,
  jsonlPath: string,
): { parentSessionId?: string; relationKind?: "fork" | "subagent" } {
  const evidence = ADAPTERS.flatMap((adapter) => adapter.archiveEvidence(jsonlPath) ?? []);
  const distinct = new Set(
    evidence.map((item) => `${item.relationKind}:${item.parentSessionId.toLowerCase()}`),
  );
  const archived = distinct.size === 1 ? evidence[0] : undefined;
  const parentSessionId = headerParent ?? archived?.parentSessionId;
  const headerId = headerParent
    ?.match(/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/gi)
    ?.at(-1)
    ?.toLowerCase();
  const consistent = !headerParent || headerId === archived?.parentSessionId.toLowerCase();
  return {
    ...(parentSessionId ? { parentSessionId } : {}),
    ...(archived && consistent ? { relationKind: archived.relationKind } : {}),
  };
}

// A Pi core parentSession path and a producer's archived child filename are
// independent locators. null means they conflict; never fall back to an ID match.
export function piParentArchiveName(
  childFile: string,
  parentReference: string,
): string | null | undefined {
  if (
    ADAPTERS.some((adapter) => adapter.archiveEvidence(childFile)) &&
    !resolvePiRelationship(parentReference, childFile).relationKind
  ) {
    return null;
  }
  const names = new Set(
    ADAPTERS.flatMap((adapter) => adapter.parentArchiveName?.(childFile) ?? []),
  );
  if (/[\\/]/.test(parentReference) && parentReference.endsWith(".jsonl")) {
    const name = path.basename(parentReference);
    return names.size > 0 && (names.size !== 1 || !names.has(name)) ? null : name;
  }
  return names.size === 1 ? names.values().next().value : undefined;
}
