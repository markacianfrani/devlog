import { expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";

import { formatProgressRow } from "../progress.ts";

const plain = (row: string) => stripVTControlCharacters(row);

test("completed source rows align progress and result columns", () => {
  const claude = plain(
    formatProgressRow({ label: "Claude", processed: 2, total: 2, archived: 0, skipped: 2 }, true),
  );
  const pi = plain(
    formatProgressRow({ label: "pi", processed: 225, total: 225, archived: 1, skipped: 224 }, true),
  );

  expect(claude).toContain("✓ ✦ Claude");
  expect(pi).toContain("✓ ◌ pi");
  expect(claude).not.toContain("→");
  expect(claude.indexOf("2/2") + "2/2".length).toBe(pi.indexOf("225/225") + "225/225".length);
  expect(claude.indexOf("checked")).toBe(pi.indexOf("checked"));
  expect(claude.indexOf("copied")).toBe(pi.indexOf("copied"));
  expect(claude.indexOf("unchanged")).toBe(pi.indexOf("unchanged"));
  expect(claude).not.toContain("█");
});

test("live progress uses the same columns as the completed row", () => {
  const state = { label: "pi", processed: 12, total: 225, archived: 1, skipped: 11 };
  const live = plain(formatProgressRow(state, false, 80, 0));
  const nextFrame = plain(formatProgressRow(state, false, 80, 1));
  const done = plain(formatProgressRow(state, true));

  expect(live).toStartWith("◐");
  expect(nextFrame).toStartWith("◓");
  expect(done).toStartWith("✓");
  expect(live.indexOf("12/225")).toBe(done.indexOf("12/225"));
  expect(live.indexOf("copied")).toBe(done.indexOf("copied"));
});

test("index progress says indexed rather than copied", () => {
  const row = plain(
    formatProgressRow({ label: "index", processed: 2, total: 2, archived: 1, skipped: 1 }, true),
  );
  expect(row).toContain("1 indexed");
  expect(row).not.toContain("copied");
});

test("narrow terminals and large counts use a compact row", () => {
  const state = { label: "pi", processed: 225, total: 225, archived: 1, skipped: 224 };
  expect(plain(formatProgressRow(state, true, 40))).toBe("✓ ◌ pi  225/225  1 copied  224 same");
  expect(
    plain(
      formatProgressRow(
        { label: "pi", processed: 100000, total: 100000, archived: 1, skipped: 99999 },
        true,
      ),
    ),
  ).toContain("100000/100000  1 copied  99999 same");
});
