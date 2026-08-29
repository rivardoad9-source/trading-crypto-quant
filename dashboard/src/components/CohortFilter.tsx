"use client";

import { Archive, Sparkles, Info } from "lucide-react";
import { formatSignedUsd, type CohortId, type Overview } from "@/lib/api";

interface Props {
  cohort: CohortId;
  onChange: (next: CohortId) => void;
  overview: Overview | null;
}

const OPTIONS: Array<{ id: CohortId; label: string; icon: React.ReactNode; hint: string }> = [
  {
    id: "current",
    label: "Current Run (v1.1)",
    icon: <Sparkles className="h-3.5 w-3.5" />,
    hint: "Only trades opened by the clean engine — anti-churn gates and the 60s exit monitor.",
  },
  {
    id: "all",
    label: "All-Time Archive",
    icon: <Archive className="h-3.5 w-3.5" />,
    hint: "Every simulated trade, including the legacy pre-cooldown run.",
  },
];

/**
 * Switches every KPI, the trade table and the PnL calendar between engine versions.
 *
 * The banner underneath is not decoration. In the filtered cohort the equity curve is
 * rebased on the starting balance, so "Simulated Equity" answers what the v1.1 engine
 * would have done from a standing start — not what the account holds. Showing a rebased
 * figure without saying so would present a hypothetical as a measurement.
 */
export default function CohortFilter({ cohort, onChange, overview }: Props) {
  const meta = overview?.cohort;
  const excluded = overview?.excludedTrades ?? 0;

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          role="tablist"
          aria-label="Engine version"
          className="inline-flex rounded-lg border border-zinc-800 bg-zinc-900/60 p-1"
        >
          {OPTIONS.map((option) => {
            const selected = option.id === cohort;
            return (
              <button
                key={option.id}
                type="button"
                role="tab"
                aria-selected={selected}
                title={option.hint}
                onClick={() => onChange(option.id)}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] font-medium transition-colors ${
                  selected
                    ? "bg-zinc-100 text-zinc-900"
                    : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200"
                }`}
              >
                {option.icon}
                {option.label}
              </button>
            );
          })}
        </div>

        {meta?.cutoff && (
          <p className="font-mono text-[10px] text-zinc-600">v1.1 cutoff · {meta.cutoff}</p>
        )}
      </div>

      {meta?.filtered && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/[0.07] px-3 py-2">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400/80" />
          <p className="text-[11px] leading-relaxed text-amber-200/70">
            <span className="font-medium text-amber-200">Rebased view.</span> Equity and
            drawdown restart from{" "}
            <span className="font-mono">
              ${overview?.startingBalanceUSD.toLocaleString("en-US")}
            </span>{" "}
            at the cutoff, so they show what this engine version did from a standing start —
            not the account balance.
            {excluded > 0 && (
              <>
                {" "}
                <span className="font-mono text-amber-200">{excluded}</span> legacy trade
                {excluded === 1 ? "" : "s"} worth{" "}
                <span className="font-mono text-amber-200">
                  {formatSignedUsd(overview?.excludedRealizedPnLUSD ?? 0)}
                </span>{" "}
                are excluded. Switch to All-Time Archive for the real total.
              </>
            )}
          </p>
        </div>
      )}
    </section>
  );
}
