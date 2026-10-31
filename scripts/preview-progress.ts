// Display-only preview of the real archive/index terminal renderers.
// Run: bun scripts/preview-progress.ts [archive|index|both] [session-count]
// No transcripts, archives, or databases are read or written.
import {
  printArchiveHeader,
  printArchiveSummary,
  printIndexSummary,
  ProgressReporter,
  type SourceSummary,
} from "../src/progress.ts";

if (!process.stdout.isTTY) {
  console.error("Run this in an interactive terminal to see the progress display.");
  process.exit(1);
}

const mode = process.argv[2] ?? "both";
const count =
  process.argv.length < 4 ? 12_000 + Math.floor(Math.random() * 3_000) : Number(process.argv[3]);
if (!["archive", "index", "both"].includes(mode) || !Number.isSafeInteger(count) || count < 1) {
  console.error(
    "Usage: bun scripts/preview-progress.ts [archive|index|both] [positive session-count]",
  );
  process.exit(1);
}

const options = { verbose: false, debug: false };
const destination = "/tmp/fart-transcripts";

async function simulate(label: string, total: number) {
  const progress = new ProgressReporter(options);
  progress.start(label, total);
  let processed = 0;
  let changed = 0;
  let messages = 0;
  const step = Math.max(1, Math.ceil(total / 40));

  while (processed < total) {
    const next = Math.min(total, processed + step);
    const batch = next - processed;
    const newlyChanged = Math.floor(batch * Math.random() * 0.2);
    changed += newlyChanged;
    messages += newlyChanged * (2 + Math.floor(Math.random() * 20));
    processed = next;
    progress.tick({ processed, archived: changed, skipped: processed - changed });
    await Bun.sleep(60);
  }

  progress.end();
  return { changed, skipped: total - changed, messages };
}

if (mode === "archive" || mode === "both") {
  const startedAt = Date.now();
  printArchiveHeader(destination, options);
  const sources = [
    { label: "Claude", total: 2 + Math.floor(Math.random() * 8) },
    { label: "opencode", total: 120 + Math.floor(Math.random() * 500) },
    { label: "pi", total: count },
  ];
  const summaries: SourceSummary[] = [];

  for (const { label, total } of sources) {
    const { changed, skipped } = await simulate(label, total);
    summaries.push({
      label,
      archived: changed,
      skipped,
      activity: 0,
      activityLabel: "",
      warnings: 0,
    });
  }

  printArchiveSummary(summaries, destination, Date.now() - startedAt);
}

if (mode === "index" || mode === "both") {
  if (mode === "both") {
    console.log("");
  }
  const startedAt = Date.now();
  const { changed, skipped, messages } = await simulate("index", count);
  printIndexSummary(
    { sessionsIndexed: changed, sessionsSkipped: skipped, messagesIndexed: messages, errors: 0 },
    `${destination}/index.db`,
    Date.now() - startedAt,
  );
}
