/**
 * Rehearsal of the LIVE `exit_economics` write path.
 *
 *   npm run rehearse:exit-economics
 *   npm run rehearse:exit-economics -- --keep-db        # keep the scratch DB for inspection
 *
 * WHY. `recordLiveExitEconomics` (every close tx, the landing price, insert-if-absent) has
 * only ever run against synthetic meta in unit tests. The first real close after deploy
 * would otherwise be its first run. This drives the REAL recorder — real Helius
 * `getTransaction`, real Meteora pool read, real insert — against REAL signatures of past
 * live exits, into a SCRATCH database, and asserts what it wrote.
 *
 * Read-only on chain: getTransaction and Meteora's REST API only. It signs nothing, sends
 * nothing, and never opens ./data/flowmetrix.db — the scratch path is asserted to lie inside
 * the OS temp dir BEFORE anything that opens a database is imported.
 *
 * Signatures are read at runtime from `exports/trades.csv`; none are written here.
 *
 * One case is a CONSTRUCT, and says so: no multi-transaction close has happened live yet, so
 * the multi-tx case feeds `closeSignatures` two real transactions of the SAME position (its
 * open tx and its close tx). The fee arithmetic is what is being rehearsed, not the claim that
 * the open tx is part of a close.
 *
 * Exit code 1 if any case FAILs, 2 if the scratch path is refused.
 */
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, isAbsolute } from "node:path";
import Database from "better-sqlite3";

/** True when `path` resolves inside `dir` (never `dir` itself, never via `..`). */
export function isInsideDir(path: string, dir: string): boolean {
  // realpath on what exists, so a symlinked or short-name temp dir compares as itself.
  const real = (p: string) => (existsSync(p) ? realpathSync(p) : resolve(p));
  const full = resolve(path);
  const rel = relative(real(dir), join(real(dirname(full)), basename(full)));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

type Status = "PASS" | "FAIL";
interface CaseResult {
  name: string;
  status: Status;
  detail: string;
}

const LAMPORTS = 1_000_000_000;

/** The pre-WO3 `exit_economics` shape: no close_signatures, no landing-price columns. */
const OLD_EXIT_ECONOMICS_DDL = `CREATE TABLE IF NOT EXISTS exit_economics (
    id                       INTEGER PRIMARY KEY AUTOINCREMENT,
    position_id              TEXT NOT NULL UNIQUE,
    pair_name                TEXT,
    mint                     TEXT,
    bin_step                 INTEGER,
    notional_lamports        INTEGER,
    tvl_usd_at_exit          REAL,
    entry_tvl_usd            REAL,
    pool_price_at_exit       REAL,
    sweep_route              TEXT,
    sweep_slippage_bps_used  INTEGER,
    sweep_in_amount          TEXT,
    sweep_out_lamports       INTEGER,
    expected_out_lamports    INTEGER,
    exit_fee_lamports        INTEGER,
    exit_cost_bps            REAL,
    sweep_concession_bps     REAL,
    source                   TEXT NOT NULL,
    measured_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    notes                    TEXT
  )`;

async function closeHttpPool(): Promise<void> {
  const dispatcher = (globalThis as Record<symbol, unknown>)[Symbol.for("undici.globalDispatcher.1")] as
    | { close?: () => Promise<void> }
    | undefined;
  try {
    await dispatcher?.close?.();
  } catch {
    /* not a rehearsal result */
  }
}

async function main(): Promise<void> {
  const keepDb = process.argv.includes("--keep-db");
  const override = process.argv.find((a) => a.startsWith("--scratch-db="))?.slice("--scratch-db=".length);

  const tempDir = override ? null : mkdtempSync(join(tmpdir(), "flowmetrix-exit-rehearsal-"));
  const dbPath = override ? resolve(override) : join(tempDir!, "rehearsal.db");

  /* The guard comes FIRST: nothing that can open a database has been imported yet. */
  if (!isInsideDir(dbPath, tmpdir())) {
    console.error(`[rehearsal] REFUSED: scratch DB ${dbPath} is not inside the OS temp dir ${tmpdir()}`);
    process.exitCode = 2;
    return;
  }
  process.env.DATABASE_PATH = dbPath;

  const results: CaseResult[] = [];
  const check = (name: string, ok: boolean, detail: string) => {
    results.push({ name, status: ok ? "PASS" : "FAIL", detail });
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
  };

  /* ---- 0. migration from the old table shape, before initDatabase ---- */
  {
    const raw = new Database(dbPath);
    raw.exec(OLD_EXIT_ECONOMICS_DDL);
    raw
      .prepare(
        `INSERT INTO exit_economics (position_id, pair_name, exit_fee_lamports, sweep_concession_bps, source, notes)
         VALUES ('old-row', 'OLD-SOL', 12345, 99.5, 'backfill', 'pre-migration row')`,
      )
      .run();
    raw.close();
  }

  /* Dynamic, and only now: env.ts parses DATABASE_PATH on load and db.ts opens it on import. */
  const { env } = await import("../src/config/env.js");
  const resolvedDb = resolve(process.cwd(), env.DATABASE_PATH);
  if (!isInsideDir(resolvedDb, tmpdir())) {
    console.error(`[rehearsal] REFUSED: env resolved DATABASE_PATH to ${resolvedDb}, outside the temp dir`);
    process.exitCode = 2;
    return;
  }
  const { db, initDatabase, closeDatabase } = await import("../src/database/db.js");
  const { insertExitEconomicsIfAbsent } = await import("../src/database/repositories.js");
  const econ = await import("../src/services/exitEconomics.js");
  const { getTransactionMeta } = await import("../src/services/solana.js");
  const { fetchPoolByAddress } = await import("../src/services/meteora.js");
  const { parseCsv } = await import("../src/services/exitEconomicsBackfill.js");

  try {
    console.log(`[rehearsal] scratch DB: ${resolvedDb}`);
    initDatabase();

    console.log("\n0. migration");
    const cols = new Set((db.prepare(`PRAGMA table_info(exit_economics)`).all() as Array<{ name: string }>).map((c) => c.name));
    const added = ["close_signatures", "pool_price_after_sweep", "sweep_concession_after_sweep_bps", "exit_cost_after_sweep_bps"];
    const missing = added.filter((c) => !cols.has(c));
    const old = db.prepare(`SELECT * FROM exit_economics WHERE position_id = 'old-row'`).get() as Record<string, unknown> | undefined;
    check(
      "0 migration: new columns on an existing table, old row intact",
      missing.length === 0 &&
        old?.exit_fee_lamports === 12345 &&
        old?.sweep_concession_bps === 99.5 &&
        old?.close_signatures === null &&
        old?.pool_price_after_sweep === null,
      missing.length ? `missing ${missing.join(", ")}` : `4 columns added; old row fee ${String(old?.exit_fee_lamports)}, new columns NULL`,
    );

    /* ---- the real exits ---- */
    const live = parseCsv(readFileSync("exports/trades.csv", "utf8")).filter(
      (r) => r.execution_mode === "LIVE" && (r.status ?? "").startsWith("CLOSED") && r.close_signature,
    );
    const nz = (v: string | undefined) => (v ? v : null);
    const swept = live.filter((r) => r.residual_sweep === "swept" && r.sweep_signature && r.ata_close_signature && r.open_signature);
    const notSwept = live.find((r) => r.residual_sweep !== "swept");
    if (swept.length < 3 || !notSwept) {
      check("inputs", false, `need >=3 swept live exits and 1 unswept in exports/trades.csv (have ${swept.length} / ${notSwept ? 1 : 0})`);
      return;
    }
    console.log(`\n[rehearsal] ${live.length} closed LIVE exits in exports/trades.csv; using ids ${swept.slice(0, 3).map((r) => r.id).join(", ")} and ${notSwept.id}`);

    const mintCache = new Map<string, string | null>();
    const mintOf = async (pool: string): Promise<string | null> => {
      if (!mintCache.has(pool)) {
        const p = await fetchPoolByAddress(pool, { quiet: true });
        const wsol = "So11111111111111111111111111111111111111112";
        mintCache.set(pool, p ? (p.baseMint === wsol ? p.quoteMint : p.baseMint) : null);
      }
      return mintCache.get(pool) ?? null;
    };
    const feeOf = async (sig: string): Promise<number | null> => (await getTransactionMeta(sig))?.fee ?? null;
    const inputFor = async (r: Record<string, string>, positionId: string) => ({
      poolAddress: r.pool_address!,
      positionId,
      pairName: r.pair_name!,
      mint: await mintOf(r.pool_address!),
      notionalLamports: Number(r.virtual_sol_amount) > 0 ? Math.round(Number(r.virtual_sol_amount) * LAMPORTS) : null,
      entryTvlUsd: r.entry_tvl ? Number(r.entry_tvl) : null,
      poolPriceAtExit: Number(r.exit_price) > 0 ? Number(r.exit_price) : null,
      residualSweep: nz(r.residual_sweep),
      sweepRoute: r.residual_sweep === "swept" ? ("jupiter" as const) : null,
      sweepSlippageBpsUsed: null,
      closeSignature: nz(r.close_signature),
      closeSignatures: [r.close_signature!],
      sweepSignature: nz(r.sweep_signature),
      ataCloseSignature: nz(r.ata_close_signature),
    });
    const rowOf = (positionId: string) =>
      db.prepare(`SELECT * FROM exit_economics WHERE position_id = ?`).get(positionId) as Record<string, unknown> | undefined;
    const deps = econ.defaultLiveExitRecordDeps();

    /* ---- a. single close tx ---- */
    console.log("\na. single close tx (the shape every live close so far has had)");
    {
      const r = swept[0]!;
      const id = `rehearsal-a-${r.id}`;
      const ret = await econ.recordLiveExitEconomics(await inputFor(r, id), deps);
      const fees = await Promise.all([r.close_signature!, r.sweep_signature!, r.ata_close_signature!].map(feeOf));
      const expected = fees.every((f) => f !== null) ? fees.reduce((s, f) => s! + f!, 0) : null;
      const row = rowOf(id);
      check(
        `a fee = close + sweep + ata_close (${r.pair_name} #${r.id})`,
        row !== undefined && expected !== null && row.exit_fee_lamports === expected,
        `row ${String(row?.exit_fee_lamports)} vs independent sum ${expected} (${fees.join(" + ")})`,
      );
      check(
        "a close_signatures JSON = [close]",
        row?.close_signatures === JSON.stringify([r.close_signature]),
        `stored ${String(row?.close_signatures).slice(0, 24)}…, ${ret ? "recorder returned the row" : "recorder returned null"}`,
      );
      check(
        "a landing price read and concessions derived",
        typeof row?.pool_price_after_sweep === "number" &&
          (row.pool_price_after_sweep as number) > 0 &&
          typeof row?.sweep_concession_bps === "number" &&
          typeof row?.sweep_concession_after_sweep_bps === "number",
        `pool_price_after_sweep ${String(row?.pool_price_after_sweep)} (TODAY's price in a rehearsal, not the landing), ` +
          `concession @decision ${Number(row?.sweep_concession_bps).toFixed(1)} bps / @read ${Number(row?.sweep_concession_after_sweep_bps).toFixed(1)} bps`,
      );
    }

    /* ---- b. multi-tx close (CONSTRUCT) ---- */
    console.log("\nb. multi-tx close — REHEARSAL CONSTRUCT: [open tx, close tx] of the same position");
    {
      const r = swept[1]!;
      const id = `rehearsal-b-${r.id}`;
      const input = await inputFor(r, id);
      // The final signature is passed BOTH inside the list and as closeSignature, as settleLiveCloses does.
      input.closeSignatures = [r.open_signature!, r.close_signature!];
      await econ.recordLiveExitEconomics(input, deps);
      const fees = await Promise.all([r.open_signature!, r.close_signature!, r.sweep_signature!, r.ata_close_signature!].map(feeOf));
      const expected = fees.every((f) => f !== null) ? fees.reduce((s, f) => s! + f!, 0) : null;
      const row = rowOf(id);
      check(
        `b fee = every distinct close tx + sweep + ata_close (${r.pair_name} #${r.id})`,
        row !== undefined && expected !== null && row.exit_fee_lamports === expected,
        `row ${String(row?.exit_fee_lamports)} vs ${expected} (${fees.join(" + ")})`,
      );
      const stored = JSON.parse(String(row?.close_signatures ?? "null")) as string[] | null;
      check(
        "b final signature counted once",
        Array.isArray(stored) && stored.length === 2 && new Set(stored).size === 2 && stored[1] === r.close_signature,
        `close_signatures has ${stored?.length ?? "null"} entries, last = final close`,
      );
    }

    /* ---- c. unmeasured is null, never 0 ---- */
    console.log("\nc. unmeasured -> NULL (asserted with SQL IS NULL)");
    const isNull = (id: string, column: string) =>
      (db.prepare(`SELECT COUNT(*) AS n FROM exit_economics WHERE position_id = ? AND ${column} IS NULL`).get(id) as { n: number }).n === 1;
    {
      const r = swept[2]!;
      const id = `rehearsal-c1-${r.id}`;
      const input = await inputFor(r, id);
      input.closeSignatures = ["NotARealSignature1111", r.close_signature!];
      await econ.recordLiveExitEconomics(input, deps);
      const row = rowOf(id);
      check(
        "c1 an unreadable close signature makes the fee NULL, with a note",
        row !== undefined && isNull(id, "exit_fee_lamports") && /unreadable/.test(String(row.notes)),
        `exit_fee_lamports IS NULL: ${isNull(id, "exit_fee_lamports")}; note: ${String(row?.notes).match(/tx meta [^|]*unreadable[^|]*/)?.[0]?.slice(0, 90) ?? "none"}`,
      );
    }
    {
      const r = swept[2]!;
      const id = `rehearsal-c2-${r.id}`;
      await econ.recordLiveExitEconomics(await inputFor(r, id), {
        ...deps,
        readPool: async () => {
          throw new Error("rehearsal: injected pool read failure");
        },
      });
      const row = rowOf(id);
      const nulls = ["pool_price_after_sweep", "sweep_concession_after_sweep_bps", "exit_cost_after_sweep_bps", "bin_step", "tvl_usd_at_exit"];
      const bad = nulls.filter((c) => !isNull(id, c));
      check(
        "c2 a failed pool read leaves the landing price and its concessions NULL (not 0), with a note",
        row !== undefined && bad.length === 0 && /pool unreadable after sweep/.test(String(row.notes)) && typeof row.sweep_concession_bps === "number",
        bad.length ? `not NULL: ${bad.join(", ")}` : `5 columns NULL; decision-price concession still ${Number(row?.sweep_concession_bps).toFixed(1)} bps`,
      );
    }
    {
      const r = notSwept;
      const id = `rehearsal-c3-${r.id}`;
      await econ.recordLiveExitEconomics(await inputFor(r, id), deps);
      const row = rowOf(id);
      const nulls = ["sweep_out_lamports", "expected_out_lamports", "sweep_concession_bps", "exit_cost_bps", "sweep_concession_after_sweep_bps", "exit_cost_after_sweep_bps"];
      const bad = nulls.filter((c) => !isNull(id, c));
      check(
        `c3 residual_sweep=${r.residual_sweep} leaves every sweep figure NULL (${r.pair_name} #${r.id})`,
        row !== undefined && bad.length === 0 && /sweep leg unmeasured/.test(String(row.notes)),
        bad.length ? `not NULL: ${bad.join(", ")}` : `6 columns NULL; fee ${String(row?.exit_fee_lamports)} (close tx only)`,
      );
    }

    /* ---- d. insert-if-absent ---- */
    console.log("\nd. insert-if-absent");
    {
      const r = swept[0]!;
      const id = `rehearsal-a-${r.id}`;
      const before = rowOf(id);
      const input = await inputFor(r, id);
      input.notionalLamports = 1; // a different value: must NOT overwrite
      await econ.recordLiveExitEconomics(input, deps);
      const count = (db.prepare(`SELECT COUNT(*) AS n FROM exit_economics WHERE position_id = ?`).get(id) as { n: number }).n;
      const after = rowOf(id);
      check(
        "d a second write for the same position_id keeps ONE row and the first write",
        count === 1 && after?.notional_lamports === before?.notional_lamports && after?.id === before?.id,
        `rows ${count}; notional ${String(after?.notional_lamports)} (second write asked for 1)`,
      );
    }

    /* ---- e. never throws ---- */
    console.log("\ne. the recorder never throws");
    {
      const r = swept[0]!;
      let threw = false;
      let ret: unknown = "unset";
      try {
        ret = await econ.recordLiveExitEconomics(await inputFor(r, `rehearsal-e-${r.id}`), {
          ...deps,
          insert: () => {
            throw new Error("rehearsal: injected insert failure");
          },
        });
      } catch {
        threw = true;
      }
      check("e an insert that throws returns null, no exception", !threw && ret === null, `threw ${threw}; returned ${String(ret)}`);
    }

    void insertExitEconomicsIfAbsent; // the real insert is the one the default deps carry
  } finally {
    const failed = results.filter((c) => c.status === "FAIL");
    console.log("\n=== SUMMARY ===");
    for (const c of results) console.log(`${c.status}  ${c.name}`);
    console.log(`\n${results.length} checks · ${results.length - failed.length} PASS · ${failed.length} FAIL`);
    if (failed.length > 0 || results.length === 0) process.exitCode = 1;

    await closeHttpPool();
    closeDatabase();
    if (tempDir && !keepDb) rmSync(tempDir, { recursive: true, force: true });
    else if (keepDb) console.log(`scratch DB kept at ${dbPath}`);
  }
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
if (invoked.endsWith("rehearseExitEconomics.ts")) {
  main().catch((err) => {
    console.error("[rehearsal] failed:", err);
    process.exitCode = 1;
  });
}
