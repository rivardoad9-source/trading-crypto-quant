/*
 * Regenerates the TRADES block inside docs/analytics_dashboard.html from
 * exports/trades.csv.
 *
 * THIS FILE DEFINES THE CANONICAL SNAPSHOT SHAPE. Any other pipeline that writes that
 * block — including the one on the server — must emit the same fields in the same order
 * with the same rounding, so a snapshot regenerated anywhere produces a minimal diff.
 *
 *     {"id": <position_id>, "t": <closed_at as ISO 8601 with a Z>, "p": <realized_pnl_usd
 *      rounded to 6 decimal places>, "pool": <pair_name>, "v": <engine_version>}
 *
 * Every row carries every field, for every engine version. A hybrid snapshot — some rows
 * with an id, some without — is what broke the dashboard twice: `id` is the join key to
 * TRADE_DETAILS and to /api/positions/:id, so a row without one cannot open its detail
 * panel, and a dedupe keyed on a field only half the rows carry collapses the archive
 * onto a single map entry.
 *
 * `p` is rounded to 1e-6 because the page's dedupe key rounds to the same place. The live
 * API serves raw floats; the snapshot serves 6dp. Rounding both to 1e-6 is what lets a
 * live row recognise its archive twin instead of being counted twice. Changing the
 * rounding here without changing tradeKey() in the page reintroduces double counting.
 *
 * The page filters the cohort itself (ENGINE_COHORT), so this writes ALL engine versions
 * and never pre-filters. Deciding what to display is the page's job, not the export's.
 *
 * Usage: node scripts/regenerate-analytics-snapshot.mjs [--check]
 *        --check reports drift without writing.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CSV = path.join(root, "exports", "trades.csv");
const PAGE = path.join(root, "docs", "analytics_dashboard.html");
const checkOnly = process.argv.includes("--check");

/** Minimal RFC4180 reader: the reasoning_log and post_mortem columns contain commas. */
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ",") { row.push(field); field = ""; continue; }
    if (c === "\r") continue;
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += c;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter(r => r.length > 1);
}

/*
 * Stored timestamps are UTC with no zone marker, which `new Date()` would read as local
 * time. The Z is added here so the page never has to guess — the same trap parseDbTimestamp
 * exists to avoid on the engine side.
 */
const toIsoZ = (stamp) => String(stamp).trim().replace(" ", "T") + "Z";

/** 6 decimal places, and -0 normalised to 0 so a rounded loss cannot serialise as "-0". */
const round6 = (n) => {
  const v = Math.round(Number(n) * 1e6) / 1e6;
  return Object.is(v, -0) ? 0 : v;
};

const rows = parseCsv(fs.readFileSync(CSV, "utf8"));
const header = rows[0];
const col = (name) => {
  const i = header.indexOf(name);
  if (i < 0) throw new Error("exports/trades.csv has no column " + name);
  return i;
};
const iId = col("position_id"), iPair = col("pair_name"), iPnl = col("realized_pnl_usd");
const iClosed = col("closed_at"), iVer = col("engine_version");

const trades = rows.slice(1)
  .filter(r => r[iClosed] && r[iClosed].trim() !== "")
  .map(r => ({
    id: r[iId].trim(),
    t: toIsoZ(r[iClosed]),
    p: round6(r[iPnl]),
    pool: r[iPair],
    v: r[iVer].trim(),
  }))
  .sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : a.id < b.id ? -1 : 1));

/* ---- refuse to emit a snapshot that cannot be de-duplicated or joined ---- */
const problems = [];
for (const t of trades) {
  if (!t.id) problems.push("row at " + t.t + " has no position_id");
  if (!t.v) problems.push("row " + t.id + " has no engine_version");
  if (!Number.isFinite(t.p)) problems.push("row " + t.id + " has a non-numeric pnl");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(t.t)) problems.push("row " + t.id + " has a malformed close time: " + t.t);
}
const keys = trades.map(t => t.t + "|" + t.pool + "|" + Math.round(t.p * 1e6));
const dupKeys = keys.filter((k, i) => keys.indexOf(k) !== i);
if (dupKeys.length) problems.push("dedupe-key collision: " + [...new Set(dupKeys)].join(", "));
if (new Set(trades.map(t => t.id)).size !== trades.length) problems.push("duplicate position_id in the export");
if (problems.length) {
  console.error("REFUSING to write — the export cannot produce a canonical snapshot:");
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}

const line = (t) => "  " + JSON.stringify({ id: t.id, t: t.t, p: t.p, pool: t.pool, v: t.v });
const block = trades.map(line).join(",\n");

const page = fs.readFileSync(PAGE, "utf8");
const eol = page.includes("\r\n") ? "\r\n" : "\n";
const startMark = "const TRADES = [";
const start = page.indexOf(startMark);
const end = page.indexOf(eol + "];", start);
if (start < 0 || end < 0) { console.error("TRADES block not found in " + PAGE); process.exit(1); }

const current = page.slice(start + startMark.length, end);
const next = eol + block.split("\n").join(eol);

const byVersion = trades.reduce((acc, t) => ((acc[t.v] = (acc[t.v] || 0) + 1), acc), {});
console.log("rows: " + trades.length + "  " + JSON.stringify(byVersion));
console.log("all rows carry an id: " + trades.every(t => t.id.length > 0));

if (current === next) { console.log("snapshot already canonical — no change"); process.exit(0); }
if (checkOnly) { console.error("DRIFT: the snapshot differs from exports/trades.csv"); process.exit(1); }

fs.writeFileSync(PAGE, page.slice(0, start + startMark.length) + next + page.slice(end));
console.log("snapshot rewritten in docs/analytics_dashboard.html");
