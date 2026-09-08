"use client";

import { useEffect, useState } from "react";
import { Filter } from "lucide-react";
import { fetchFunnel, type FunnelCycle } from "@/lib/api";

/**
 * Why the engine did not trade.
 *
 * Every other panel on this page answers "what happened to the positions". On a
 * strategy whose gates reject ~99% of cycles, the more common question is the one
 * nothing answered: what stopped it this time. Auditing the 67h dry run had to
 * reconstruct exactly this by parsing PM2 stdout and counting stderr lines backwards
 * — the funnel table exists so that is never necessary again, and this panel is what
 * makes it visible without SSH.
 *
 * The bars are stage SURVIVORS, not rejections, because the funnel is only legible as
 * a narrowing: 600 scanned -> ~20 candidates -> 3 shortlisted -> 0 opened. Plotting
 * rejections would put the largest bar on the least interesting stage.
 */
export default function ScanFunnel() {
  const [cycles, setCycles] = useState<FunnelCycle[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetchFunnel(48, controller.signal)
      .then(setCycles)
      .catch(() => {
        // An older engine has no /api/funnel. That is a missing panel, not an error
        // worth colouring the page red for — the poll loop owns connection reporting.
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, []);

  if (failed) return null;

  const latest = cycles?.[0] ?? null;

  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900/40">
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight text-zinc-200">
          <Filter className="h-4 w-4 text-zinc-500" />
          Entry Funnel
          <span className="font-normal text-zinc-600">— why nothing opened</span>
        </h2>
        {latest && (
          <span className="font-mono text-[10px] text-zinc-600">
            last cycle {latest.durationMs}ms
          </span>
        )}
      </div>

      {!cycles ? (
        <div className="space-y-2 px-4 py-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-6 animate-pulse rounded bg-zinc-800/60" />
          ))}
        </div>
      ) : cycles.length === 0 ? (
        <p className="px-4 py-8 text-center text-[11px] text-zinc-600">
          No screener cycle recorded yet. The screener runs every 30 minutes, or trigger one
          with <span className="mx-1 font-mono text-zinc-500">npm run dlmm:once</span>.
        </p>
      ) : (
        <>
          {latest && <Stages cycle={latest} />}
          <Sparkline cycles={cycles} />
        </>
      )}
    </section>
  );
}

function Stages({ cycle }: { cycle: FunnelCycle }) {
  /*
   * Survivors at each gate, IN THE ORDER THE GATES RUN. `scanned` may be null (the
   * cycle never reached the screener), and the widths are relative to it — so with no
   * scan there is nothing to be relative TO, and the bars are suppressed rather than
   * drawn against a made-up denominator.
   *
   * Two stages were missing entirely and one was mislabelled, which between them made
   * the panel unreadable exactly when it mattered. `candidates` is the survivor count
   * AFTER the cooldown and execution gates, but it was drawn second and labelled
   * "Passed screen" — so a cycle that screened 30 pools and lost 26 to the operator's
   * width cap showed "Passed screen 4", with the gate responsible rendered nowhere.
   * The two gates now have their own rows and `candidates` sits where it belongs.
   */
  const scanned = cycle.scanned;
  const screened = cycle.screenerCandidates;
  const shortlisted = cycle.antirugPassed - cycle.volatilityRejected;
  const affordable = Math.max(shortlisted - cycle.coverageRejected - cycle.microRejected, 0);

  const stages: Array<{ label: string; value: number; lost: number | null; tone: string }> = [
    { label: "Scanned", value: scanned ?? 0, lost: null, tone: "bg-zinc-600" },
    // Null on a row written before the column existed. Falling back to `candidates`
    // would silently restate the old, wrong narrative rather than admit the gap.
    {
      label: "Passed screen",
      value: screened ?? 0,
      lost: null,
      tone: "bg-sky-500/70",
    },
    {
      label: "Not already held",
      value: Math.max((screened ?? 0) - cycle.heldExcluded, 0),
      lost: cycle.heldExcluded,
      tone: "bg-cyan-500/70",
    },
    {
      label: "Off cooldown",
      value: Math.max((screened ?? 0) - cycle.heldExcluded - cycle.cooldownRejected, 0),
      lost: cycle.cooldownRejected,
      tone: "bg-teal-500/70",
    },
    {
      label: "Executable",
      value: cycle.candidates,
      lost: cycle.executionRejected,
      tone: "bg-emerald-600/70",
    },
    {
      label: "Survived anti-rug",
      value: cycle.antirugPassed,
      lost: cycle.antirugRejected,
      tone: "bg-indigo-500/70",
    },
    {
      label: "Survived volatility",
      value: Math.max(shortlisted, 0),
      lost: cycle.volatilityRejected,
      tone: "bg-violet-500/70",
    },
    {
      label: "Cleared friction",
      value: affordable,
      lost: cycle.coverageRejected + cycle.microRejected,
      tone: "bg-amber-500/70",
    },
    {
      label: "Opened",
      value: cycle.opened ? 1 : 0,
      lost: null,
      tone: cycle.opened ? "bg-emerald-500" : "bg-zinc-700",
    },
  ];

  // Log scale: 600 -> 20 -> 3 on a linear axis renders every stage after the first as
  // an invisible sliver, which hides the part of the funnel that actually decides.
  const denom = Math.log10((scanned ?? screened ?? cycle.candidates) + 1) || 1;
  const width = (v: number) => `${Math.max((Math.log10(v + 1) / denom) * 100, v > 0 ? 3 : 0)}%`;

  return (
    <div className="space-y-2 px-4 py-3">
      {stages.map((s) => (
        <div key={s.label} className="flex items-center gap-3">
          <span className="w-32 shrink-0 text-[11px] text-zinc-500">{s.label}</span>
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-zinc-800/70">
            <div className={`h-full rounded-full ${s.tone}`} style={{ width: width(s.value) }} />
          </div>
          <span className="w-10 shrink-0 text-right font-mono text-[11px] tabular-nums text-zinc-300">
            {s.label === "Scanned" && scanned === null ? "n/a" : s.value}
          </span>
          <span className="w-12 shrink-0 text-right font-mono text-[10px] tabular-nums text-rose-400/60">
            {s.lost ? `-${s.lost}` : ""}
          </span>
        </div>
      ))}

      {cycle.skipReason && !cycle.opened && (
        <p className="pt-1 text-[11px] leading-relaxed text-zinc-500">
          <span className="text-zinc-600">stopped: </span>
          {cycle.skipReason}
        </p>
      )}

      <ExecutionBlocks cycle={cycle} />
      <ScreenBuckets rejections={cycle.screenRejections} />
    </div>
  );
}

/**
 * Which execution gate refused pools, and how many each took.
 *
 * The three are one column in the log and were one bar here, which hid the distinction
 * that decides what an operator should DO. A denylist entry and a benched pool are
 * facts about a pool; `LIVE_MAX_POSITION_BINS` is a setting, and while the engine is
 * capped to narrow positions it refuses most of the universe by design. Shown apart, a
 * cycle losing 26 of 30 pools reads as a configured cap rather than a broken screener —
 * and the bin-cap number is precisely what says whether re-arming the wide path is
 * worth it.
 */
function ExecutionBlocks({ cycle }: { cycle: FunnelCycle }) {
  if (cycle.executionRejected === 0) return null;

  const parts: Array<{ label: string; n: number; tone: string }> = [
    { label: "over bin cap", n: cycle.execBinCapRejected, tone: "text-amber-400/80" },
    { label: "breaker", n: cycle.execBreakerRejected, tone: "text-rose-400/80" },
    { label: "denylist", n: cycle.execDenylistRejected, tone: "text-rose-400/80" },
  ].filter((p) => p.n > 0);

  if (parts.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5 pt-1">
      <span className="text-[10px] text-zinc-600">execution gates:</span>
      {parts.map((p) => (
        <span
          key={p.label}
          className="rounded border border-zinc-800 bg-zinc-900 px-1.5 py-0.5 font-mono text-[10px] text-zinc-500"
        >
          {p.label} <span className={p.tone}>{p.n}</span>
        </span>
      ))}
    </div>
  );
}

/**
 * The quantitative screener's own rejection reasons — the 600 -> ~20 step.
 *
 * This is the part that was previously invisible: `screenPools` computed these buckets
 * and the agent discarded them, so the biggest narrowing in the funnel had no
 * explanation anywhere.
 */
function ScreenBuckets({ rejections }: { rejections: Record<string, number> }) {
  const entries = Object.entries(rejections)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);

  if (entries.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5 pt-1">
      {entries.map(([key, n]) => (
        <span
          key={key}
          className="rounded border border-zinc-800 bg-zinc-900 px-1.5 py-0.5 font-mono text-[10px] text-zinc-500"
        >
          {key} <span className="text-zinc-400">{n}</span>
        </span>
      ))}
    </div>
  );
}

/** One mark per recent cycle: green opened, amber reached the model, grey stopped earlier. */
function Sparkline({ cycles }: { cycles: FunnelCycle[] }) {
  // Oldest first, so the strip reads left-to-right like every other time axis here.
  const ordered = [...cycles].reverse();
  const opened = ordered.filter((c) => c.opened).length;

  return (
    <div className="border-t border-zinc-800 px-4 py-3">
      <div className="mb-1.5 flex items-center justify-between text-[10px] text-zinc-600">
        <span>last {ordered.length} cycles</span>
        <span>
          <span className="text-emerald-400">{opened}</span> opened
        </span>
      </div>
      <div className="flex gap-[3px]">
        {ordered.map((c) => (
          <div
            key={c.id}
            title={`${c.cycleAt} — ${c.opened ? "opened" : (c.skipReason ?? "no entry")}`}
            className={`h-6 flex-1 rounded-sm ${
              c.opened
                ? "bg-emerald-500"
                : c.reachedDecision
                  ? "bg-amber-500/50"
                  : "bg-zinc-800"
            }`}
          />
        ))}
      </div>
    </div>
  );
}
