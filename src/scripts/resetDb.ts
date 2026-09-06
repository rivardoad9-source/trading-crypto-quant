/**
 * Clean slate: empties every history table so the dashboard records only new activity.
 *
 * This is IRREVERSIBLE for the live file, so it takes a timestamped copy first. The
 * backup is the whole reason this script can be run without a confirmation prompt: a
 * mistaken `npm run db:reset` costs a file copy, not the history. Backups land in
 * `data/backups/` and are never pruned automatically — deleting someone's only copy of
 * deleted data would defeat the point.
 *
 *   npm run db:reset              # back up, then clear
 *   npm run db:reset -- --no-backup
 *
 * What it does NOT touch: `exports/` (the 27-trade dry-run archive and its CSVs) and
 * `reports/`. Those are the evidence behind several documented findings — the churn
 * analysis, the stop-loss overshoot measurements — and they are files, not rows. If you
 * want the numbers this database is about to forget, they are already there.
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { env } from "../config/env.js";
import { closeDatabase, db, initDatabase } from "../database/db.js";

/** Every table whose rows are history rather than structure. */
const HISTORY_TABLES = [
  "simulated_positions",
  "daily_pnl_snapshots",
  "daily_research_logs",
  // Diagnostics, but still history: a funnel row describes a scan of a market that no
  // longer exists. Leaving it behind a reset would mean "0 trades" alongside hundreds
  // of cycles from the run that produced them.
  "scan_funnel_cycles",
] as const;

function countRows(table: string): number {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get() as { c: number };
    return row.c;
  } catch {
    return 0;
  }
}

function backupDatabase(dbPath: string): string | null {
  if (!existsSync(dbPath)) return null;

  const dir = join(dirname(dbPath), "backups");
  mkdirSync(dir, { recursive: true });

  // Colons are illegal in Windows filenames, so the timestamp is dash-separated.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = join(dir, `flowmetrix-${stamp}.db`);

  /*
   * A plain file copy is only safe because initDatabase() has not run yet: nothing in
   * this process holds the database open, so there is no half-written page and no WAL
   * content that the copy would miss. Move this call below initDatabase() and the
   * backup silently becomes a copy of a checkpointed-but-not-current file.
   */
  copyFileSync(dbPath, target);
  return target;
}

function main(): void {
  const noBackup = process.argv.includes("--no-backup");
  const dbPath = resolve(process.cwd(), env.DATABASE_PATH);

  console.log("\n  Database reset — clean slate");
  console.log("  ----------------------------");
  console.log(`  file : ${dbPath}`);

  if (!existsSync(dbPath)) {
    console.log("  (no database file yet — nothing to clear)\n");
    return;
  }

  let backup: string | null = null;
  if (noBackup) {
    console.warn("  backup: SKIPPED (--no-backup). This deletion is unrecoverable.");
  } else {
    backup = backupDatabase(dbPath);
    console.log(`  backup: ${backup}`);
  }

  initDatabase();

  const before = Object.fromEntries(HISTORY_TABLES.map((t) => [t, countRows(t)]));
  const total = Object.values(before).reduce((a, b) => a + b, 0);

  console.log("\n  Clearing:");
  for (const table of HISTORY_TABLES) {
    console.log(`    ${table.padEnd(24)} ${before[table]} row(s)`);
  }

  /*
   * One transaction: a reset that half-completed would leave positions without their
   * snapshots, which reads on the dashboard as a real trading record rather than as a
   * failed maintenance command.
   */
  const clear = db.transaction(() => {
    for (const table of HISTORY_TABLES) db.exec(`DELETE FROM "${table}";`);
    // Restarts AUTOINCREMENT counters so new rows number from 1 rather than continuing
    // a sequence that refers to trades nobody can look up any more.
    db.exec(`DELETE FROM sqlite_sequence;`);
  });
  clear();

  // Outside the transaction: VACUUM cannot run inside one. This is what actually
  // returns the pages to the filesystem and drops the deleted rows from the file, so a
  // "reset" database does not still contain the old trades in free pages.
  db.exec("VACUUM;");

  const after = HISTORY_TABLES.map((t) => countRows(t)).reduce((a, b) => a + b, 0);
  closeDatabase();

  if (after !== 0) {
    console.error(`\n  FAILED: ${after} row(s) still present after the reset.\n`);
    process.exitCode = 1;
    return;
  }

  console.log(`\n  Cleared ${total} row(s). PnL, trade history and research logs are empty.`);
  console.log("  exports/ and reports/ were NOT touched.");
  if (backup) console.log(`  Restore with:  cp "${backup}" "${dbPath}"`);
  console.log("");
}

main();
