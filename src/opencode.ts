import type { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";

export interface OpencodeMessage {
  id: string;
  sessionID: string;
  role: string;
  time: { created: number; completed?: number };
  parentID?: string;
  modelID?: string;
  providerID?: string;
  agent?: string;
  tokens?: { input: number; output: number };
}

export interface OpencodePart {
  id: string;
  sessionID: string;
  messageID: string;
  type: string;
  text?: string;
  tool?: string;
  callID?: string;
  state?: {
    status: string;
    input: unknown;
    output: unknown;
    title?: string;
  };
}

export interface OpencodeSession {
  id: string;
  projectID: string;
  directory: string;
  title?: string;
  time: { created: number; updated: number };
}

export type MessageWithParts = { message: OpencodeMessage; parts: OpencodePart[] };

function readJsonFilesFromDir<T>(dirPath: string): T[] {
  if (!fs.existsSync(dirPath)) {
    return [];
  }

  const items: T[] = [];
  for (const file of fs.readdirSync(dirPath)) {
    if (!file.endsWith(".json")) {
      continue;
    }
    const filePath = path.join(dirPath, file);
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      items.push(JSON.parse(content) as T);
    } catch (err) {
      console.warn(
        `[devlog] Failed to read ${filePath}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return items;
}

function readMessageParts(messageId: string, partDir: string): OpencodePart[] {
  return readJsonFilesFromDir<OpencodePart>(path.join(partDir, messageId));
}

function getSessionMessages(sessionId: string, messageDir: string): OpencodeMessage[] {
  const messages = readJsonFilesFromDir<OpencodeMessage>(path.join(messageDir, sessionId));
  return messages.sort((a, b) => a.time.created - b.time.created);
}

function buildMessageContent(parts: OpencodePart[]): unknown[] {
  const content: unknown[] = [];

  for (const part of parts) {
    if (part.type === "text" && part.text) {
      content.push({ type: "text", text: part.text });
    } else if (part.type === "tool" && part.tool) {
      content.push({
        type: "tool_use",
        id: part.callID,
        name: part.tool,
        input: part.state?.input ?? {},
      });
      if (part.state?.output !== undefined) {
        const output = part.state.output;
        const outputStr = typeof output === "string" ? output : JSON.stringify(output);
        content.push({
          type: "tool_result",
          tool_use_id: part.callID,
          content: outputStr,
        });
      }
    }
  }

  return content;
}

export function loadMessagesFromFiles(
  sessionId: string,
  messageDir: string,
  partDir: string,
): MessageWithParts[] {
  const messages = getSessionMessages(sessionId, messageDir);
  return messages.map((message) => ({
    message,
    parts: readMessageParts(message.id, partDir),
  }));
}

export function reconstructSessionJsonl(
  sessionId: string,
  session: OpencodeSession,
  messagesWithParts: MessageWithParts[],
): string[] {
  const lines: string[] = [];

  for (const { message: msg, parts } of messagesWithParts) {
    const content = buildMessageContent(parts);

    if (content.length === 0) {
      continue;
    }

    const entry = {
      type: msg.role,
      sessionId: sessionId,
      uuid: msg.id,
      ...(msg.parentID && { parentUuid: msg.parentID }),
      timestamp: new Date(msg.time.created).toISOString(),
      cwd: session.directory,
      message: {
        role: msg.role,
        content: msg.role === "user" ? ((content[0] as { text?: string })?.text ?? "") : content,
        ...(msg.modelID && { model: msg.modelID }),
      },
      ...(msg.providerID && { provider: msg.providerID }),
      ...(msg.agent && { agent: msg.agent }),
      ...(msg.tokens && { tokens: msg.tokens }),
    };

    lines.push(JSON.stringify(entry));
  }

  return lines;
}

export function countUserMessages(messagesWithParts: MessageWithParts[]): number {
  return messagesWithParts.filter((m) => m.message.role === "user").length;
}

// DB column → interface mapping lives entirely here.
// If opencode changes their schema, update this one function.
export function* iterateOpencodeDbSessions(
  db: Database,
  slugFromPath: (p: string) => string,
): Generator<{
  projectSlug: string;
  session: OpencodeSession;
  messagesWithParts: MessageWithParts[];
}> {
  // This query throws if the schema doesn't match — intentionally not caught
  // here so the caller can fall back to flat files.
  const sessions = db
    .query<
      {
        id: string;
        project_id: string;
        directory: string;
        title: string | null;
        time_created: number;
        time_updated: number;
        worktree: string;
      },
      []
    >(
      `SELECT s.id, s.project_id, s.directory, s.title, s.time_created, s.time_updated, p.worktree
			 FROM session s
			 JOIN project p ON s.project_id = p.id`,
    )
    .all();

  const msgStmt = db.query<{ id: string; data: string }, [string]>(
    "SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created ASC",
  );

  const partStmt = db.query<{ id: string; data: string }, [string]>(
    "SELECT id, data FROM part WHERE message_id = ?",
  );

  for (const row of sessions) {
    try {
      const session: OpencodeSession = {
        id: row.id,
        projectID: row.project_id,
        directory: row.directory,
        title: row.title ?? undefined,
        time: { created: row.time_created, updated: row.time_updated },
      };

      const msgRows = msgStmt.all(row.id);
      const messagesWithParts: MessageWithParts[] = [];

      for (const msgRow of msgRows) {
        const d = JSON.parse(msgRow.data) as {
          role: string;
          time?: { created: number; completed?: number };
          parentID?: string;
          modelID?: string;
          providerID?: string;
          agent?: string;
          tokens?: { input: number; output: number };
        };

        const message: OpencodeMessage = {
          id: msgRow.id,
          sessionID: row.id,
          role: d.role,
          time: d.time ?? { created: row.time_created },
          parentID: d.parentID,
          modelID: d.modelID,
          providerID: d.providerID,
          agent: d.agent,
          tokens: d.tokens,
        };

        const partRows = partStmt.all(msgRow.id);
        const parts: OpencodePart[] = partRows.map((pr) => {
          const pd = JSON.parse(pr.data) as {
            type: string;
            text?: string;
            tool?: string;
            callID?: string;
            state?: OpencodePart["state"];
          };
          return {
            id: pr.id,
            sessionID: row.id,
            messageID: msgRow.id,
            type: pd.type,
            text: pd.text,
            tool: pd.tool,
            callID: pd.callID,
            state: pd.state,
          };
        });

        messagesWithParts.push({ message, parts });
      }

      yield {
        projectSlug: slugFromPath(row.worktree),
        session,
        messagesWithParts,
      };
    } catch (err) {
      console.warn(
        `[devlog] Failed to read session ${row.id} from DB:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}
