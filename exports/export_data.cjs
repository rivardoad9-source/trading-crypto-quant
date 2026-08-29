#!/usr/bin/env node
/**
 * FlowMetrix data exporter — dumps the paper-trading DB into clean CSV/JSON
 * files under exports/ so the data can be committed to git and analyzed
 * (e.g. from Claude Code on a laptop) without shipping the raw SQLite file.
 *
 * Run from the repo root:  node exports/export_data.cjs
 * Requires: better-sqlite3 (already a repo dependency), node v22 via nvm.
 */
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const REPO = path.resolve(__dirname, "..");
const DB_PATH = process.env.FLOWMETRIX_DB || path.join(REPO, "data", "flowmetrix.db");
const OUT = path.join(REPO, "exports");

if (!fs.existsSync(DB_PATH)) {
  console.error(`DB not found: ${DB_PATH}`);
  process.exit(1);
}

fs.mkdirSync(OUT, { recursive: true });
const db = new Database(DB_PATH, { readonly: true });

/** Escape a value for CSV (RFC 4180-ish). */
function csvCell(v) {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Dump a table to CSV with its real column names. */
function dumpTableCsv(table, filename) {
  const stmt = db.prepare(`SELECT * FROM ${table}`);
  const rows = stmt.all();
  const cols = stmt.columns().map((c) => c.name);
  const lines = [cols.join(",")];
  for (const r of rows) lines.push(cols.map((c) => csvCell(r[c])).join(","));
  const out = path.join(OUT, filename);
  fs.writeFileSync(out, lines.join("\n") + "\n");
  console.log(`${filename}: ${rows.length} rows, ${cols.length} cols`);
  return rows;
}

function dumpTableJson(table, filename) {
  const rows = db.prepare(`SELECT * FROM ${table}`).all();
  fs.writeFileSync(path.join(OUT, filename), JSON.stringify(rows, null, 2));
  console.log(`${filename}: ${rows.length} rows`);
  return rows;
}

console.log(`Exporting from ${DB_PATH}\n`);

const trades = dumpTableCsv("simulated_positions", "trades.csv");
const dailyPnl = dumpTableCsv("daily_pnl_snapshots", "daily_pnl.csv");
const research = dumpTableJson("daily_research_logs", "research_logs.json");

// Summary snapshot for a quick look without opening anything.
const summary = {
  exportedAt: new Date().toISOString(),
  sourceDb: path.basename(DB_PATH),
  totalSimulatedTrades: trades.length,
  activePositions: trades.filter((t) => t.status === "ACTIVE").length,
  closedProfit: trades.filter((t) => t.status === "CLOSED_PROFIT").length,
  closedLoss: trades.filter((t) => t.status === "CLOSED_LOSS").length,
  totalRealizedPnlUsd: trades
    .filter((t) => t.status.startsWith("CLOSED"))
    .reduce((s, t) => s + (Number(t.realized_pnl_usd) || 0), 0),
  researchLogs: research.length,
  dailyPnlSnapshots: dailyPnl.length,
};
fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
console.log(`summary.json: ${summary.totalSimulatedTrades} trades, net $${summary.totalRealizedPnlUsd.toFixed(2)}`);

db.close();
console.log("\nDone. Commit exports/ to git to share the data.");
