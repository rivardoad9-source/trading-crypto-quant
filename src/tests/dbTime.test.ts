/**
 * One reader for a stored timestamp.
 *
 * `parseStamp` (liveReport) and `ms` (reconciliation) used to be their own implementations
 * testing only `includes("T")`, so `2026-09-16 10:00:00Z` and `2026-09-16 10:00:00+07:00`
 * returned null there while `parseDbTimestamp` read them. Nothing writes that form today —
 * 756 stored values were scanned on the live database on 16 Sep 2026 and none was in it —
 * so the drift was latent. It mattered because of WHERE the copies lived: in
 * `reconciliation.ts` a null is the difference between a row being compared against the
 * chain and being excluded from both totals as unmeasured.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseDbTimestamp, parseDbTimestampMs } from "../services/dbTime.js";
import { parseDbTimestamp as fromMeteora } from "../services/meteora.js";
import { parseStamp } from "../services/liveReport.js";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Every shape the database or a test/seed can hold, plus the two that used to diverge. */
const VALUES: Array<string | null | undefined> = [
  "2026-09-16 10:00:00", // SQLite CURRENT_TIMESTAMP — what the engine actually writes
  "2026-09-16T10:00:00Z", // ISO, what tests and seeds write
  "2026-09-16T10:00:00.123Z",
  "2026-09-16 10:00:00Z", // <- zone marker, space separator: the drift
  "2026-09-16 10:00:00+07:00", // <- same
  "2026-09-16T10:00:00+07:00",
  "  2026-09-16 10:00:00  ",
  "not a date",
  "",
  null,
  undefined,
];

describe("the stored-timestamp rule has ONE implementation", () => {
  it("meteora re-exports it rather than defining a second one", () => {
    const source = readFileSync(join(srcDir, "services", "meteora.ts"), "utf8");
    assert.ok(
      !/export function parseDbTimestamp/.test(source),
      "meteora.ts defines parseDbTimestamp again instead of re-exporting dbTime's",
    );
    assert.equal(fromMeteora, parseDbTimestamp, "the re-export is not the same function");
  });

  it("liveReport's parseStamp agrees with the canonical reader on every shape", () => {
    for (const value of VALUES) {
      assert.equal(parseStamp(value), parseDbTimestampMs(value), `disagreed on ${JSON.stringify(value)}`);
    }
  });

  it("reconciliation delegates instead of reimplementing", () => {
    /*
     * `ms` is module-private, so this is a source-level check: what must not come back is
     * a second `Date.parse(... includes("T") ...)`, which is the exact narrower form.
     */
    const source = readFileSync(join(srcDir, "services", "reconciliation.ts"), "utf8");
    assert.ok(source.includes("parseDbTimestampMs"), "reconciliation no longer delegates");
    assert.ok(
      !/Date\.parse\([^)]*includes\("T"\)/.test(source),
      "reconciliation has grown its own narrower timestamp parser again",
    );
  });

  it("reads the two forms the copies used to drop", () => {
    const expected = Date.parse("2026-09-16T10:00:00Z");
    assert.equal(parseDbTimestampMs("2026-09-16 10:00:00Z"), expected);
    assert.equal(parseStamp("2026-09-16 10:00:00Z"), expected);
    assert.equal(parseDbTimestampMs("2026-09-16 10:00:00+07:00"), Date.parse("2026-09-16T10:00:00+07:00"));
  });

  it("null still means UNMEASURED, and a space-separated UTC stamp is still read as UTC", () => {
    assert.equal(parseDbTimestampMs(null), null);
    assert.equal(parseDbTimestampMs("not a date"), null);
    // The original bug this rule exists for: local-time reading would shift this by the box's offset.
    assert.equal(parseDbTimestampMs("2026-09-16 10:00:00"), Date.parse("2026-09-16T10:00:00Z"));
  });

  it("dbTime imports nothing, so liveReport keeps its read-only isolation", () => {
    /*
     * `liveReport.ts` deliberately never imports `database/db.ts` (writable handle,
     * migrates at import) and must not reach `config/env.ts` either, which parses `.env`
     * at import and can exit the process. That is why the canonical reader is its own
     * module rather than something liveReport pulls out of `meteora.ts`.
     */
    const source = readFileSync(join(srcDir, "services", "dbTime.ts"), "utf8");
    assert.ok(!/^import /m.test(source), "dbTime.ts has grown an import");
    const report = readFileSync(join(srcDir, "services", "liveReport.ts"), "utf8");
    for (const mod of ["../config/env.js", "./meteora.js", "../database/db.js"]) {
      assert.ok(!report.includes(`from "${mod}"`), `liveReport.ts now imports ${mod}`);
    }
  });
});
