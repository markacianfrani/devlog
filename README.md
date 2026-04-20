# Devlog

Devlog copies all your coding dingus transcripts to a Third Location so you have access to them after their default retention period deletes them.

Supports **Claude Code**, **Opencode**, and **pi**.

## Quick start

### Install locally

```bash
bun install
devlog init
```

### Install globally

If you want `devlog` available as a global command:

```bash
# Build the CLI first
bun run build:cli

# Link the package globally
bun link -g devlog
```

Or if `bun link -g` fails (known Bun issue), manually create the symlink:

```bash
bun run build:cli
bun link
rm -f ~/.bun/bin/devlog
ln -s "$(pwd)/dist/cli.js" ~/.bun/bin/devlog
```

After setup, run:

```bash
devlog init
```

`devlog init` asks where to store your archive (default: `~/devlog`) and which agents to configure the MCP server for.

## Commands

```bash
devlog archive          # copy new sessions to your archive
devlog index            # index archived sessions into SQLite for search
devlog mcp              # start the MCP server (stdio)
devlog init             # first-time setup
```

`archive` and `index` skip files that haven't changed since the last run.

### Options

```
--verbose    show per-project and per-session details
--debug      extra noisy diagnostics
--rebuild    (index only) wipe the database and re-index everything
```

## MCP server

After running `devlog init`, you can search your session history from inside your coding agent.

**Tools:** `search`, `list_sessions`, `get_session`, `schema`, `query`

If you don't want to use an MCP, write a skill and that describes where the sqlite or sessions are stored.

```
search past sessions for "auth middleware"
list sessions for project "quoting-ui"
get session <session_id>
```

Raw SQL works too:

```sql
SELECT project, COUNT(*) as n FROM sessions GROUP BY project ORDER BY n DESC
```

## How it works

**Archive** reads each agent's local session data and writes it to `~/devlog/` as normalized JSONL. Claude Code and pi store sessions as files, so devlog copies those directly. Opencode stores sessions in a SQLite database now, so devlog extracts and converts them.

**Index** parses the archived JSONL into a SQLite database with full-text search (FTS5, porter stemming). Before content is written to SQLite, devlog does a best-effort scrub of common credential patterns plus exact matches for sensitive environment variable values such as `OPENAI_API_KEY` and `GITHUB_TOKEN`. The MCP server reads from that database.

### Where redaction applies

Redaction runs **only** on content written to the SQLite index, which is the surface your coding agent queries through the MCP server. Archived JSONL files in `~/devlog/` are **copied byte-for-byte** from the source session files — they are never rewritten or scrubbed. This is deliberate:

- The archive is meant to be a faithful backup of what the agent actually saw. Rewriting it would make it impossible to diff against the source or recover the original context.
- The index is the queryable surface. Scrubbing there is where it prevents secrets from leaking into search results or MCP responses.

If you need the archive itself to be clean, scrub it out-of-band (e.g., wipe a session file, then `devlog index --rebuild`). The scrubber is intentionally narrow: it helps avoid casually surfacing secrets, but it is **not** a full PII/privacy sanitizer.

### Session sources

| Agent       | Source                                | Format |
| ----------- | ------------------------------------- | ------ |
| Claude Code | `~/.claude/projects/`                 | JSONL  |
| opencode    | `~/.local/share/opencode/opencode.db` | SQLite |
| pi          | `~/.pi/agent/sessions/`               | JSONL  |

## File layout

Follows the [XDG Base Directory](https://specifications.freedesktop.org/basedir-spec/latest/) spec:

| What     | Path                                            | XDG directory     |
| -------- | ----------------------------------------------- | ----------------- |
| Config   | `~/.config/devlog/config.json`                  | `XDG_CONFIG_HOME` |
| Archive  | `~/devlog/` (configurable)                      | user-chosen       |
| Index DB | `~/.local/state/devlog/index.db` (configurable) | `XDG_STATE_HOME`  |

Rebuild the index from the archive at any time with `devlog index --rebuild`.

### Configuration

`~/.config/devlog/config.json` (created by `devlog init`):

```json
{
  "archiveDir": "/Users/you/devlog",
  "dbPath": "/Users/you/devlog/index.db",
  "excludeProjects": ["fidelio", "scratch"]
}
```

| Key               | Default                          | What it does                                                                                   |
| ----------------- | -------------------------------- | ---------------------------------------------------------------------------------------------- |
| `archiveDir`      | `~/.config/devlog`               | Where raw JSONL session copies are written.                                                    |
| `dbPath`          | `~/.local/state/devlog/index.db` | Where the SQLite index lives. Both `devlog index` and `devlog mcp` read this key.              |
| `excludeProjects` | `[]`                             | Fuzzy, case-insensitive substring matches against project slugs/paths. Full slug not required. |

`excludeProjects` examples:

- `"fidelio"` matches `-Users-you-src-tries-2026-02-17-fidelio`
- `"scratch"` matches `/Users/you/Code/scratchpad`

## Requirements

- [Bun](https://bun.sh)
