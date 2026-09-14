/**
 * npm run report:live -- [--db=<path>] [--days=7] [--baseline-sol=3.10] [--json]
 *
 * Read-only report of what the LIVE engine has actually done, in SOL (see
 * `services/liveReport.ts`). Safe to run on the live host while the engine runs: the
 * database is opened `readonly`, nothing is migrated, nothing is sent anywhere.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { env } from "../config/env.js";
import { liveMicroCapital } from "../config/liveConfig.js";
import { buildLiveReport, openReportDatabase, readLiveReportInput, renderLiveReport } from "../services/liveReport.js";

const JSON_PATH = "reports/live_report.json";

export function parseReportFlags(argv: string[]): { db: string; days: number; baselineSol: number | null; json: boolean } {
  const flags = new Map<string, string>();
  for (const arg of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/i.exec(arg);
    if (m) flags.set(m[1]!.toLowerCase(), m[2] ?? "true");
  }
  const positive = (key: string, raw: string): number => {
    const v = Number(raw);
    if (!Number.isFinite(v) || v <= 0) throw new Error(`--${key}=${raw} must be a positive number`);
    return v;
  };
  return {
    db: resolve(process.cwd(), flags.get("db") ?? env.DATABASE_PATH),
    days: flags.has("days") ? positive("days", flags.get("days")!) : 7,
    baselineSol: flags.has("baseline-sol") ? positive("baseline-sol", flags.get("baseline-sol")!) : null,
    json: flags.has("json"),
  };
}

function main(): void {
  const opts = parseReportFlags(process.argv.slice(2));
  const db = openReportDatabase(opts.db);
  let input;
  try {
    input = readLiveReportInput(db);
  } finally {
    db.close();
  }
  const capital = liveMicroCapital.capitalSol;
  const report = buildLiveReport(input, {
    nowMs: Date.now(),
    windowDays: opts.days,
    liveCapitalSol: Number.isFinite(capital) && capital > 0 ? capital : null,
    baselineSol: opts.baselineSol,
  });
  console.log(`[report:live] database ${opts.db} (read-only)`);
  console.log(renderLiveReport(report));
  if (opts.json) {
    const path = resolve(process.cwd(), JSON_PATH);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(report, null, 2), "utf8");
    console.log(`\n[report:live] wrote ${JSON_PATH}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (err) {
    console.error("[report:live] failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
