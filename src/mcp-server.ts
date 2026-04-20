import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import path from "node:path";
import { z } from "zod";
import { loadConfig } from "./config.ts";
import { getDb } from "./db.ts";

const CONFIGURED_DB_PATH = loadConfig().dbPath;

const INSTRUCTIONS = `You have access to the devlog session index — a SQLite database of past Claude Code and opencode conversations.

## Workflow

For natural language questions ("how did I handle X in project Y"):
1. Call \`search\` with relevant keywords — no need to call \`schema\` first.
2. Call \`get_session\` with the \`session_id\` from the results.

For project-scoped browsing:
1. Call \`list_sessions\` with \`project\` set to a name keyword (e.g. "quoting-ui") or absolute path.
2. Call \`get_session\` to read a specific session.

## get_session

- Pass the session_id value as the \`id\` parameter.
- Returns text-only by default, 50 messages at a time. The response footer shows total count and next offset.
- Pass \`include_tools: true\` only if you need to see tool I/O.

## query tool

Call \`schema\` first before writing raw SQL — the most common mistake is \`updated\` instead of \`updated_at\`. Do NOT call \`schema\` for search or list_sessions.`;

function slugFromPath(cwdPath: string): string {
  const segments = path
    .resolve(cwdPath)
    .split(path.sep)
    .filter(Boolean)
    .map((s) => s.replace(/[^a-zA-Z0-9]/g, "-"))
    .join("-");
  return `-${segments}`;
}

interface SessionRow {
  session_id: string;
  source: string;
  project: string;
  cwd: string | null;
  title: string | null;
  model: string | null;
  created_at: string | null;
  updated_at: string | null;
}

interface SearchRow extends SessionRow {
  snippet: string;
}

interface BlockRow {
  msg_id: string;
  role: string;
  timestamp: string | null;
  block_index: number | null;
  block_type: string | null;
  text: string | null;
  tool_name: string | null;
  tool_input: string | null;
  tool_output: string | null;
}

function formatSessionHeader(row: SessionRow): string {
  return [
    `session_id: ${row.session_id}`,
    `source: ${row.source}`,
    `project: ${row.project}`,
    row.title ? `title: ${row.title}` : undefined,
    row.model ? `model: ${row.model}` : undefined,
    row.cwd ? `cwd: ${row.cwd}` : undefined,
    row.updated_at
      ? `updated: ${row.updated_at}`
      : row.created_at
        ? `created: ${row.created_at}`
        : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

function registerSearch(server: McpServer) {
  server.tool(
    "search",
    "Full-text search across all past session transcripts. Returns matching sessions with context snippets. Use this to find sessions where a topic was discussed.",
    {
      query: z
        .string()
        .describe("Search query (supports FTS5 syntax e.g. 'word1 word2', '\"exact phrase\"')"),
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .default(10)
        .describe("Max results (default 10)"),
    },
    async ({ query, limit }) => {
      const db = getDb(CONFIGURED_DB_PATH);
      const rows = db
        .query<SearchRow, [string, number]>(
          `SELECT DISTINCT s.session_id, s.source, s.project, s.cwd, s.title, s.model,
					        s.created_at, s.updated_at,
					        snippet(messages_fts, 2, '<<', '>>', '...', 20) as snippet
					 FROM messages_fts
					 JOIN sessions s ON messages_fts.session_id = s.session_id
					 WHERE messages_fts MATCH ?
					 ORDER BY rank
					 LIMIT ?`,
        )
        .all(query, limit ?? 10);

      if (rows.length === 0) {
        return { content: [{ type: "text", text: "No results found." }] };
      }

      const text = rows
        .map((r) => `${formatSessionHeader(r)}\nsnippet: ${r.snippet}`)
        .join("\n\n---\n\n");

      return { content: [{ type: "text", text }] };
    },
  );
}

function registerListSessions(server: McpServer) {
  server.tool(
    "list_sessions",
    "List recent sessions, optionally filtered by project or source.",
    {
      project: z
        .string()
        .optional()
        .describe(
          "Filter by project. Accepts an absolute path (/Users/you/Code/my-app) for exact match, or a name/keyword (e.g. 'quoting-ui', 'tools') for fuzzy substring match against the project slug.",
        ),
      source: z.enum(["claude", "opencode", "pi"]).optional().describe("Filter by AI tool source"),
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .default(20)
        .describe("Max results (default 20)"),
    },
    async ({ project, source, limit }) => {
      const db = getDb(CONFIGURED_DB_PATH);

      // SQLite requires null (not undefined) to bind SQL NULL — disable unicorn/no-null here
      /* eslint-disable unicorn/no-null */
      let projectExact: string | null = null;
      let projectLike: string | null = null;
      if (project) {
        if (path.isAbsolute(project)) {
          projectExact = slugFromPath(project);
        } else {
          projectLike = `%${project.replace(/\s+/g, "-")}%`;
        }
      }
      const sourceParam: string | null = source ?? null;
      /* eslint-enable unicorn/no-null */

      const rows = db
        .query<
          SessionRow,
          [
            string | null,
            string | null,
            string | null,
            string | null,
            string | null,
            string | null,
            number,
          ]
        >(
          `SELECT session_id, source, project, cwd, title, model, created_at, updated_at
					 FROM sessions
					 WHERE (? IS NULL OR project = ?)
					   AND (? IS NULL OR project LIKE ?)
					   AND (? IS NULL OR source = ?)
					 ORDER BY updated_at DESC NULLS LAST, mtime DESC
					 LIMIT ?`,
        )
        .all(
          projectExact,
          projectExact,
          projectLike,
          projectLike,
          sourceParam,
          sourceParam,
          limit ?? 20,
        );

      if (rows.length === 0) {
        return { content: [{ type: "text", text: "No sessions found." }] };
      }

      const text = rows.map(formatSessionHeader).join("\n\n---\n\n");
      return { content: [{ type: "text", text }] };
    },
  );
}

type MessageEntry = { role: string; timestamp: string | null; blocks: BlockRow[] };

function groupBlocksByMessage(blocks: BlockRow[]): {
  messages: Map<string, MessageEntry>;
  order: string[];
} {
  const messages = new Map<string, MessageEntry>();
  const order: string[] = [];

  for (const b of blocks) {
    if (!messages.has(b.msg_id)) {
      messages.set(b.msg_id, { role: b.role, timestamp: b.timestamp, blocks: [] });
      order.push(b.msg_id);
    }
    if (b.block_index !== null) {
      messages.get(b.msg_id)?.blocks.push(b);
    }
  }

  return { messages, order };
}

function renderMessageBlocks(
  msgBlocks: BlockRow[],
  include_tools: boolean,
  include_thinking: boolean,
): string[] {
  const lines: string[] = [];
  for (const b of msgBlocks) {
    if (b.block_type === "text" && b.text) {
      lines.push(b.text);
    } else if (include_thinking && b.block_type === "thinking" && b.text) {
      lines.push(`<thinking>\n${b.text}\n</thinking>`);
    } else if (include_tools && b.block_type === "tool_use") {
      lines.push(`**Tool:** ${b.tool_name}`);
      if (b.tool_input) {
        lines.push(`**Input:** ${b.tool_input}`);
      }
    } else if (include_tools && b.block_type === "tool_result" && b.tool_output) {
      const out = b.tool_output;
      lines.push(`**Result:** ${out.length > 300 ? `${out.slice(0, 300)}...` : out}`);
    }
  }
  return lines;
}

function registerGetSession(server: McpServer) {
  server.tool(
    "get_session",
    "Retrieve the transcript of a session. Defaults to text-only (skips tool calls). Use include_tools=true if you need to see what tools were called. Paginate with limit/offset for long sessions.",
    {
      id: z.string().describe("The session_id value from search or list_sessions results"),
      include_tools: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include tool calls and results (default false — text only)"),
      include_thinking: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include extended thinking blocks (default false)"),
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .default(50)
        .describe("Max number of messages to return (default 50)"),
      offset: z.coerce
        .number()
        .int()
        .min(0)
        .optional()
        .default(0)
        .describe("Message offset for pagination (default 0)"),
    },
    async ({ id: session_id, include_tools, include_thinking, limit, offset }) => {
      const db = getDb(CONFIGURED_DB_PATH);

      const session = db
        .query<SessionRow, [string]>(
          `SELECT session_id, source, project, cwd, title, model, created_at, updated_at
					 FROM sessions WHERE session_id = ?`,
        )
        .get(session_id);

      if (!session) {
        return { content: [{ type: "text", text: `Session ${session_id} not found.` }] };
      }

      const totalMessages = (
        db
          .query<{ n: number }, [string]>(
            `SELECT COUNT(*) as n FROM messages m
						 JOIN sessions s ON m.file_path = s.file_path
						 WHERE s.session_id = ?`,
          )
          .get(session_id) ?? { n: 0 }
      ).n;

      const blocks = db
        .query<BlockRow, [string, number, number]>(
          `SELECT m.id as msg_id, m.role, m.timestamp,
					        cb.block_index, cb.type as block_type, cb.text,
					        cb.tool_name, cb.tool_input, cb.tool_output
					 FROM (
					   SELECT m2.id, m2.role, m2.timestamp, m2.file_path, m2.rowid
					   FROM messages m2
					   JOIN sessions s ON m2.file_path = s.file_path
					   WHERE s.session_id = ?
					   ORDER BY m2.rowid
					   LIMIT ? OFFSET ?
					 ) m
					 LEFT JOIN content_blocks cb
					   ON cb.file_path = m.file_path AND cb.message_id = m.id
					 ORDER BY m.rowid, cb.block_index`,
        )
        .all(session_id, limit ?? 50, offset ?? 0);

      const { messages, order } = groupBlocksByMessage(blocks);
      const pageEnd = (offset ?? 0) + order.length;
      const hasMore = pageEnd < totalMessages;

      const lines: string[] = [
        `# ${session.title ?? session_id}`,
        `Source: ${session.source} | Project: ${session.project}`,
        session.cwd ? `CWD: ${session.cwd}` : "",
        session.created_at ? `Date: ${session.created_at}` : "",
        `Messages: ${(offset ?? 0) + 1}–${pageEnd} of ${totalMessages}${hasMore ? ` (use offset=${pageEnd} for more)` : ""}`,
        "",
      ].filter((l) => l !== "");

      for (const msgId of order) {
        const msg = messages.get(msgId);
        if (!msg) {
          continue;
        }
        lines.push(`## [${msg.role}]${msg.timestamp ? ` (${msg.timestamp})` : ""}`);
        lines.push(...renderMessageBlocks(msg.blocks, include_tools, include_thinking));
        lines.push("");
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );
}

function registerSchema(server: McpServer) {
  server.tool(
    "schema",
    "Return the exact column names for all devlog tables. Call this before writing a query tool call to avoid column name errors.",
    {},
    () => {
      const db = getDb(CONFIGURED_DB_PATH);
      const tables = ["sessions", "messages", "content_blocks", "pr_links", "messages_fts"];
      const lines: string[] = [];
      for (const table of tables) {
        const cols = db
          .query<{ name: string; type: string }, [string]>(
            "SELECT name, type FROM pragma_table_info(?)",
          )
          .all(table);
        lines.push(`${table}: ${cols.map((c) => `${c.name} (${c.type})`).join(", ")}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );
}

function registerQuery(server: McpServer) {
  server.tool(
    "query",
    "Execute a raw SQL SELECT query against the devlog database. The DB is read-only so only SELECT statements work. Tables: sessions, messages, content_blocks, messages_fts.",
    {
      sql: z.string().describe("SQL SELECT query to execute"),
    },
    async ({ sql }) => {
      const db = getDb(CONFIGURED_DB_PATH);
      const rows = db.query(sql).all();
      const text = rows.length === 0 ? "(no rows)" : JSON.stringify(rows, undefined, 2);
      return { content: [{ type: "text", text }] };
    },
  );
}

export function createServer(): McpServer {
  const server = new McpServer(
    { name: "devlog", version: "1.0.0" },
    { instructions: INSTRUCTIONS },
  );

  registerSearch(server);
  registerListSessions(server);
  registerGetSession(server);
  registerSchema(server);
  registerQuery(server);

  return server;
}
