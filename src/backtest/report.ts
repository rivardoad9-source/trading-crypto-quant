import type { BacktestResult, BacktestSummary, ExitReason } from "./engine.js";
import { BACKTEST_CAVEATS } from "./historicalData.js";
import { describeTvlModel, type TvlModel } from "./tvlModel.js";

/* ------------------------------------------------------------------ */
/* Minimal CLI table                                                   */
/* ------------------------------------------------------------------ */

export type Align = "left" | "right";

export interface Column {
  header: string;
  align?: Align;
}

/** Box-drawing table sized to its widest cell, with no external dependency. */
export function renderTable(columns: Column[], rows: string[][]): string {
  const widths = columns.map((c, i) =>
    Math.max(c.header.length, ...rows.map((r) => (r[i] ?? "").length)),
  );

  const pad = (text: string, width: number, align: Align): string =>
    align === "right" ? text.padStart(width) : text.padEnd(width);

  const line = (l: string, m: string, r: string): string =>
    l + widths.map((w) => "─".repeat(w + 2)).join(m) + r;

  const renderRow = (cells: string[]): string =>
    "│ " +
    columns.map((c, i) => pad(cells[i] ?? "", widths[i]!, c.align ?? "left")).join(" │ ") +
    " │";

  return [
    line("┌", "┬", "┐"),
    renderRow(columns.map((c) => c.header)),
    line("├", "┼", "┤"),
    ...rows.map(renderRow),
    line("└", "┴", "┘"),
  ].join("\n");
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
  const rounded = Math.round(n * 10 ** d) / 10 ** d;
  const sign = rounded > 0 ? "+" : rounded < 0 ? "-" : "";
  return `${sign}$${Math.abs(rounded).toFixed(d)}`;
};

const pct = (n: number, d = 2): string => `${n.toFixed(d)}%`;

const profitFactorLabel = (s: BacktestSummary): string =>
  s.profitFactor === null
    ? s.totalTrades > 0 && s.grossProfitUsd > 0
      ? "∞ (no losses)"
      : "n/a"
    : s.profitFactor.toFixed(2);

const EXIT_LABELS: Record<ExitReason, string> = {
  OUT_OF_RANGE: "Out of range",
  FEE_TAKE_PROFIT: "Fee take-profit",
  TAKE_PROFIT: "Net take-profit",
  TIMEOUT: "Max duration",
  END_OF_DATA: "Open at window end",
  STOP_LOSS: "Stop-loss",
  RUGGED: "RUGGED (no exit liquidity)",
};

const indent = (block: string): string =>
  block
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n");

/* ------------------------------------------------------------------ */
/* Comparison report                                                   */
/* ------------------------------------------------------------------ */

export interface ComparisonInput {
  biased: BacktestResult;
  unbiased: BacktestResult;
  tvlModel: TvlModel;
  survivorPools: number;
  deadPools: number;
}

export function renderComparisonReport(input: ComparisonInput): string {
  const { biased, unbiased, tvlModel } = input;
  const b = biased.summary;
  const u = unbiased.summary;
  const c = unbiased.config;

  const out: string[] = [];
  const days =
    (Date.parse(unbiased.windowEnd) - Date.parse(unbiased.windowStart)) / 86_400_000;

  out.push("");
  out.push("═".repeat(78));
  out.push("  FLOWMETRIX — SURVIVORSHIP-BIAS CONTROLLED BACKTEST (paper, zero capital)");
  out.push("═".repeat(78));
  out.push("");
  out.push(
    `  Window        : ${unbiased.windowStart.slice(0, 16)} → ${unbiased.windowEnd.slice(0, 16)} UTC (${days.toFixed(1)}d)`,
  );
  out.push(`  Capital       : ${usd(u.startingEquityUsd)} starting balance, compounding`);
  out.push(`  Bin range     : -${c.downsideCoverPct}% / +${c.upsideCoverPct}% around entry`);
  out.push(
    `  Entry filter  : vol24h ≥ ${usd(c.minVolume24hUsd, 0)} · TVL ≥ ${usd(c.minTvlUsd, 0)} · ` +
      `fee/TVL ${(c.minFeeTvlRatio * 100).toFixed(2)}%–${(c.maxFeeTvlRatio * 100).toFixed(0)}%`,
  );
  out.push(
    `  Costs         : gas ${c.gasSolPerTransaction} SOL/tx (x2) · forced-exit slippage ${c.forcedExitSlippagePct}%`,
  );
  out.push(`  Pool universe : ${input.survivorPools} survivors + ${input.deadPools} dead/dormant`);
  out.push(`  TVL model     : ${describeTvlModel(tvlModel)}`);
  out.push("");

  /* ---- headline comparison ---- */
  const delta = (bv: number, uv: number, fmt: (n: number) => string): string => {
    const d = uv - bv;
    return `${d >= 0 ? "+" : ""}${fmt(d)}`;
  };

  out.push("  A · SURVIVORSHIP BIAS vs REALISTIC UNBIASED");
  out.push(
    indent(
      renderTable(
        [
          { header: "Metric" },
          { header: "Biased (survivors only)", align: "right" },
          { header: "Unbiased (+ failed pools)", align: "right" },
          { header: "Delta", align: "right" },
        ],
        [
          [
            "Trades",
            String(b.totalTrades),
            String(u.totalTrades),
            delta(b.totalTrades, u.totalTrades, (n) => n.toFixed(0)),
          ],
          [
            "Win rate",
            pct(b.winRatePct, 1),
            pct(u.winRatePct, 1),
            delta(b.winRatePct, u.winRatePct, (n) => `${n.toFixed(1)}pp`),
          ],
          [
            "Ending balance",
            usd(b.endingEquityUsd),
            usd(u.endingEquityUsd),
            delta(b.endingEquityUsd, u.endingEquityUsd, (n) => usd(Math.abs(n))),
          ],
          [
            "Net PnL",
            signedUsd(b.netPnlUsd),
            signedUsd(u.netPnlUsd),
            delta(b.netPnlUsd, u.netPnlUsd, (n) => usd(Math.abs(n))),
          ],
          [
            "Return",
            pct(b.returnPct, 1),
            pct(u.returnPct, 1),
            delta(b.returnPct, u.returnPct, (n) => `${n.toFixed(1)}pp`),
          ],
          ["Profit factor", profitFactorLabel(b), profitFactorLabel(u), "—"],
          [
            "Max drawdown",
            pct(b.maxDrawdownPct, 1),
            pct(u.maxDrawdownPct, 1),
            delta(b.maxDrawdownPct, u.maxDrawdownPct, (n) => `${n.toFixed(1)}pp`),
          ],
          [
            "Rugged trades",
            String(b.ruggedTrades),
            String(u.ruggedTrades),
            delta(b.ruggedTrades, u.ruggedTrades, (n) => n.toFixed(0)),
          ],
          [
            "Catastrophic (≤ -80%)",
            String(b.catastrophicTrades),
            String(u.catastrophicTrades),
            delta(b.catastrophicTrades, u.catastrophicTrades, (n) => n.toFixed(0)),
          ],
          ["Account wiped out", b.accountWipedOut ? "YES" : "no", u.accountWipedOut ? "YES" : "no", "—"],
        ],
      ),
    ),
  );
  out.push("");

  /* ---- failure detail ---- */
  out.push("  B · FAILURE & COST BREAKDOWN (unbiased run)");
  out.push(
    indent(
      renderTable(
        [{ header: "Item" }, { header: "Value", align: "right" }],
        [
          ["Trades on dead/dormant pools", String(u.tradesOnDeadPools)],
          ["Rugged (no exit liquidity)", String(u.ruggedTrades)],
          ["Catastrophic loss (≤ -80%)", String(u.catastrophicTrades)],
          ["PnL from rugged trades", signedUsd(u.ruggedLossUsd)],
          ["— components —", ""],
          ["Total fees earned", signedUsd(u.totalFeesUsd)],
          ["Total position value change", signedUsd(u.totalPositionValueChangeUsd)],
          ["Total gas paid", usd(u.totalGasCostUsd)],
          ["Total slippage paid", usd(u.totalSlippageCostUsd)],
          ["= Net PnL", signedUsd(u.netPnlUsd)],
        ],
      ),
    ),
  );
  out.push("");

  /* ---- entry gate rejections ---- */
  const GATE_LABELS: Record<string, string> = {
    lowVolume: "24h volume below floor",
    lowTvl: "modelled TVL below floor",
    lowFeeTvl: "fee/TVL below floor",
    feeTvlOutlier: "fee/TVL above plausibility ceiling",
    volatilityUnknown: "24h price change unknown",
    pumped: "already pumped past the ceiling",
    belowBreakeven: "fees cannot cover round-trip cost",
  };

  const gates = Object.entries(unbiased.gateRejections)
    .filter(([, n]) => n > 0)
    .sort((a, b2) => b2[1] - a[1]);

  if (gates.length > 0) {
    // A zero-trade run has to be explainable, or a too-strict filter looks like a bug.
    out.push("  C · ENTRY GATE REJECTIONS (unbiased run, pool-bar evaluations)");
    out.push(
      indent(
        renderTable(
          [{ header: "Gate" }, { header: "Rejections", align: "right" }],
          gates.map(([gate, n]) => [GATE_LABELS[gate] ?? gate, String(n)]),
        ),
      ),
    );
    if (u.totalTrades === 0) {
      out.push("");
      out.push("  ⚠ No trade was executed. The gate above with the most rejections is binding.");
    }
    out.push("");
  }

  /* ---- exit reasons ---- */
  const reasons = (Object.entries(u.exitReasonCounts) as Array<[ExitReason, number]>)
    .filter(([, n]) => n > 0)
    .sort((a, b2) => b2[1] - a[1]);

  out.push("  D · EXIT REASONS (unbiased run)");
  out.push(
    indent(
      renderTable(
        [
          { header: "Reason" },
          { header: "Trades", align: "right" },
          { header: "Share", align: "right" },
        ],
        reasons.map(([reason, n]) => [
          EXIT_LABELS[reason],
          String(n),
          u.totalTrades > 0 ? pct((n / u.totalTrades) * 100, 1) : "—",
        ]),
      ),
    ),
  );
  out.push("");

  /* ---- worst trades ---- */
  const worst = [...unbiased.trades].sort((a, b2) => a.netPnlUsd - b2.netPnlUsd).slice(0, 10);
  if (worst.length > 0) {
    out.push("  E · WORST TRADES (unbiased run)");
    out.push(
      indent(
        renderTable(
          [
            { header: "Pair" },
            { header: "Cohort" },
            { header: "Entry (UTC)" },
            { header: "Hrs", align: "right" },
            { header: "Fees", align: "right" },
            { header: "Pos value", align: "right" },
            { header: "Net", align: "right" },
            { header: "Net %", align: "right" },
            { header: "Exit" },
          ],
          worst.map((t) => [
            t.pairName.slice(0, 16),
            t.cohort === "dead-or-dormant" ? "DEAD" : "surv",
            t.entryTime.slice(5, 16).replace("T", " "),
            t.durationHours.toFixed(0),
            usd(t.feesEarnedUsd),
            signedUsd(t.positionValueChangeUsd),
            signedUsd(t.netPnlUsd),
            `${t.netPnlPct >= 0 ? "+" : ""}${t.netPnlPct.toFixed(1)}%`,
            EXIT_LABELS[t.exitReason],
          ]),
        ),
      ),
    );
    out.push("");
  }

  /* ---- caveats ---- */
  out.push("  MODEL CAVEATS — read before trusting these numbers");
  for (const caveat of BACKTEST_CAVEATS) {
    const wrapped = wrap(caveat, 70);
    out.push(`   • ${wrapped[0]}`);
    for (const line of wrapped.slice(1)) out.push(`     ${line}`);
  }
  out.push("");
  out.push("═".repeat(78));
  out.push("");

  return out.join("\n");
}

function wrap(text: string, width: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    if (current.length + word.length + 1 > width) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  return lines;
}
