/**
 * Exports the backtest audit findings to a self-contained HTML report.
 *
 *   npm run audit:report
 *   npm run audit:report -- --input=backtest_results_90d.json --out=reports/audit-90d.html
 *
 * Reads a backtest_results_<days>d.json produced by `npm run backtest` and renders
 * the biased-vs-unbiased comparison, the gas/slippage-vs-fee breakdown, and the TVL
 * model's k distribution. No chart library is used — the SVG is inlined so the file
 * opens offline and can be printed to PDF straight from the browser.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/* ------------------------------------------------------------------ */
/* Input shape (a subset of what the backtest writes)                  */
/* ------------------------------------------------------------------ */

interface Summary {
  totalTrades: number;
  wins: number;
  losses: number;
  winRatePct: number;
  netPnlUsd: number;
  grossProfitUsd: number;
  grossLossUsd: number;
  profitFactor: number | null;
  maxDrawdownPct: number;
  maxDrawdownUsd: number;
  avgTradeDurationHours: number;
  totalFeesUsd: number;
  totalPositionValueChangeUsd: number;
  totalGasCostUsd: number;
  totalSlippageCostUsd: number;
  ruggedTrades: number;
  catastrophicTrades: number;
  tradesOnDeadPools: number;
  startingEquityUsd: number;
  endingEquityUsd: number;
  returnPct: number;
  accountWipedOut: boolean;
  exitReasonCounts: Record<string, number>;
}

interface Run {
  label: string;
  windowStart: string;
  windowEnd: string;
  barsSimulated: number;
  config: Record<string, unknown>;
  summary: Summary;
  trades: Array<{
    pairName: string;
    cohort: string;
    entryTime: string;
    durationHours: number;
    feesEarnedUsd: number;
    positionValueChangeUsd: number;
    gasCostUsd: number;
    slippageCostUsd: number;
    netPnlUsd: number;
    netPnlPct: number;
    exitReason: string;
    rugged: boolean;
  }>;
  poolsSimulated: Array<{ pairName: string; cohort: string; tvlTodayUsd: number; bars: number }>;
}

interface AuditInput {
  generatedAt: string;
  dataSource: string;
  dataFetchedAt: string;
  caveats: string[];
  tvlModel: { medianK: number; p25K: number; p75K: number; samples: number };
  universe: { survivorPools: number; deadPools: number };
  biased: Run;
  unbiased: Run;
}

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

const usd = (n: number, d = 2): string =>
  `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  })}`;

const signedUsd = (n: number, d = 2): string => {
  const r = Math.round(n * 10 ** d) / 10 ** d;
  return `${r > 0 ? "+" : r < 0 ? "-" : ""}$${Math.abs(r).toFixed(d)}`;
};

const pct = (n: number, d = 1): string => `${n.toFixed(d)}%`;

/** Escapes text before it is interpolated into HTML. */
const esc = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const pf = (s: Summary): string =>
  s.profitFactor === null
    ? s.grossProfitUsd > 0
      ? "∞"
      : "n/a"
    : s.profitFactor.toFixed(2);

/* ------------------------------------------------------------------ */
/* Inline SVG charts                                                   */
/* ------------------------------------------------------------------ */

/** Horizontal bar chart. Values may be negative; the axis is drawn at zero. */
function barChart(
  items: Array<{ label: string; value: number; tone: "good" | "bad" | "neutral" }>,
  width = 560,
): string {
  const rowH = 30;
  const height = items.length * rowH + 10;
  const maxAbs = Math.max(1e-9, ...items.map((i) => Math.abs(i.value)));

  /*
   * Three fixed columns: label | plot | value. Drawing the value next to the bar end
   * collides with the label as soon as a negative bar runs the full half-width, so the
   * value gets its own reserved column instead.
   */
  const labelW = 180;
  const valueW = 90;
  const plotW = width - labelW - valueW;
  const zeroX = labelW + plotW / 2;

  const colour = (t: string): string =>
    t === "good" ? "#10b981" : t === "bad" ? "#f43f5e" : "#71717a";

  const bars = items
    .map((item, i) => {
      const y = i * rowH + 6;
      const w = (Math.abs(item.value) / maxAbs) * (plotW / 2 - 4);
      const x = item.value >= 0 ? zeroX : zeroX - w;
      return `
        <text x="${labelW - 10}" y="${y + 13}" text-anchor="end" class="lbl">${esc(item.label)}</text>
        <rect x="${x}" y="${y}" width="${Math.max(w, 1)}" height="18" rx="2"
              fill="${colour(item.tone)}" opacity="0.85"/>
        <text x="${width - 8}" y="${y + 13}" text-anchor="end" class="val">${signedUsd(item.value)}</text>`;
    })
    .join("");

  return `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img">
    <line x1="${zeroX}" y1="0" x2="${zeroX}" y2="${height}" stroke="#3f3f46" stroke-width="1"/>
    ${bars}
  </svg>`;
}

/** Histogram of per-pool k values used by the TVL model. */
function kHistogram(model: AuditInput["tvlModel"], width = 560): string {
  const height = 140;
  // Log-spaced buckets: k spans orders of magnitude.
  const edges = [0, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 50];
  const marks = [
    { k: model.p25K, label: "p25" },
    { k: model.medianK, label: "median" },
    { k: model.p75K, label: "p75" },
  ];

  const scale = (k: number): number => {
    const clamped = Math.min(Math.max(k, edges[0]!), edges[edges.length - 1]!);
    let idx = edges.findIndex((e) => clamped <= e);
    if (idx <= 0) idx = 1;
    const lo = edges[idx - 1]!;
    const hi = edges[idx]!;
    const frac = hi === lo ? 0 : (clamped - lo) / (hi - lo);
    return ((idx - 1 + frac) / (edges.length - 1)) * (width - 60) + 30;
  };

  const ticks = edges
    .map((e) => {
      const x = scale(e);
      return `<line x1="${x}" y1="90" x2="${x}" y2="96" stroke="#52525b"/>
              <text x="${x}" y="112" text-anchor="middle" class="tick">${e}</text>`;
    })
    .join("");

  const iqrX1 = scale(model.p25K);
  const iqrX2 = scale(model.p75K);

  const markers = marks
    .map((m) => {
      const x = scale(m.k);
      return `<line x1="${x}" y1="42" x2="${x}" y2="90" stroke="#10b981" stroke-width="2"/>
              <text x="${x}" y="34" text-anchor="middle" class="val">${m.label} ${m.k.toFixed(3)}</text>`;
    })
    .join("");

  return `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img">
    <rect x="${iqrX1}" y="48" width="${Math.max(iqrX2 - iqrX1, 2)}" height="36" rx="3"
          fill="#10b981" opacity="0.18"/>
    <line x1="30" y1="90" x2="${width - 30}" y2="90" stroke="#52525b"/>
    ${ticks}
    ${markers}
    <text x="${width / 2}" y="132" text-anchor="middle" class="tick">
      k = TVL / 24h volume · fitted on ${model.samples} live pools
    </text>
  </svg>`;
}

/* ------------------------------------------------------------------ */
/* Report                                                              */
/* ------------------------------------------------------------------ */

function comparisonRows(b: Summary, u: Summary): string {
  const row = (
    label: string,
    biased: string,
    unbiased: string,
    delta: string,
    deltaTone: "good" | "bad" | "neutral" = "neutral",
  ): string =>
    `<tr><td>${esc(label)}</td><td class="num">${biased}</td><td class="num">${unbiased}</td>
     <td class="num ${deltaTone}">${delta}</td></tr>`;

  const tone = (d: number, higherIsBetter = true): "good" | "bad" | "neutral" => {
    if (Math.abs(d) < 1e-9) return "neutral";
    return (d > 0) === higherIsBetter ? "good" : "bad";
  };

  return [
    row("Trades", String(b.totalTrades), String(u.totalTrades), `${u.totalTrades - b.totalTrades >= 0 ? "+" : ""}${u.totalTrades - b.totalTrades}`),
    row(
      "Win rate",
      pct(b.winRatePct),
      pct(u.winRatePct),
      `${(u.winRatePct - b.winRatePct).toFixed(1)}pp`,
      tone(u.winRatePct - b.winRatePct),
    ),
    row("Starting balance", usd(b.startingEquityUsd), usd(u.startingEquityUsd), "—"),
    row(
      "Ending balance",
      usd(b.endingEquityUsd),
      usd(u.endingEquityUsd),
      signedUsd(u.endingEquityUsd - b.endingEquityUsd),
      tone(u.endingEquityUsd - b.endingEquityUsd),
    ),
    row(
      "Return on capital",
      pct(b.returnPct),
      pct(u.returnPct),
      `${(u.returnPct - b.returnPct).toFixed(1)}pp`,
      tone(u.returnPct - b.returnPct),
    ),
    row("Profit factor", pf(b), pf(u), "—"),
    row(
      "Max drawdown",
      pct(b.maxDrawdownPct),
      pct(u.maxDrawdownPct),
      `${(u.maxDrawdownPct - b.maxDrawdownPct).toFixed(1)}pp`,
      tone(u.maxDrawdownPct - b.maxDrawdownPct, false),
    ),
    row("Rugged trades", String(b.ruggedTrades), String(u.ruggedTrades), `+${u.ruggedTrades - b.ruggedTrades}`, u.ruggedTrades > b.ruggedTrades ? "bad" : "neutral"),
    row("Catastrophic (≤ -80%)", String(b.catastrophicTrades), String(u.catastrophicTrades), `+${u.catastrophicTrades - b.catastrophicTrades}`, u.catastrophicTrades > b.catastrophicTrades ? "bad" : "neutral"),
    row("Trades on dead pools", String(b.tradesOnDeadPools), String(u.tradesOnDeadPools), `+${u.tradesOnDeadPools - b.tradesOnDeadPools}`),
    row("Account wiped out", b.accountWipedOut ? "YES" : "no", u.accountWipedOut ? "YES" : "no", "—", u.accountWipedOut ? "bad" : "neutral"),
  ].join("\n");
}

function render(input: AuditInput): string {
  const b = input.biased.summary;
  const u = input.unbiased.summary;

  const biasPp = u.returnPct - b.returnPct;
  const costTotal = u.totalGasCostUsd + u.totalSlippageCostUsd;
  const costsExceedFees = costTotal > u.totalFeesUsd;

  const worst = [...input.unbiased.trades].sort((x, y) => x.netPnlUsd - y.netPnlUsd).slice(0, 10);

  const exitRows = Object.entries(u.exitReasonCounts)
    .filter(([, n]) => n > 0)
    .sort((x, y) => y[1] - x[1])
    .map(
      ([reason, n]) =>
        `<tr><td>${esc(reason)}</td><td class="num">${n}</td>
         <td class="num">${pct((n / Math.max(1, u.totalTrades)) * 100)}</td></tr>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>FlowMetrix — Backtest Audit Report</title>
<style>
  :root {
    --bg: #09090b; --panel: #18181b; --edge: #27272a; --text: #e4e4e7;
    --muted: #a1a1aa; --dim: #71717a; --good: #10b981; --bad: #f43f5e; --warn: #f59e0b;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 32px 20px; background: var(--bg); color: var(--text);
    font: 14px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    font-feature-settings: "tnum" 1;
  }
  .wrap { max-width: 900px; margin: 0 auto; }
  h1 { font-size: 24px; margin: 0 0 4px; letter-spacing: -0.02em; }
  h2 { font-size: 16px; margin: 32px 0 12px; letter-spacing: -0.01em;
       border-bottom: 1px solid var(--edge); padding-bottom: 8px; }
  h3 { font-size: 13px; margin: 20px 0 8px; color: var(--muted); text-transform: uppercase;
       letter-spacing: 0.06em; }
  .sub { color: var(--dim); font-size: 12px; margin-bottom: 24px; }
  .panel { background: var(--panel); border: 1px solid var(--edge); border-radius: 8px;
           padding: 16px; margin-bottom: 16px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--edge); }
  th { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--dim);
       font-weight: 600; }
  tr:last-child td { border-bottom: none; }
  .num { text-align: right; font-variant-numeric: tabular-nums;
         font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
  .good { color: var(--good); } .bad { color: var(--bad); } .neutral { color: var(--muted); }
  .callout { border-left: 3px solid var(--warn); background: rgba(245,158,11,0.08);
             padding: 12px 16px; border-radius: 0 6px 6px 0; margin: 14px 0; font-size: 13px; }
  .callout.bad { border-left-color: var(--bad); background: rgba(244,63,94,0.08); }
  .callout strong { color: var(--warn); }
  .callout.bad strong { color: var(--bad); }
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
  .kpi { background: var(--panel); border: 1px solid var(--edge); border-radius: 8px; padding: 12px 14px; }
  .kpi .k { font-size: 10px; text-transform: uppercase; letter-spacing: 0.07em; color: var(--dim); }
  .kpi .v { font-size: 20px; font-weight: 600; margin-top: 4px;
            font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
  ol.caveats { padding-left: 20px; color: var(--muted); font-size: 12.5px; }
  ol.caveats li { margin-bottom: 10px; }
  .lbl { fill: #a1a1aa; font-size: 11px; font-family: ui-sans-serif, system-ui, sans-serif; }
  .val { fill: #e4e4e7; font-size: 11px;
         font-family: ui-monospace, Menlo, Consolas, monospace; }
  .tick { fill: #71717a; font-size: 10px; font-family: ui-sans-serif, system-ui, sans-serif; }
  footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid var(--edge);
           color: var(--dim); font-size: 11px; }
  @media print {
    body { background: #fff; color: #18181b; padding: 0; }
    .panel, .kpi { background: #fff; border-color: #d4d4d8; }
    .lbl, .val, .tick { fill: #3f3f46; }
    h2 { border-color: #d4d4d8; }
  }
</style>
</head>
<body>
<div class="wrap">

  <h1>FlowMetrix — Backtest Audit Report</h1>
  <div class="sub">
    Generated ${esc(input.generatedAt)} · data fetched ${esc(input.dataFetchedAt)}<br/>
    Window ${esc(input.unbiased.windowStart.slice(0, 16))} → ${esc(input.unbiased.windowEnd.slice(0, 16))} UTC
    · ${input.unbiased.barsSimulated} hourly bars
    · universe ${input.universe.survivorPools} survivors + ${input.universe.deadPools} dead/dormant<br/>
    Source: ${esc(input.dataSource)} · <strong>zero real capital deployed</strong>
  </div>

  <div class="kpis">
    <div class="kpi"><div class="k">Biased return</div>
      <div class="v ${b.returnPct >= 0 ? "good" : "bad"}">${pct(b.returnPct)}</div></div>
    <div class="kpi"><div class="k">Unbiased return</div>
      <div class="v ${u.returnPct >= 0 ? "good" : "bad"}">${pct(u.returnPct)}</div></div>
    <div class="kpi"><div class="k">Bias overstatement</div>
      <div class="v ${biasPp <= 0 ? "bad" : "good"}">${biasPp.toFixed(1)}pp</div></div>
    <div class="kpi"><div class="k">Rugged / catastrophic</div>
      <div class="v ${u.ruggedTrades + u.catastrophicTrades > 0 ? "bad" : "neutral"}">${u.ruggedTrades} / ${u.catastrophicTrades}</div></div>
  </div>

  <h2>1 · Survivorship bias, measured</h2>
  <p style="color:var(--muted);font-size:13px;margin-top:0">
    The same strategy, the same window, run twice. <strong>Biased</strong> sees only pools that
    survived to today — what a naive harness measures. <strong>Unbiased</strong> adds pools that
    died during or after the window, found by walking Meteora's unpruned listing
    (~123k pools) by creation date and keeping ones whose lifetime volume proves past
    activity but whose current volume has collapsed.
  </p>
  <div class="panel">
    <table>
      <thead><tr><th>Metric</th><th class="num">Biased</th><th class="num">Unbiased</th><th class="num">Delta</th></tr></thead>
      <tbody>${comparisonRows(b, u)}</tbody>
    </table>
  </div>
  <div class="callout${biasPp < 0 ? " bad" : ""}">
    <strong>Finding.</strong> Excluding failed pools overstates the return by
    ${Math.abs(biasPp).toFixed(1)} percentage points
    (${pct(b.returnPct)} → ${pct(u.returnPct)}).
    ${
      u.tradesOnDeadPools === 0
        ? "No trade landed on a dead pool in this sample, so the measured gap is a floor, not a ceiling."
        : `${u.tradesOnDeadPools} of ${u.totalTrades} trades landed on pools that later died.`
    }
  </div>

  <h2>2 · Where the money went: fees vs friction</h2>
  <div class="panel">
    ${barChart([
      { label: "Fees earned", value: u.totalFeesUsd, tone: "good" },
      { label: "Position value change", value: u.totalPositionValueChangeUsd, tone: u.totalPositionValueChangeUsd >= 0 ? "good" : "bad" },
      { label: "Gas paid", value: -u.totalGasCostUsd, tone: "bad" },
      { label: "Slippage paid", value: -u.totalSlippageCostUsd, tone: "bad" },
      { label: "= Net PnL", value: u.netPnlUsd, tone: u.netPnlUsd >= 0 ? "good" : "bad" },
    ])}
  </div>
  <div class="panel">
    <table>
      <thead><tr><th>Component</th><th class="num">USD</th><th class="num">% of starting capital</th></tr></thead>
      <tbody>
        <tr><td>Fees earned</td><td class="num good">${signedUsd(u.totalFeesUsd)}</td>
            <td class="num">${pct((u.totalFeesUsd / u.startingEquityUsd) * 100)}</td></tr>
        <tr><td>Position value change (vs capital)</td>
            <td class="num ${u.totalPositionValueChangeUsd >= 0 ? "good" : "bad"}">${signedUsd(u.totalPositionValueChangeUsd)}</td>
            <td class="num">${pct((u.totalPositionValueChangeUsd / u.startingEquityUsd) * 100)}</td></tr>
        <tr><td>Gas</td><td class="num bad">${usd(u.totalGasCostUsd)}</td>
            <td class="num">${pct((u.totalGasCostUsd / u.startingEquityUsd) * 100)}</td></tr>
        <tr><td>Slippage</td><td class="num bad">${usd(u.totalSlippageCostUsd)}</td>
            <td class="num">${pct((u.totalSlippageCostUsd / u.startingEquityUsd) * 100)}</td></tr>
        <tr><td><strong>Net PnL</strong></td>
            <td class="num ${u.netPnlUsd >= 0 ? "good" : "bad"}"><strong>${signedUsd(u.netPnlUsd)}</strong></td>
            <td class="num">${pct(u.returnPct)}</td></tr>
      </tbody>
    </table>
  </div>
  ${
    costsExceedFees
      ? `<div class="callout bad"><strong>Friction exceeds fee income.</strong>
         Gas plus slippage came to ${usd(costTotal)} against ${usd(u.totalFeesUsd)} of fees —
         the strategy paid more to trade than LPing returned. Every dollar of profit came from
         price movement, not from providing liquidity.</div>`
      : `<div class="callout"><strong>Friction is covered.</strong>
         Gas plus slippage came to ${usd(costTotal)} against ${usd(u.totalFeesUsd)} of fee income.</div>`
  }

  <h3>Exit reasons (unbiased run)</h3>
  <div class="panel">
    <table>
      <thead><tr><th>Reason</th><th class="num">Trades</th><th class="num">Share</th></tr></thead>
      <tbody>${exitRows}</tbody>
    </table>
  </div>

  <h2>3 · TVL model — the load-bearing assumption</h2>
  <p style="color:var(--muted);font-size:13px;margin-top:0">
    No free provider serves historical TVL for Meteora DLMM pools, so TVL at each bar is
    estimated as <code>k × trailing-24h-volume</code>. Every entry filter runs against that
    estimate, not a measurement. A current snapshot cannot be substituted: a rugged pool reads
    ~$0 today, so a snapshot <code>MIN_TVL_USD</code> filter would reject every dead pool and
    silently restore the bias this report exists to measure.
  </p>
  <div class="panel">${kHistogram(input.tvlModel)}</div>
  <div class="callout">
    <strong>Read the spread, not just the median.</strong>
    k spans ${input.tvlModel.p25K.toFixed(3)}–${input.tvlModel.p75K.toFixed(3)} across the
    interquartile range against a median of ${input.tvlModel.medianK.toFixed(3)} — roughly
    ${(input.tvlModel.p75K / Math.max(input.tvlModel.p25K, 1e-9)).toFixed(0)}× from p25 to p75.
    Any pool-level TVL figure in this report should be read as an order-of-magnitude estimate.
  </div>

  <h2>4 · Worst trades (unbiased run)</h2>
  <div class="panel">
    <table>
      <thead><tr><th>Pair</th><th>Cohort</th><th>Entry (UTC)</th><th class="num">Hrs</th>
        <th class="num">Fees</th><th class="num">Pos value</th><th class="num">Net</th>
        <th class="num">Net %</th><th>Exit</th></tr></thead>
      <tbody>
        ${worst
          .map(
            (t) => `<tr>
          <td>${esc(t.pairName)}</td>
          <td>${t.cohort === "dead-or-dormant" ? '<span class="bad">DEAD</span>' : "surv"}</td>
          <td class="num">${esc(t.entryTime.slice(5, 16).replace("T", " "))}</td>
          <td class="num">${t.durationHours.toFixed(0)}</td>
          <td class="num good">${usd(t.feesEarnedUsd)}</td>
          <td class="num ${t.positionValueChangeUsd >= 0 ? "good" : "bad"}">${signedUsd(t.positionValueChangeUsd)}</td>
          <td class="num ${t.netPnlUsd >= 0 ? "good" : "bad"}">${signedUsd(t.netPnlUsd)}</td>
          <td class="num ${t.netPnlPct >= 0 ? "good" : "bad"}">${t.netPnlPct.toFixed(1)}%</td>
          <td>${esc(t.exitReason)}${t.rugged ? ' <span class="bad">RUG</span>' : ""}</td>
        </tr>`,
          )
          .join("\n")}
      </tbody>
    </table>
  </div>

  <h2>5 · Caveats</h2>
  <ol class="caveats">
    ${input.caveats.map((c) => `<li>${esc(c)}</li>`).join("\n")}
  </ol>

  <footer>
    FlowMetrix paper-trading simulation. No real capital was deployed and no Solana transaction
    was signed. These figures are a model of past data under stated assumptions, not a prediction
    and not financial advice.
  </footer>

</div>
</body>
</html>`;
}

/* ------------------------------------------------------------------ */

function main(): void {
  const flags = new Map<string, string>();
  for (const arg of process.argv.slice(2)) {
    const m = /^--([a-z]+)=(.*)$/i.exec(arg);
    if (m) flags.set(m[1]!.toLowerCase(), m[2]!);
  }

  const inputPath = resolve(process.cwd(), flags.get("input") ?? "backtest_results_30d.json");
  const outPath = resolve(process.cwd(), flags.get("out") ?? "reports/backtest-audit.html");

  if (!existsSync(inputPath)) {
    console.error(
      `[audit] ${inputPath} not found. Run \`npm run backtest\` first, or pass --input=<file>.`,
    );
    process.exit(1);
  }

  const raw = JSON.parse(readFileSync(inputPath, "utf8")) as AuditInput;

  if (!raw.biased || !raw.unbiased || !raw.tvlModel) {
    console.error(
      "[audit] input is missing the biased/unbiased/tvlModel sections. It was probably " +
        "produced by an older backtest build — re-run `npm run backtest`.",
    );
    process.exit(1);
  }

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, render(raw), "utf8");

  const u = raw.unbiased.summary;
  const b = raw.biased.summary;

  console.log(`[audit] report written to ${outPath}`);
  console.log(
    `[audit] biased ${b.returnPct.toFixed(1)}% vs unbiased ${u.returnPct.toFixed(1)}% ` +
      `(${(u.returnPct - b.returnPct).toFixed(1)}pp), ` +
      `gas+slippage $${(u.totalGasCostUsd + u.totalSlippageCostUsd).toFixed(2)} ` +
      `vs fees $${u.totalFeesUsd.toFixed(2)}`,
  );
  console.log("[audit] open it in a browser and print to PDF for a shareable copy.");
}

main();
