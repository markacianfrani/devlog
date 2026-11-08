import { describe, expect, test } from "bun:test";

import { piParentArchiveName, resolvePiRelationship } from "../parsers/pi-relationships.ts";
import { createSessionMeta } from "../parsers/types.ts";

const PARENT = "11111111-2222-4333-8444-555555555555";
const OTHER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const ARCHIVED = `/archive/2026-01-01T00-00-00-000Z_${PARENT}__worker__run-0.jsonl`;

describe("Pi relationship evidence boundary", () => {
  test("does not retain a relationship kind without a parent reference", () => {
    expect(
      createSessionMeta({ id: "child", source: "pi", project: "project", relationKind: "fork" }),
    ).toEqual({ id: "child", source: "pi", project: "project" });
  });

  test("Pi's parentSession records parentage but does not identify an extension or prove a fork", () => {
    expect(
      resolvePiRelationship(`/sessions/parent_${PARENT}.jsonl`, "/archive/child.jsonl"),
    ).toEqual({
      parentSessionId: `/sessions/parent_${PARENT}.jsonl`,
    });
  });

  test("pi-subagents' archived child path establishes a subagent, with or without a header", () => {
    expect(resolvePiRelationship(undefined, ARCHIVED)).toEqual({
      parentSessionId: PARENT,
      relationKind: "subagent",
    });
    expect(resolvePiRelationship(`/sessions/parent_${PARENT}.jsonl`, ARCHIVED)).toEqual({
      parentSessionId: `/sessions/parent_${PARENT}.jsonl`,
      relationKind: "subagent",
    });
    expect(resolvePiRelationship(`/sessions/other_${OTHER}.jsonl`, ARCHIVED)).toEqual({
      parentSessionId: `/sessions/other_${OTHER}.jsonl`,
    });
  });

  test("a source parent path or pi-subagents child archive names the parent file", () => {
    const group = `2026-01-01T00-00-00-000Z_${PARENT}.jsonl`;
    expect(piParentArchiveName(ARCHIVED, `/sessions/${group}`)).toBe(group);
    expect(piParentArchiveName(ARCHIVED, PARENT)).toBe(group);
    expect(piParentArchiveName("/archive/unrelated.jsonl", PARENT)).toBeUndefined();
    expect(piParentArchiveName(ARCHIVED, `/sessions/parent_${PARENT}.jsonl`)).toBeNull();
    expect(piParentArchiveName(ARCHIVED, `/sessions/other_${OTHER}.jsonl`)).toBeNull();
  });
});
