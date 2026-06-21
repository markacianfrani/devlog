import { isObjectRecord } from "./shared.ts";

/**
 * pi emits a generic `custom` record envelope; third-party extensions stamp
 * their own `customType` and a structured `data` payload. Each renderer here
 * turns one extension's payload into a `<pi:...>` block. Returning `undefined`
 * means "nothing worth surfacing" (e.g. an empty goal) — the core parser skips
 * it without a warning. To support a new extension, add one entry to
 * `PI_EXTENSIONS`; the parser never changes.
 */

export interface PiExtensionRender {
  tagName: string;
  body: string;
  attributes?: Record<string, string | undefined>;
}

type PiExtensionRenderer = (data: unknown) => PiExtensionRender | undefined;

const SNIPPET_LIMIT = 300;

function truncate(text: string): string {
  return text.length <= SNIPPET_LIMIT ? text : `${text.slice(0, SNIPPET_LIMIT).trimEnd()}…`;
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

/**
 * pi-web-access: the same envelope carries two shapes. A `fetch` lists pages it
 * pulled (`urls`); a `search` lists queries it ran with synthesized answers
 * (`queries`). We dispatch on whichever array is present.
 */
function renderWebSearchResults(data: unknown): PiExtensionRender | undefined {
  if (!isObjectRecord(data)) {
    return undefined;
  }

  let body = "";
  if (Array.isArray(data["urls"])) {
    body = renderFetchedPages(data["urls"]);
  } else if (Array.isArray(data["queries"])) {
    body = renderSearchQueries(data["queries"]);
  }

  return body.length > 0 ? { tagName: "web-search-results", body } : undefined;
}

/** Fetched pages: title + url + a snippet of content, or the error if the fetch failed. */
function renderFetchedPages(urls: unknown[]): string {
  return urls
    .filter(isObjectRecord)
    .map((entry) => {
      const lines = [stringField(entry, "title"), stringField(entry, "url")].filter(
        (line) => line.length > 0,
      );
      const error = stringField(entry, "error");
      const content = stringField(entry, "content");
      // A failed fetch surfaces its error instead of going silently empty.
      if (error) {
        lines.push(`error: ${error}`);
      } else if (content) {
        lines.push(truncate(content));
      }
      return lines.join("\n");
    })
    .filter((block) => block.length > 0)
    .join("\n\n");
}

/** Search queries: the query, a snippet of the synthesized answer, and the source links. */
function renderSearchQueries(queries: unknown[]): string {
  return queries
    .filter(isObjectRecord)
    .map((query) => {
      const sections = [stringField(query, "query")].filter((line) => line.length > 0);
      const error = stringField(query, "error");
      const answer = stringField(query, "answer");
      if (error) {
        sections.push(`error: ${error}`);
      } else if (answer) {
        sections.push(truncate(answer));
      }

      const results = Array.isArray(query["results"]) ? query["results"] : [];
      const sources = results
        .filter(isObjectRecord)
        .map((result) => {
          const title = stringField(result, "title");
          const url = stringField(result, "url");
          if (!url) {
            return "";
          }
          return title ? `- ${title} — ${url}` : `- ${url}`;
        })
        .filter((line) => line.length > 0);
      if (sources.length > 0) {
        sections.push(["sources:", ...sources].join("\n"));
      }

      return sections.join("\n\n");
    })
    .filter((block) => block.length > 0)
    .join("\n\n");
}

/** pi-goal: the agent's current goal and how far it's gotten. Null goal => nothing to show. */
function renderGoalState(data: unknown): PiExtensionRender | undefined {
  if (!isObjectRecord(data) || !isObjectRecord(data["goal"])) {
    return undefined;
  }

  const goal = data["goal"];
  const text = stringField(goal, "text");
  if (!text) {
    return undefined;
  }

  const status = stringField(goal, "status") || "unknown";
  const metrics = (["iteration", "tokensUsed", "timeUsedSeconds"] as const)
    .filter((key) => typeof goal[key] === "number")
    .map((key) => `${key} ${goal[key] as number}`);

  const body = [text, `status: ${status}`, metrics.join(" · ")]
    .filter((line) => line.length > 0)
    .join("\n");

  return { tagName: "goal-state", body };
}

const PI_EXTENSIONS = new Map<string, PiExtensionRenderer>([
  ["web-search-results", renderWebSearchResults],
  ["goal-state", renderGoalState],
]);

export function getPiExtensionRenderer(customType: string): PiExtensionRenderer | undefined {
  return PI_EXTENSIONS.get(customType);
}
