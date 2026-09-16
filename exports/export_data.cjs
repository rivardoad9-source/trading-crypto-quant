#!/usr/bin/env node
/**
 * FlowMetrix data exporter — dumps the paper-trading DB into clean CSV/JSON
 * files under exports/ so the data can be committed to git and analyzed
 * (e.g. from Claude Code on a laptop) without shipping the raw SQLite file.
 *
 * Run from the repo root:  node exports/export_data.cjs
 * Requires: better-sqlite3 (already a repo dependency), node v22 via nvm.
 *
 * Engine version labelling: every trade row carries an `engine_version` column
 * ("v1.0", "v1.1", ...) decided by opened_at vs the ENGINE_V*_CUTOFF env vars —
 * the same rule the engine's cohort filter uses (src/services/cohort.ts).
 * Cutoffs are read from .env (ENGINE_V11_CUTOFF=...), falling back to the
 * engine's own default for v1.1. Add ENGINE_V12_CUTOFF etc. for future versions;
 * the exporter picks them up automatically.
 *
 * Modes:
 *   (no args)          — export only, print summary
 *   --push             — export + commit + push (nightly cron)
 *   --milestone <N>    — export + push only when total trades crossed a multiple of N
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

/* ------------------------------------------------------------------ */
/* Engine version cutoffs (mirrors src/services/cohort.ts)             */
/* ------------------------------------------------------------------ */

function loadVersionCutoffs() {
  const envMap = {};
  try {
    for (const line of fs.readFileSync(path.join(REPO, ".env"), "utf8").split("\n")) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m) envMap[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    /* no .env — fall back to defaults below */
  }
  // Same default as src/config/env.ts.
  envMap.ENGINE_V11_CUTOFF = envMap.ENGINE_V11_CUTOFF || "2026-08-29T13:20:40Z";

  const cutoffs = [];
  for (const [key, value] of Object.entries(envMap)) {
    const m = /^ENGINE_V(\d+)_CUTOFF$/.exec(key);
    if (!m || !value) continue;
    const digits = m[1]; // "11" -> "v1.1"
    const label = `v${digits[0]}.${digits.slice(1)}`;
    const ts = Date.parse(value);
    if (Number.isFinite(ts)) cutoffs.push({ label, ts });
  }
  return cutoffs.sort((a, b) => a.ts - b.ts);
}

const CUTOFFS = loadVersionCutoffs();

/** DB stores UTC datetimes as "YYYY-MM-DD HH:MM:SS"; normalise to epoch. */
function openedAtTs(openedAt) {
  if (!openedAt) return 0;
  const ts = Date.parse(`${openedAt.replace(" ", "T")}Z`);
  return Number.isFinite(ts) ? ts : 0;
}

/** Newest cohort whose cutoff the trade opened on/after; v1.0 before any cutoff. */
function engineVersion(openedAt) {
  const ts = openedAtTs(openedAt);
  let version = "v1.0";
  for (const c of CUTOFFS) if (ts >= c.ts) version = c.label;
  return version;
}

/* ------------------------------------------------------------------ */

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
  // trades.csv gets the engine_version column appended.
  const stmt = db.prepare("SELECT * FROM simulated_positions");
  const trades = stmt.all();
  const baseCols = stmt.columns().map((c) => c.name);
  const cols = [...baseCols, "engine_version"];
  const lines = [cols.join(",")];
  for (const r of trades) {
    lines.push([...baseCols.map((c) => csvCell(r[c])), csvCell(engineVersion(r.opened_at))].join(","));
  }
  fs.writeFileSync(path.join(OUT, "trades.csv"), lines.join("\n") + "\n");

  const dailyPnl = dumpTableCsv("daily_pnl_snapshots", "daily_pnl.csv");
  const research = dumpTableJson("daily_research_logs", "research_logs.json");

  // Per-version breakdown so "which version produced which results" is one glance.
  const byVersion = {};
  for (const t of trades) {
    const v = engineVersion(t.opened_at);
    byVersion[v] = byVersion[v] || { total: 0, wins: 0, losses: 0, netUsd: 0 };
    byVersion[v].total += 1;
    const pnl = Number(t.realized_pnl_usd) || 0;
    byVersion[v].netUsd += pnl;
    if (t.status === "CLOSED_PROFIT") byVersion[v].wins += 1;
    else if (t.status === "CLOSED_LOSS") byVersion[v].losses += 1;
  }
  const versionSummary = Object.entries(byVersion)
    .map(([version, s]) => ({ version, ...s, netUsd: Math.round(s.netUsd * 100) / 100 }))
    .sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }));

  const summary = {
    exportedAt: new Date().toISOString(),
    sourceDb: path.basename(DB_PATH),
    cutoffs: CUTOFFS.map((c) => ({ version: c.label, openedAtFrom: new Date(c.ts).toISOString() })),
    totalSimulatedTrades: trades.length,
    activePositions: trades.filter((t) => t.status === "ACTIVE").length,
    closedProfit: trades.filter((t) => t.status === "CLOSED_PROFIT").length,
    closedLoss: trades.filter((t) => t.status === "CLOSED_LOSS").length,
    totalRealizedPnlUsd: Math.round(
      trades
        .filter((t) => t.status.startsWith("CLOSED"))
        .reduce((s, t) => s + (Number(t.realized_pnl_usd) || 0), 0) * 100,
    ) / 100,
    perVersion: versionSummary,
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
    // Fail FAST if the live worktree is not on `main`.
    //
    // The cron export always commits in whatever tree it finds and always pushes
    // `origin main`. If a session left the tree on a feature/backtest branch, the
    // export commits onto THAT branch and then pushes main unchanged, ending in a
    // confusing "verify mismatch: local <sha> remote <sha>". That is exactly what
    // happened on 16 Sep 2026 22:00 — a backtest run had checked out
    // `backtest/eyyyys-vs-v11`, so the export failed and left a stray commit on the
    // backtest branch. Checking the branch BEFORE `git add` keeps the tree clean and
    // turns the failure into an actionable message.
    let branch = "";
    try {
      branch = execSync("git symbolic-ref --short HEAD", { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] })
        .toString()
        .trim();
    } catch {
      branch = "(detached HEAD)";
    }
    if (branch !== "main") {
      throw new Error(
        `refusing to export: live worktree is on '${branch}', not 'main'. ` +
          `No commit was created. Fix with: cd ${REPO} && git checkout main`
      );
    }
    execSync("git add exports/", { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
    const dirty = execSync("git diff --cached --quiet || echo dirty", { cwd: REPO })
      .toString()
      .trim();
    if (dirty === "dirty") {
      execSync(`git commit -m "${commitMsg}"`, { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
      // Rebase onto remote first so a concurrent push from the laptop can't
      // make the nightly push fail with a non-fast-forward rejection.
      //
      // `--autostash`, because this working tree is NEVER clean: the engine writes
      // exports/, data/ and .env as it runs, and `git pull --rebase` refuses outright
      // when anything is unstaged ("cannot pull with rebase: You have unstaged
      // changes"). That is exactly how the 11 Sep 2026 nightly export failed — it
      // committed its own files, then refused to rebase because of changes it does not
      // own, and exited 1 with nothing pushed. Autostash puts those aside for the
      // rebase and restores them afterwards.
      execSync("git pull --rebase --autostash origin main", { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
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

function versionLine(summary) {
  return summary.perVersion.map((v) => `${v.version}: ${v.total} trade`).join(" · ");
}

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
    `📊 FlowMetrix: ${totalTrades} trade (kelipatan ${MILESTONE}) — export & push ke GitHub ✅ (net ${net >= 0 ? "+" : ""}${net.toFixed(2)} USD · ${versionLine(summary)})`,
  );
} else if (PUSH) {
  const summary = exportAll();
  gitPush(`chore: export trading data (${totalTrades} trades)`);
  const net = summary.totalRealizedPnlUsd;
  console.log(
    `📊 FlowMetrix: ${totalTrades} trade — export & push ke GitHub ✅ (net ${net >= 0 ? "+" : ""}${net.toFixed(2)} USD · ${versionLine(summary)})`,
  );
} else {
  const summary = exportAll();
  console.log(`Done. ${totalTrades} trades exported to ${OUT}`);
  for (const v of summary.perVersion) {
    console.log(`  ${v.version}: ${v.total} trades, ${v.wins}W/${v.losses}L, net $${v.netUsd.toFixed(2)}`);
  }
}

db.close();
