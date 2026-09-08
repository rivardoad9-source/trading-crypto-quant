"use client";

import { useEffect, useMemo, useState } from "react";
import { Brain, ExternalLink, Lightbulb, ShieldCheck, X } from "lucide-react";
import {
  formatDateTime,
  formatDuration,
  formatPct,
  formatPrice,
  formatSignedUsd,
  formatUsd,
  type Position,
} from "@/lib/api";

type Tab = "active" | "history";

interface Props {
  active: Position[];
  history: Position[];
  loading: boolean;
  /**
   * Whether the engine is in dry run. `undefined` while the overview is still loading,
   * so the empty state can decline to call the positions anything until it knows.
   */
  isDryRun: boolean | undefined;
}

const STATUS_STYLES: Record<string, string> = {
  ACTIVE: "border-sky-500/30 bg-sky-500/10 text-sky-300",
  CLOSED_PROFIT: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  CLOSED_LOSS: "border-rose-500/30 bg-rose-500/10 text-rose-300",
  CLOSED_OUT_OF_RANGE: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  CLOSED_TIMEOUT: "border-zinc-600/40 bg-zinc-700/20 text-zinc-300",
};

export default function TradeHistory({ active, history, loading, isDryRun }: Props) {
  // null means "no explicit choice yet" — the tab is then derived from what data exists,
  // so the panel is never empty by default. Derived rather than synced in an effect.
  const [pinnedTab, setPinnedTab] = useState<Tab | null>(null);
  const [selected, setSelected] = useState<Position | null>(null);

  const tab: Tab = pinnedTab ?? (active.length === 0 && history.length > 0 ? "history" : "active");
  const setTab = setPinnedTab;

  const rows = tab === "active" ? active : history;

  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900/40">
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
        <h2 className="text-sm font-semibold tracking-tight text-zinc-200">Execution Log</h2>
        <div className="flex gap-1 rounded-md border border-zinc-800 bg-zinc-950 p-0.5">
          <TabButton active={tab === "active"} onClick={() => setTab("active")}>
            Open <Count n={active.length} />
          </TabButton>
          <TabButton active={tab === "history"} onClick={() => setTab("history")}>
            Closed <Count n={history.length} />
          </TabButton>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[900px] text-left text-xs">
          <thead>
            <tr className="border-b border-zinc-800 text-[10px] uppercase tracking-wider text-zinc-500">
              <Th>Pair</Th>
              <Th>Strategy</Th>
              <Th>Status</Th>
              <Th align="right">Entry</Th>
              <Th align="right">{tab === "active" ? "Mark" : "Exit"}</Th>
              <Th align="right">Range</Th>
              <Th align="right">Fees</Th>
              <Th align="right">Pos value</Th>
              <Th align="right">{tab === "active" ? "Floating" : "Realized"}</Th>
              <Th align="right">Held</Th>
              <Th align="right">Thesis</Th>
            </tr>
          </thead>
          <tbody>
            {loading && rows.length === 0 ? (
              <EmptyRow>Loading…</EmptyRow>
            ) : rows.length === 0 ? (
              <EmptyRow>
                {/*
                  Two things were wrong in one sentence. It called the positions
                  SIMULATED unconditionally — the same defect as the Telegram alert that
                  announced live positions as paper — and it put the screener at ten
                  minutes when the V1.1 cadence is thirty. The schedule is now stated
                  once, by the funnel panel that owns "why nothing opened"; restating a
                  guardrail the dashboard cannot read is how the two copies came to
                  disagree.
                */}
                {tab === "active"
                  ? isDryRun === true
                    ? "No open paper positions."
                    : "No open positions."
                  : "No closed trades yet."}
              </EmptyRow>
            ) : (
              rows.map((p) => {
                const pnl = tab === "active" ? p.floatingPnlUsd : p.realizedPnlUsd;
                const up = pnl >= 0;
                return (
                  <tr
                    key={p.positionId}
                    className="border-b border-zinc-800/60 transition-colors last:border-0 hover:bg-zinc-800/30"
                  >
                    <Td>
                      <span className="font-medium text-zinc-200">{p.pairName}</span>
                      <span className="ml-1.5 font-mono text-[10px] text-zinc-600">
                        {p.poolAddress.slice(0, 4)}…{p.poolAddress.slice(-4)}
                      </span>
                    </Td>
                    <Td>
                      <span className="rounded border border-zinc-700 bg-zinc-800/50 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400">
                        {p.strategyType}
                      </span>
                    </Td>
                    <Td>
                      <span
                        className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${
                          STATUS_STYLES[p.status] ?? STATUS_STYLES.CLOSED_TIMEOUT
                        }`}
                      >
                        {p.status.replace("CLOSED_", "")}
                      </span>
                    </Td>
                    <Td align="right" mono>
                      {formatPrice(p.entryPrice)}
                    </Td>
                    <Td align="right" mono>
                      {formatPrice(tab === "active" ? p.currentPrice : (p.exitPrice ?? p.currentPrice))}
                    </Td>
                    <Td align="right">
                      <span
                        className={`font-mono text-[10px] ${
                          tab === "active" && !p.inRange ? "text-amber-400" : "text-zinc-500"
                        }`}
                      >
                        {formatPrice(p.lowerBinPrice)} – {formatPrice(p.upperBinPrice)}
                      </span>
                    </Td>
                    <Td align="right" mono className="text-emerald-400/90">
                      {formatUsd(p.unclaimedFeeUsd)}
                    </Td>
                    <Td align="right" mono className="text-rose-400/90">
                      {formatUsd(p.positionValueChangeUsd)}
                    </Td>
                    <Td align="right">
                      <span
                        className={`font-mono font-semibold ${up ? "text-emerald-400" : "text-rose-400"}`}
                      >
                        {formatSignedUsd(pnl)}
                      </span>
                      {tab === "history" && (
                        <span
                          className={`ml-1.5 font-mono text-[10px] ${
                            up ? "text-emerald-500/70" : "text-rose-500/70"
                          }`}
                        >
                          {formatPct(p.realizedPnlPct)}
                        </span>
                      )}
                    </Td>
                    <Td align="right" mono className="text-zinc-500">
                      {formatDuration(p.openedAt, p.closedAt)}
                    </Td>
                    <Td align="right">
                      <button
                        onClick={() => setSelected(p)}
                        className="inline-flex items-center gap-1 rounded border border-zinc-700 bg-zinc-800/50 px-2 py-1 text-[10px] text-zinc-300 transition-colors hover:border-emerald-500/40 hover:text-emerald-300"
                      >
                        <Brain className="h-3 w-3" />
                        View
                      </button>
                    </Td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {selected && <ThesisModal position={selected} onClose={() => setSelected(null)} />}
    </section>
  );
}

/* ------------------------------------------------------------------ */

function ThesisModal({ position, onClose }: { position: Position; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  const pnl = position.closedAt ? position.realizedPnlUsd : position.floatingPnlUsd;

  const facts = useMemo(
    () => [
      ["Pool", `${position.poolAddress.slice(0, 8)}…${position.poolAddress.slice(-6)}`],
      ["Strategy", position.strategyType],
      ["Status", position.status],
      ["Size", `${position.virtualSolAmount} SOL (virtual)`],
      ["Notional at entry", formatUsd(position.notionalUsd)],
      ["Entry price", formatPrice(position.entryPrice)],
      [
        position.closedAt ? "Exit price" : "Mark price",
        formatPrice(position.exitPrice ?? position.currentPrice),
      ],
      [
        "Bin range",
        `${formatPrice(position.lowerBinPrice)} – ${formatPrice(position.upperBinPrice)}`,
      ],
      ["Pool TVL at entry", position.entryTvl ? formatUsd(position.entryTvl, 0) : "—"],
      [
        "Pool 24h volume at entry",
        position.entry24hVolume ? formatUsd(position.entry24hVolume, 0) : "—",
      ],
      [
        "Est. gas (round trip)",
        // null means the estimate was unavailable, which is not the same as free.
        position.estGasCostUsd === null ? "unavailable" : `$${position.estGasCostUsd.toFixed(4)}`,
      ],
      [
        "Divergence vs hold (diag.)",
        formatUsd(position.divergenceVsHoldUsd),
      ],
      [
        "Fee/cost coverage at entry",
        position.breakevenCoverageRatio === null
          ? "not recorded"
          : `${position.breakevenCoverageRatio.toFixed(2)}x`,
      ],
      [
        "Priority fee at entry",
        position.estPriorityMicroLamports === null
          ? "unavailable"
          : `${position.estPriorityMicroLamports.toFixed(0)} µlamports/CU`,
      ],
      ["Opened", formatDateTime(position.openedAt)],
      ["Closed", formatDateTime(position.closedAt)],
      ["Held", formatDuration(position.openedAt, position.closedAt)],
    ],
    [position],
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Thesis for ${position.pairName}`}
      >
        <div className="flex items-start justify-between border-b border-zinc-800 px-5 py-4">
          <div>
            <h3 className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
              <Brain className="h-4 w-4 text-emerald-400" />
              {position.pairName}
              <span className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400">
                {position.strategyType}
              </span>
            </h3>
            <p className="mt-1 text-[11px] text-zinc-500">
              DeepSeek reasoning · confidence {position.confidenceScore.toFixed(0)}/100
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          <ConfidenceBar score={position.confidenceScore} />

          <div>
            <p className="mb-1.5 text-[10px] uppercase tracking-wider text-zinc-500">Thesis</p>
            <p className="rounded-md border border-zinc-800 bg-zinc-950 p-3 text-xs leading-relaxed text-zinc-300">
              {position.thesis || "No thesis recorded."}
            </p>
          </div>

          {position.closeReason && (
            <div>
              <p className="mb-1.5 text-[10px] uppercase tracking-wider text-zinc-500">
                Close reason
              </p>
              <p className="rounded-md border border-zinc-800 bg-zinc-950 p-3 text-xs text-zinc-300">
                {position.closeReason}
              </p>
            </div>
          )}

          {position.closedAt && (
            <div>
              <p className="mb-1.5 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-zinc-500">
                <Lightbulb className="h-3 w-3" />
                Post-mortem
              </p>
              {position.postMortem ? (
                <p className="rounded-md border border-amber-500/20 bg-amber-500/[0.06] p-3 text-xs leading-relaxed text-amber-200/90">
                  {position.postMortem}
                </p>
              ) : (
                <p className="rounded-md border border-zinc-800 bg-zinc-950 p-3 text-xs text-zinc-600">
                  Not generated yet — the next cycle retries it. Requires DEEPSEEK_API_KEY.
                </p>
              )}
            </div>
          )}

          <div>
            <p className="mb-1.5 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-zinc-500">
              <ShieldCheck className="h-3 w-3" />
              Anti-rug screen at entry
            </p>
            <div className="grid grid-cols-1 gap-x-6 gap-y-1.5 rounded-md border border-zinc-800 bg-zinc-950 p-3 sm:grid-cols-2">
              <SafetyRow
                label="Verdict"
                value={position.safety.verdict ?? "not recorded"}
                tone={
                  position.safety.verdict === "PASS"
                    ? "good"
                    : position.safety.verdict === "FAIL"
                      ? "bad"
                      : "unknown"
                }
              />
              <SafetyRow
                label="Top 10 holders"
                value={
                  position.safety.top10HolderPct === null
                    ? "not checked"
                    : `${position.safety.top10HolderPct.toFixed(1)}%`
                }
                tone={
                  position.safety.top10HolderPct === null
                    ? "unknown"
                    : position.safety.top10HolderPct < 25
                      ? "good"
                      : "bad"
                }
              />
              <SafetyRow
                label="Mint authority"
                value={tristate(position.safety.mintAuthorityRevoked, "revoked", "still live")}
                tone={tristateTone(position.safety.mintAuthorityRevoked)}
              />
              <SafetyRow
                label="Freeze authority"
                value={tristate(position.safety.freezeAuthorityRevoked, "revoked", "still live")}
                tone={tristateTone(position.safety.freezeAuthorityRevoked)}
              />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <Metric label="Fees earned" value={formatUsd(position.unclaimedFeeUsd)} tone="up" />
            <Metric
              label="Position value vs capital"
              value={formatUsd(position.positionValueChangeUsd)}
              tone={position.positionValueChangeUsd >= 0 ? "up" : "down"}
            />
            <Metric
              label={position.closedAt ? "Net realized" : "Net floating"}
              value={formatSignedUsd(pnl)}
              tone={pnl >= 0 ? "up" : "down"}
            />
          </div>

          <div className="grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
            {facts.map(([label, value]) => (
              <div key={label} className="flex justify-between border-b border-zinc-800/50 py-1">
                <span className="text-[11px] text-zinc-500">{label}</span>
                <span className="font-mono text-[11px] text-zinc-300">{value}</span>
              </div>
            ))}
          </div>

          <a
            href={`https://app.meteora.ag/dlmm/${position.poolAddress}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-[11px] text-emerald-400 transition-colors hover:text-emerald-300"
          >
            Open pool on Meteora
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </div>
    </div>
  );
}

/** Renders a boolean that may be null, where null means "never checked". */
function tristate(value: boolean | null, whenTrue: string, whenFalse: string): string {
  if (value === null) return "not checked";
  return value ? whenTrue : whenFalse;
}

function tristateTone(value: boolean | null): "good" | "bad" | "unknown" {
  if (value === null) return "unknown";
  return value ? "good" : "bad";
}

function SafetyRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "good" | "bad" | "unknown";
}) {
  const toneClass =
    tone === "good" ? "text-emerald-400" : tone === "bad" ? "text-rose-400" : "text-zinc-500";
  return (
    <div className="flex justify-between gap-3">
      <span className="text-[11px] text-zinc-500">{label}</span>
      <span className={`font-mono text-[11px] ${toneClass}`}>{value}</span>
    </div>
  );
}

function ConfidenceBar({ score }: { score: number }) {
  const pct = Math.max(0, Math.min(100, score));
  const tone = pct >= 70 ? "bg-emerald-500" : pct >= 40 ? "bg-amber-500" : "bg-rose-500";
  return (
    <div>
      <div className="mb-1 flex justify-between text-[10px] uppercase tracking-wider text-zinc-500">
        <span>Model confidence</span>
        <span className="font-mono text-zinc-400">{pct.toFixed(0)}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "up" | "down";
}) {
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950 p-2.5">
      <p className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</p>
      <p
        className={`mt-1 font-mono text-sm font-semibold ${
          tone === "up" ? "text-emerald-400" : "text-rose-400"
        }`}
      >
        {value}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded px-2.5 py-1 text-[11px] font-medium transition-colors ${
        active ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"
      }`}
    >
      {children}
    </button>
  );
}

const Count = ({ n }: { n: number }) => (
  <span className="ml-1 font-mono text-[10px] text-zinc-600">{n}</span>
);

const Th = ({
  children,
  align = "left",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) => (
  <th className={`px-3 py-2 font-medium ${align === "right" ? "text-right" : "text-left"}`}>
    {children}
  </th>
);

const Td = ({
  children,
  align = "left",
  mono = false,
  className = "",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
  mono?: boolean;
  className?: string;
}) => (
  <td
    className={`px-3 py-2.5 ${align === "right" ? "text-right" : "text-left"} ${
      mono ? "font-mono tabular-nums" : ""
    } ${className}`}
  >
    {children}
  </td>
);

const EmptyRow = ({ children }: { children: React.ReactNode }) => (
  <tr>
    <td colSpan={11} className="px-3 py-12 text-center text-xs text-zinc-600">
      {children}
    </td>
  </tr>
);
