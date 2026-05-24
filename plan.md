# Plan: Decompose archive.ts

## Problem

`archive.ts` is 1013 lines and serves as the CLI entry point, the archive
orchestrator, the index orchestrator, the implementation for all three source
archive flows (Claude, opencode, Pi), and a re-export surface for opencode
utilities. It also holds duplicated functions that exist elsewhere:

- `slugFromPath` duplicated in `mcp-server.ts`
- `ensureDir` duplicated in `db.ts`
- Help text copy-pasted between `--help` and `default:` branches
- `redactParseResult` alias in `redaction.ts` wrapping `redactForIndexing`

## Proposed Architecture

```
src/
  cli.ts                     main(), arg parsing, help text, dispatch
  archive.ts                 archiveMain() + indexMain() orchestrators
  sources/
    types.ts                 ArchiveStats, SourceSummary, ArchiveSourceFn
    shared.ts                slugFromPath, ensureDir, matchesExcludedProject,
                              normalizeProjectMatcher, archiveConversation
    claude.ts                Claude archive logic
    opencode.ts              opencode archive logic (absorbs src/opencode.ts)
    pi.ts                    Pi archive logic
  config.ts                  unchanged
  db.ts                      import ensureDir from sources/shared
  indexer.ts                 unchanged
  init.ts                    unchanged
  mcp-server.ts              import slugFromPath from sources/shared
  progress.ts                unchanged
  redaction.ts               delete redactParseResult alias
  parsers/                   unchanged
```

## Shared Interface

All three source modules export a function with the same signature:

```ts
type ArchiveSourceFn = (
  options: CliOptions,
  progress?: ProgressReporter,
) => SourceSummary;
```

The opencode module encapsulates its DB/file fallback internally instead of
leaking a `handled` boolean to the caller.

No classes. Three sources is unlikely to grow, and there's no polymorphic
behavior. Same-signature functions are sufficient.

## Line Count Targets

| File                      | Current | Target | Notes                      |
|---------------------------|---------|--------|----------------------------|
| `archive.ts`              | 1013    | ~120   | orchestrators only         |
| `cli.ts`                  | (inside)| ~90    | extracted from archive.ts  |
| `sources/claude.ts`       | (inside)| ~170   |                            |
| `sources/opencode.ts`     | 268+    | ~380   | absorbs src/opencode.ts    |
| `sources/pi.ts`           | (inside)| ~220   |                            |
| `sources/types.ts`        | (inside)| ~35    |                            |
| `sources/shared.ts`       | (scattered)| ~30 |                            |
| `db.ts`                   | 285     | ~280   | removes duplicate ensureDir|
| `mcp-server.ts`           | 410     | ~400   | removes duplicate slug     |
| `redaction.ts`            | 263     | ~260   | removes alias              |

## Dependency Graph After

```
cli.ts
  → archive.ts
  → mcp-server.ts
  → init.ts

archive.ts
  → sources/claude.ts
  → sources/opencode.ts
  → sources/pi.ts
  → sources/shared.ts
  → sources/types.ts
  → indexer.ts
  → progress.ts
  → db.ts
  → config.ts

sources/claude.ts
  → sources/shared.ts, sources/types.ts, config.ts

sources/opencode.ts
  → sources/shared.ts, sources/types.ts, config.ts

sources/pi.ts
  → sources/shared.ts, sources/types.ts, config.ts

mcp-server.ts
  → sources/shared.ts, db.ts, config.ts

db.ts
  → sources/shared.ts, config.ts
```

No cross-dependencies between source modules. Each source module depends only
on shared utilities, types, and config.

## Implementation Plan

### Step 1: Create sources/types.ts

Extract from archive.ts:

- `ArchiveStats` interface
- `SourceSummary` interface
- `ArchiveSourceFn` type (new)

Update imports in `progress.ts` (it uses `SourceSummary`).

### Step 2: Create sources/shared.ts

Extract from archive.ts:

- `ensureDir(dirPath)` — the copy from archive.ts
- `slugFromPath(projectPath)` — the copy from archive.ts
- `normalizeProjectMatcher(value)`
- `matchesExcludedProject(...candidates)` — needs `config`, so it takes
  `excludeProjects: string[]` as a parameter instead of reading config
  directly. This decouples it from the module-level `config` binding.
- `archiveConversation(sourcePath, projectName, archiveBaseDir, archiveRelPath)`
  — generic "copy if mtime changed" used by Claude and Pi.

Update `db.ts` to import `ensureDir` from `sources/shared.ts` instead of
defining its own.

Update `mcp-server.ts` to import `slugFromPath` from `sources/shared.ts`
instead of defining its own.

### Step 3: Create sources/claude.ts

Extract from archive.ts, in dependency order:

- `CLAUDE_PROJECTS_DIR` constant
- `ConversationFile` interface
- `getConversationFiles(projectPath)`
- `countClaudeConversations()` → rename to `countSessions()`
- `getClaudeProjectSlug(projectName)`
- `countExchanges(filePath)`
- `archiveClaudeProject(project, logger, options, stats, progress)`
- `archiveClaudeProjects()` → rename to `archive()` and export as the
  `ArchiveSourceFn`

Internal helpers (`createArchiveStats`, `tickArchiveProgress`,
`recordArchived`, `recordSkipped`, `makeSummary`, `logProjectRollup`) that
are used by this module get absorbed locally or moved to `sources/types.ts`
if all three modules share them.

### Step 4: Create sources/pi.ts

Extract from archive.ts:

- `PI_SESSIONS_DIR` constant
- `PiSessionHeader` interface
- `getPiSessionHeader(filePath)`
- `countPiUserMessages(filePath)`
- `countPiSessions()` → rename to `countSessions()`
- `iteratePiSessionFiles()` generator
- `iteratePiSubagentFiles()` generator
- `archiveSinglePiSession(...)`
- `archivePiSessions()` → rename to `archive()` and export as
  `ArchiveSourceFn`

Pi currently rolls its own stats inline instead of using the shared
`createArchiveStats`/`makeSummary` helpers. Unify it to use the same
pattern as Claude for consistency.

### Step 5: Create sources/opencode.ts

This is the biggest module because it absorbs both the current `src/opencode.ts`
(source adapter) and the opencode archive functions from `archive.ts`.

Absorb from `src/opencode.ts`:
- All types (`OpencodeMessage`, `OpencodePart`, `OpencodeSession`,
  `MessageWithParts`)
- `readJsonFilesFromDir`, `readMessageParts`, `getSessionMessages`
- `buildMessageContent`, `loadMessagesFromFiles`
- `reconstructSessionJsonl`, `countUserMessages`
- `iterateOpencodeDbSessions`

Absorb from `archive.ts`:
- `OPENCODE_DB_PATH`, `OPENCODE_STORAGE_DIR`, and related path constants
- `getOpencodeSessionFiles`, `countOpencodeFileSessions`
- `getOpencodeDbSessionCount`
- `getWorktreeFromProjectFile`, `getOpencodeProjectSlug`
- `archiveOpencodeProject`, `archiveOpencodeSession`
- `archiveOpencodeDbSession`, `archiveOpencodeFromDb`
- `archiveOpencodeWorkspace`, `archiveOpencodeFromFiles`

The public surface is `archive(): SourceSummary` which encapsulates the
DB-then-file fallback internally:

```ts
export function archive(
  options: CliOptions,
  progress?: ProgressReporter,
): SourceSummary {
  const dbResult = archiveFromDb(options, progress);
  if (dbResult.handled) {
    return dbResult.summary;
  }
  if (fs.existsSync(OPENCODE_SESSIONS_DIR)) {
    return archiveFromFiles(options, progress);
  }
  progress?.warn("[devlog] opencode storage not found");
  return { ...dbResult.summary, warnings: dbResult.summary.warnings + 1 };
}
```

Re-export `iterateOpencodeDbSessions`, `reconstructSessionJsonl`,
`slugFromPath` for the test that currently imports them from `archive.ts`.

Delete `src/opencode.ts` after everything is absorbed.

### Step 6: Create sources/shared.ts helpers

Decide on the stats helpers. Three options:

**Option A:** Move to `sources/types.ts` as utility functions.
`createArchiveStats()`, `makeSummary()` are small and stateless.

**Option B:** Keep them inline in each source module. They're ~15 lines total.

**Option C:** Make `ArchiveStats` a class with `recordArchived()`,
`recordSkipped()`, `tick()` methods.

Go with **Option A** — `createArchiveStats` and `makeSummary` go in
`sources/types.ts`. `tickArchiveProgress`, `recordArchived`,
`recordSkipped`, `logProjectRollup` are thin wrappers that couple stats to
progress reporting. Fold them into each source module directly (they're 2-3
lines each and every source uses them slightly differently).

### Step 7: Rewrite archive.ts

`archive.ts` becomes ~120 lines:

```ts
// Constants
const ARCHIVE_DIR = config.archiveDir;
const PROJECTS_ARCHIVE_DIR = path.join(ARCHIVE_DIR, "projects");

// archiveMain — orchestrator
async function archiveMain(options) {
  const progress = new ProgressReporter(options);
  ensureDir(ARCHIVE_DIR);
  ensureDir(PROJECTS_ARCHIVE_DIR);

  const summaries: SourceSummary[] = [];
  if (!isExcluded("claude"))
    summaries.push(claude.archive(options, progress));
  if (!isExcluded("opencode"))
    summaries.push(opencode.archive(options, progress));
  if (!isExcluded("pi"))
    summaries.push(pi.archive(options, progress));

  printArchiveSummary(summaries, ARCHIVE_DIR, Date.now() - startedAt);
}

// indexMain — unchanged structure, just imports
async function indexMain(rebuild, options) { ... }
```

No re-exports. The opencode test imports move to `sources/opencode.ts`.

### Step 8: Create cli.ts

Extract from `archive.ts`:

- `main()` function
- Help text constant (defined once)
- `import.meta.main` check
- `#!/usr/bin/env bun` shebang

Change `package.json` build target from `src/archive.ts` to `src/cli.ts`.

### Step 9: Clean up redaction.ts

Delete `export const redactParseResult = redactForIndexing;`.

Update `parsers.test.ts` and `redaction.test.ts` to import
`redactForIndexing` directly.

### Step 10: Update build and test imports

- `package.json`: `"build:cli": "bun build src/cli.ts --outfile dist/cli.js --target bun"`
- `src/__tests__/archive-fixtures.ts`: update `BIN_PATH` to point at
  `src/cli.ts`
- `src/__tests__/archive-opencode.test.ts`: update imports from
  `../archive.ts` to `../sources/opencode.ts` and `../sources/shared.ts`
- `src/__tests__/parsers.test.ts`: `redactParseResult` → `redactForIndexing`
- `src/__tests__/redaction.test.ts`: same

### Step 11: Update db.ts

Remove the local `ensureDir` function. Import from `sources/shared.ts`.

### Step 12: Update mcp-server.ts

Remove the local `slugFromPath` function. Import from `sources/shared.ts`.

## Execution Order

Steps 1-2 first (shared types and utilities, no behavior change).
Then steps 3-5 in parallel (source modules, no behavior change — they're
extracts, not rewrites).
Then steps 6-8 (archive.ts rewrite, cli.ts extraction).
Then steps 9-12 (cleanup, build config, test updates).

Each step should be a single commit that passes all tests. The intermediate
state after steps 1-5 has the new modules coexisting with the old archive.ts
(the new modules are unused but compilable). Steps 6-8 switch the wiring.
Steps 9-12 clean up the dead code.

## Risks

- The opencode test imports directly from `archive.ts`. Step 5 must re-export
  from `sources/opencode.ts` so the test can be updated in step 10 without
  breaking mid-migration.
- The Claude and Pi archive tests run `archive.ts` as a subprocess. Changing
  the build target in step 10 must happen in the same commit as the `BIN_PATH`
  update in the test fixture.
- `matchesExcludedProject` currently reads from the module-level `config`
  binding. Decoupling it to take `excludeProjects: string[]` as a parameter
  changes the call site but is straightforward.
