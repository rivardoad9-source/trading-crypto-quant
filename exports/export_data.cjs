#!/usr/bin/env node
/**
 * FlowMetrix data exporter — dumps the paper-trading DB into clean CSV/JSON
 * files under exports/ so the data can be committed to git and analyzed
 * (e.g. from Claude Code on a laptop) without shipping the raw SQLite file.
 *
 * Run from the repo root:  node exports/export_data.cjs
 * Requires: better-sqlite3 (already a repo dependency), node v22 via nvm.
 *
 * Milestone mode (used by cron, 0 tokens — no_agent):
 *   node exports/export_data.cjs --milestone 50
 *   Exports + pushes ONLY when the total trade count has crossed a new multiple
 *   of 50 since the last export. Silent (no output) otherwise.
 *
 * Test overrides:
 *   FLOWMETRIX_DB          — source db path
 *   FLOWMETRIX_EXPORT_DIR  — output dir (default exports/)
 *   FLOWMETRIX_STATE       — milestone state file (default data/.export_milestone_state)
 *   FLOWMETRIX_NO_PUSH=1   — skip git commit/push (for tests)
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const Database = require("better-sqlite3");

const REPO = path.resolve(__dirname, "..");
const DB_PATH = process.env.FLOWMETRIX_DB || path.join(REPO, "data", "flowmetrix.db");
const OUT = process.env.FLOWMETRIX_EXPORT_DIR || path.join(REPO, "exports");
const STATE_PATH = process.env.FLOWMETRIX_STATE || path.join(REPO, "data", ".export_milestone_state");
const NO_PUSH = process.env.FLOWMETRIX_NO_PUSH === "1";

const argIdx = process.argv.indexOf("--milestone");
const MILESTONE = argIdx !== -1 ? Number(process.argv[argIdx + 1]) : null;
// --push: unconditional export + git push (used by the nightly cron).
const PUSH = process.argv.includes("--push");

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
  fs.writeFileSync(path.join(OUT, filename), lines.join("\n") + "\n");
  return rows;
}

function dumpTableJson(table, filename) {
  const rows = db.prepare(`SELECT * FROM ${table}`).all();
  fs.writeFileSync(path.join(OUT, filename), JSON.stringify(rows, null, 2));
  return rows;
}

function exportAll() {
  const trades = dumpTableCsv("simulated_positions", "trades.csv");
  const dailyPnl = dumpTableCsv("daily_pnl_snapshots", "daily_pnl.csv");
  const research = dumpTableJson("daily_research_logs", "research_logs.json");

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
  return summary;
}

function readState() {
  try {
    return Number(fs.readFileSync(STATE_PATH, "utf8").trim()) || 0;
  } catch {
    return 0;
  }
}

function writeState(n) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, String(n));
}

function gitPush(commitMsg) {
  if (NO_PUSH) return;
  try {
    execSync("git add exports/", { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
    const dirty = execSync("git diff --cached --quiet || echo dirty", { cwd: REPO })
      .toString()
      .trim();
    if (dirty === "dirty") {
      execSync(`git commit -m "${commitMsg}"`, { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
      // Rebase onto remote first so a concurrent push from the laptop can't
      // make the nightly push fail with a non-fast-forward rejection.
      execSync("git pull --rebase origin main", { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
      execSync("git push origin main", { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
      const local = execSync("git rev-parse HEAD", { cwd: REPO }).toString().trim();
      const remote = execSync("git ls-remote origin main", { cwd: REPO })
        .toString()
        .trim()
        .split(/\s+/)[0];
      if (local !== remote) throw new Error(`verify mismatch: local ${local} remote ${remote}`);
    }
  } catch (e) {
    console.error(`❌ FlowMetrix export push FAILED: ${e.stderr || e.message}`);
    process.exit(1);
  }
}

const totalTrades = db.prepare("SELECT COUNT(*) AS n FROM simulated_positions").get().n;

if (MILESTONE) {
  const last = readState();
  const nowBucket = Math.floor(totalTrades / MILESTONE);
  if (nowBucket <= Math.floor(last / MILESTONE)) {
    process.exit(0); // no new milestone — stay silent (0 tokens, no message)
  }
  const summary = exportAll();
  gitPush(`chore: export trading data (${totalTrades} trades)`);
  writeState(totalTrades);
  const net = summary.totalRealizedPnlUsd;
  console.log(
    `📊 FlowMetrix: ${totalTrades} trade tercatat (kelipatan ${MILESTONE}) — data di-export & push ke GitHub ✅ (net ${net >= 0 ? "+" : ""}${net.toFixed(2)} USD, dry-run)`,
  );
} else if (PUSH) {
  const summary = exportAll();
  gitPush(`chore: export trading data (${totalTrades} trades)`);
  const net = summary.totalRealizedPnlUsd;
  console.log(
    `📊 FlowMetrix: ${totalTrades} trade — data di-export & push ke GitHub ✅ (net ${net >= 0 ? "+" : ""}${net.toFixed(2)} USD, dry-run)`,
  );
} else {
  exportAll();
  console.log(`Done. ${totalTrades} trades exported to ${OUT}`);
}

db.close();
