"use client";

import { useCallback } from "react";
import { Scale } from "lucide-react";
import { fetchReconciliation, formatSignedUsd } from "@/lib/api";
import { usePolled } from "@/lib/usePolled";

/**
 * The engine's book against the wallet.
 *
 * Every other panel on this page reports what the engine BELIEVES. This is the only one
 * that checks the belief. It exists because a live position's PnL is produced by the
 * same valuation model that values simulated ones — `closeLivePosition` returns
 * signatures and never amounts, so the chain is asked to close a position and never
 * asked what came back — and that model cannot see the balancing swap's slippage, the
 * priority fees, or bin-array rent that is never recovered. All three push the same way,
 * so the drift is systematic and one-directional, and nothing measured it.
 *
 * Two rules here are load-bearing and both are about refusing to claim:
 *
 *  - UNMEASURED rows are named, not hidden. Summing only the positions that carry both
 *    balance reads and presenting that as agreement is the same failure as an unlabelled
 *    rebased equity curve. If nothing is measured the panel says so instead of rendering
 *    a confident 0.00%.
 *  - OVERLAPPING windows are flagged. The balance either side of one trade belongs to
 *    the whole wallet, so with more than one position open at a time the per-trade
 *    figures stop meaning what their name says and only the total survives.
 *
 * Rendered only when there is something to report — on a paper engine there are no live
 * positions and this is correctly absent rather than an empty card.
 */
export default function Reconciliation() {
  /*
   * Polled, not fetched once. This panel renders nothing until a live position has
   * closed, so a one-shot read on mount meant the check stayed ABSENT through the very
   * first live close on any dashboard already open — the one moment it exists for.
   *
   * Kept out of the page's `Promise.all` for the original reason: an older engine has no
   * /api/reconciliation and a 404 there would take the whole refresh down. `failed`
   * means the route has never answered, so a single dropped poll leaves the last good
   * reading up instead of hiding the panel.
   */
  const { data: report, failed } = usePolled(
    useCallback((signal: AbortSignal) => fetchReconciliation(signal), []),
  );

  if (failed || !report) return null;
  // Nothing has closed on-chain yet. An empty card claiming "$0.00 drift" would assert a
  // check that never ran.
  if (report.measured === 0 && report.unmeasured === 0) return null;

  const drifted = report.measured > 0;

  /*
   * The direction is taken from the ROUNDED figure, for the same reason `splitAmount`
   * signs off the rounded magnitude: this panel prints the drift to the cent, and a
   * drift below half a cent renders "$0.00". Testing the raw value made `driftUsd === 0`
   * — the book and the chain agreeing exactly — fall into the "did BETTER than the book"
   * branch, which tells the operator to go and explain a deposit or a manual trade that
   * never happened. An exact match is now its own sentence, and only a genuine positive
   * drift raises the question.
   */
  const driftCents = Math.round(report.driftUsd * 100);
  const direction: "book-optimistic" | "exact" | "wallet-ahead" =
    driftCents < 0 ? "book-optimistic" : driftCents > 0 ? "wallet-ahead" : "exact";

  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900/40">
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight text-zinc-200">
          <Scale className="h-4 w-4 text-zinc-500" />
          Wallet Reconciliation
          <span className="font-normal text-zinc-600">— book vs chain</span>
        </h2>
        <span className="font-mono text-[10px] text-zinc-600">
          {report.measured} measured
          {report.unmeasured > 0 && ` · ${report.unmeasured} unmeasured`}
        </span>
      </div>

      {!drifted ? (
        <p className="px-4 py-6 text-[11px] leading-relaxed text-zinc-500">
          {report.unmeasured} closed live position
          {report.unmeasured === 1 ? "" : "s"}, none measurable — the wallet balance was
          not read at open or at close, so the book cannot be checked against the chain.
          Positions opened from here on carry both readings.
        </p>
      ) : (
        <div className="space-y-3 px-4 py-4">
          <div className="grid grid-cols-3 gap-3">
            <Figure label="Engine book" value={formatSignedUsd(report.modelPnlUsd)} tone="neutral" />
            <Figure label="Wallet actually" value={formatSignedUsd(report.chainPnlUsd)} tone="neutral" />
            <Figure
              label="Drift"
              value={formatSignedUsd(report.driftUsd)}
              tone={
                direction === "book-optimistic"
                  ? "down"
                  : direction === "wallet-ahead"
                    ? "up"
                    : "neutral"
              }
            />
          </div>

          <p className="text-[11px] leading-relaxed text-zinc-500">
            {direction === "book-optimistic" ? (
              <>
                The wallet did{" "}
                <span className="text-rose-400">
                  {formatSignedUsd(Math.abs(report.driftUsd) * -1)}
                </span>{" "}
                worse than the book
                {report.driftPctOfModel !== null && (
                  <> ({Math.abs(report.driftPctOfModel).toFixed(1)}% of the booked PnL)</>
                )}
                . That is the expected direction: swap slippage, priority fees and
                unrecoverable bin-array rent are all real and none are in the book.
              </>
            ) : direction === "exact" ? (
              <>
                The book and the wallet agree to the cent over{" "}
                <span className="font-mono text-zinc-400">{report.measured}</span> measured
                position{report.measured === 1 ? "" : "s"}. Worth a second look rather than
                a tick: swap slippage, priority fees and bin-array rent are all real costs
                the book cannot see, so exact agreement usually means the trades were too
                small to move the balance by a cent — not that nothing was spent.
              </>
            ) : (
              <>
                The wallet did better than the book. Every unmodelled cost points the
                other way, so this is worth explaining before it is trusted — a deposit,
                a manual trade, or another position moving SOL inside the same window.
              </>
            )}
          </p>

          {report.anyOverlap && (
            <p className="rounded border border-amber-900/40 bg-amber-950/20 px-2 py-1.5 text-[10px] leading-relaxed text-amber-500/80">
              Positions overlapped in time, so the balance either side of a trade belongs
              to the wallet rather than to that trade. Read the total; ignore the
              per-position split.
            </p>
          )}

          {report.unmeasured > 0 && (
            <p className="text-[10px] text-zinc-600">
              {report.unmeasured} closed position
              {report.unmeasured === 1 ? " is" : "s are"} excluded from both figures for
              want of a balance reading — counting them on one side only would invent
              drift out of a missing measurement.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function Figure({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "up" | "down" | "neutral";
}) {
  const colour =
    tone === "up" ? "text-emerald-400" : tone === "down" ? "text-rose-400" : "text-zinc-200";
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-zinc-600">{label}</div>
      <div className={`font-mono text-lg tabular-nums ${colour}`}>{value}</div>
    </div>
  );
}
