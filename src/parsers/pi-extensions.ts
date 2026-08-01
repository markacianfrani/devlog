import { isObjectRecord } from "./shared.ts";

/**
 * pi emits a generic `custom` record envelope; pi itself and third-party
 * extensions stamp their own `customType` and a structured `data` payload.
 * Those payloads are owned by their extensions and change independently of
 * devlog, so we do NOT hand-fit renderers to their internal field names — that
 * overfits and breaks silently when the schema changes (it did once for
 * pi-goal, whose renderer read fields that never existed on real records).
 *
 * The parser surfaces every custom record via a generic fallback (the payload
 * serialized verbatim). The renderers here are optional best-effort
 * enhancements for extensions where structured extraction adds real search
 * value; if a renderer is missing or returns nothing, the fallback still
 * captures the record. Add a renderer only when its schema is verified against
 * real sessions and the nicer output is worth maintaining.
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

const PI_EXTENSIONS = new Map<string, PiExtensionRenderer>([
  ["web-search-results", renderWebSearchResults],
]);

export function getPiExtensionRenderer(customType: string): PiExtensionRenderer | undefined {
  return PI_EXTENSIONS.get(customType);
}
