import path from "node:path";

import type { PiRelationshipAdapter } from "./pi-relationships.ts";

// pi-subagents' archiver names child transcripts
// <parent-file-base>__<run-id>__run-N.jsonl.
function archivedParent(jsonlPath: string): string | undefined {
  return /_([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})__[^/\\]+__run-\d+\.jsonl$/i.exec(
    jsonlPath,
  )?.[1];
}

function parentArchiveName(jsonlPath: string): string | undefined {
  if (!archivedParent(jsonlPath)) {
    return undefined;
  }
  const base = path.basename(jsonlPath);
  const group = /^(.+)__[^/\\]+__run-\d+\.jsonl$/i.exec(base)?.[1];
  return group ? `${group}.jsonl` : undefined;
}

export const piSubagents: PiRelationshipAdapter = {
  archiveEvidence(jsonlPath) {
    const parentSessionId = archivedParent(jsonlPath);
    return parentSessionId ? { parentSessionId, relationKind: "subagent" } : undefined;
  },
  parentArchiveName,
};
