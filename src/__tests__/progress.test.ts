import { expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";

import { formatProgressRow } from "../progress.ts";

const plain = (row: string) => stripVTControlCharacters(row);

test("short and long completed rows use the same columns", () => {
  const rows = [
    { label: "Claude", processed: 9, total: 9, archived: 0 },
    { label: "opencode", processed: 453, total: 453, archived: 33 },
    { label: "pi", processed: 15000, total: 15000, archived: 1364 },
  ].map((state) => plain(formatProgressRow(state, true, 80)));

  expect(new Set(rows.map((row) => row.indexOf("sessions"))).size).toBe(1);
  expect(new Set(rows.map((row) => row.indexOf("copied"))).size).toBe(1);
  expect(rows[0]).toContain("9 sessions");
  expect(rows[2]).toContain("15000 sessions");
  for (const row of rows) {
    expect(row).not.toContain("unchanged");
    expect(row).not.toContain("checked");
    expect(row).not.toContain("/");
  }
});

test("live progress animates without moving the result column", () => {
  const state = { label: "pi", processed: 12, total: 15000, archived: 1 };
  const live = plain(formatProgressRow(state, false, 80, 0));
  const nextFrame = plain(formatProgressRow(state, false, 80, 1));
  const done = plain(formatProgressRow(state, true, 80));

  expect(live).toStartWith("◐");
  expect(nextFrame).toStartWith("◓");
  expect(done).toStartWith("✓");
  expect(live).toContain("12/15000 sessions");
  expect(done).toContain("12 sessions");
  expect(live.indexOf("copied")).toBe(done.indexOf("copied"));
});

test("index progress says indexed rather than copied", () => {
  const row = plain(
    formatProgressRow({ label: "index", processed: 2, total: 2, archived: 1 }, true),
  );
  expect(row).toContain("1 indexed");
  expect(row).not.toContain("copied");
});

test("narrow terminals use a compact row", () => {
  const state = { label: "pi", processed: 15000, total: 15000, archived: 1364 };
  expect(plain(formatProgressRow(state, true, 40))).toBe("✓ ◌ pi  15000 sessions  1364 copied");
});
