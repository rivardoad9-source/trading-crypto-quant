"use client";

import {
  Coins,
  Layers,
  Percent,
  Scale,
  TrendingDown,
  TrendingUp,
  Wallet,
} from "lucide-react";
import { formatPct, formatSignedUsd, formatUsd, type Overview } from "@/lib/api";

interface Props {
  overview: Overview | null;
}

const GRID = "grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6";

export default function KpiCards({ overview }: Props) {
  if (!overview) {
    return (
      <div className={GRID}>
        {Array.from({ length: 6 }, (_, i) => (
          <div
            key={i}
            className="h-[122px] animate-pulse rounded-lg border border-zinc-800 bg-zinc-900/50"
          />
        ))}
      </div>
    );
  }

  const floatingUp = overview.liveFloatingPnLUSD >= 0;
  const todayUp = overview.todayRealizedPnLUSD >= 0;
  const hasClosedTrades = overview.totalSimulatedTrades > 0;

  return (
    <div className={GRID}>
      <Card
        label="Simulated Equity"
        icon={<Wallet className="h-4 w-4" />}
        value={formatUsd(overview.currentEquityUSD)}
        footer={
          <>
            <span className="text-zinc-500">balance</span>{" "}
            <span className="font-mono text-zinc-300">{formatUsd(overview.currentBalanceUSD)}</span>
            <span className="mx-1.5 text-zinc-700">·</span>
            <span className="text-zinc-500">base</span>{" "}
            <span className="font-mono text-zinc-400">
              {formatUsd(overview.startingBalanceUSD, 0)}
            </span>
          </>
        }
      />

      <Card
        label="Floating PnL"
        icon={floatingUp ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
        value={formatSignedUsd(overview.liveFloatingPnLUSD)}
        tone={overview.liveFloatingPnLUSD === 0 ? "neutral" : floatingUp ? "up" : "down"}
        footer={
          <>
            <span className={floatingUp ? "text-emerald-400" : "text-rose-400"}>
              {formatPct(overview.liveFloatingPnLPct)}
            </span>
            <span className="mx-1.5 text-zinc-700">·</span>
            <span className="text-zinc-500">fees</span>{" "}
            <span className="font-mono text-emerald-400/80">
              {formatUsd(overview.unclaimedFeesUSD)}
            </span>
          </>
        }
      />

      <Card
        label="Today Realized"
        icon={<Coins className="h-4 w-4" />}
        value={formatSignedUsd(overview.todayRealizedPnLUSD)}
        tone={overview.todayRealizedPnLUSD === 0 ? "neutral" : todayUp ? "up" : "down"}
        footer={
          <>
            <span className="font-mono text-zinc-300">{overview.todayClosedTrades}</span>{" "}
            <span className="text-zinc-500">
              trade{overview.todayClosedTrades === 1 ? "" : "s"} closed today
            </span>
          </>
        }
      />

      <Card
        label="Win Rate"
        icon={<Percent className="h-4 w-4" />}
        value={
          overview.totalSimulatedTrades > 0 ? `${overview.winRatePct.toFixed(1)}%` : "—"
        }
        tone={
          overview.totalSimulatedTrades === 0
            ? "neutral"
            : overview.winRatePct >= 50
              ? "up"
              : "down"
        }
        footer={
          <>
            <span className="font-mono text-emerald-400">{overview.totalWins}W</span>
            <span className="mx-1 text-zinc-700">/</span>
            <span className="font-mono text-rose-400">{overview.totalLosses}L</span>
            <span className="mx-1.5 text-zinc-700">·</span>
            <span className="inline-flex items-center gap-1 text-zinc-500">
              <Layers className="h-3 w-3" />
              {overview.activePositionsCount} open
            </span>
          </>
        }
      />

      <Card
        label="Max Drawdown"
        icon={<TrendingDown className="h-4 w-4" />}
        // A drawdown of 0 with no history means "not measured", not "no risk".
        value={hasClosedTrades ? `${overview.maxDrawdownPct.toFixed(2)}%` : "—"}
        tone={!hasClosedTrades || overview.maxDrawdownPct === 0 ? "neutral" : "down"}
        footer={
          hasClosedTrades ? (
            <>
              <span className="font-mono text-rose-400/80">
                {formatUsd(overview.maxDrawdownUSD)}
              </span>
              <span className="mx-1.5 text-zinc-700">·</span>
              <span className="text-zinc-500">now</span>{" "}
              <span className="font-mono text-zinc-400">
                {overview.currentDrawdownPct.toFixed(2)}%
              </span>
            </>
          ) : (
            <span className="text-zinc-600">no closed trades yet</span>
          )
        }
      />

      <Card
        label="Profit Factor"
        icon={<Scale className="h-4 w-4" />}
        // null is an undefined ratio (no losing trades); rendering 0 or ∞ would read
        // as a measurement that was never taken.
        value={
          overview.profitFactor === null
            ? hasClosedTrades
              ? "∞"
              : "—"
            : overview.profitFactor.toFixed(2)
        }
        tone={
          overview.profitFactor === null
            ? hasClosedTrades
              ? "up"
              : "neutral"
            : overview.profitFactor >= 1
              ? "up"
              : "down"
        }
        footer={
          hasClosedTrades ? (
            <>
              <span className="font-mono text-emerald-400/80">
                {formatUsd(overview.grossProfitUSD)}
              </span>
              <span className="mx-1 text-zinc-700">/</span>
              <span className="font-mono text-rose-400/80">
                {formatUsd(overview.grossLossUSD)}
              </span>
              {overview.profitFactor === null && (
                <span className="ml-1.5 text-zinc-600">no losses yet</span>
              )}
            </>
          ) : (
            <span className="text-zinc-600">no closed trades yet</span>
          )
        }
      />
    </div>
  );
}

function Card({
  label,
  value,
  icon,
  footer,
  tone = "neutral",
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
  footer: React.ReactNode;
  tone?: "up" | "down" | "neutral";
}) {
  const valueTone =
    tone === "up" ? "text-emerald-400" : tone === "down" ? "text-rose-400" : "text-zinc-100";
  const iconTone =
    tone === "up"
      ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-400"
      : tone === "down"
        ? "border-rose-500/25 bg-rose-500/10 text-rose-400"
        : "border-zinc-800 bg-zinc-900 text-zinc-500";

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 transition-colors hover:border-zinc-700">
      <div className="flex items-start justify-between">
        <span className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
          {label}
        </span>
        <span className={`rounded-md border p-1.5 ${iconTone}`}>{icon}</span>
      </div>
      <p className={`mt-3 font-mono text-2xl font-semibold tabular-nums ${valueTone}`}>{value}</p>
      <p className="mt-2 text-[11px]">{footer}</p>
    </div>
  );
}
