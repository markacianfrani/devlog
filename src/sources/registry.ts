import { parseClaudeSession } from "../parsers/claude.ts";
import { parseOpenCodeSession } from "../parsers/opencode.ts";
import { parsePiSession } from "../parsers/pi.ts";
import type { ParseOutcome, Source } from "../parsers/types.ts";
import * as claude from "./claude.ts";
import * as opencode from "./opencode.ts";
import * as pi from "./pi.ts";
import type { ArchiveSourceFn } from "./types.ts";

// The single place that wires up a source. `archive` discovers and copies raw
// sessions from the local tool; `parse` reads one archived jsonl back into a
// ParseOutcome for indexing. Adding a new source means adding one entry here —
// the archive loop and the indexer dispatch both read from this map.
export interface SourceAdapter {
  archive: ArchiveSourceFn;
  parse: (jsonlPath: string, project: string) => Promise<ParseOutcome>;
}

export const SOURCE_ADAPTERS: Record<Source, SourceAdapter> = {
  claude: { archive: claude.archive, parse: parseClaudeSession },
  opencode: { archive: opencode.archive, parse: parseOpenCodeSession },
  pi: { archive: pi.archive, parse: parsePiSession },
};
