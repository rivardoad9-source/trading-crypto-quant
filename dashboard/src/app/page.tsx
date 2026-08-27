"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, FileText } from "lucide-react";
import StatusHeader from "@/components/StatusHeader";
import KpiCards from "@/components/KpiCards";
import TradeHistory from "@/components/TradeHistory";
import PnlCalendar from "@/components/PnlCalendar";
import {
  fetchActivePositions,
  fetchLatestResearch,
  fetchOverview,
  fetchPnlCalendar,
  fetchPositionHistory,
  type Overview,
  type PnlCalendar as PnlCalendarData,
  type Position,
  type ResearchReport,
} from "@/lib/api";

const POLL_INTERVAL_MS = 10_000;

function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

export default function CommandCenter() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [active, setActive] = useState<Position[]>([]);
  const [history, setHistory] = useState<Position[]>([]);
  const [calendar, setCalendar] = useState<PnlCalendarData | null>(null);
  const [research, setResearch] = useState<ResearchReport | null>(null);

  const [month, setMonth] = useState<string>(currentMonth);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  /**
   * Mirrors `month` for the poll loop without making it a dependency — otherwise every
   * month change would tear down and restart the interval. Written inside an effect
   * rather than during render.
   */
  const monthRef = useRef(month);
  useEffect(() => {
    monthRef.current = month;
  }, [month]);

  const refresh = useCallback(async (signal: AbortSignal) => {
    try {
      const [ov, act, hist, cal, res] = await Promise.all([
        fetchOverview(signal),
        fetchActivePositions(signal),
        fetchPositionHistory(100, signal),
        fetchPnlCalendar(monthRef.current, signal),
        fetchLatestResearch(signal),
      ]);

      setOverview(ov);
      setActive(act);
      setHistory(hist);
      setCalendar(cal);
      setResearch(res);
      setConnected(true);
      setError(null);
      setLastUpdated(new Date());
    } catch (err) {
      if (signal.aborted || (err as Error).name === "AbortError") return;
      setConnected(false);
      setError(
        err instanceof Error
          ? `${err.message} — is the engine running on port 4000?`
          : "Unknown error",
      );
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);

    const id = setInterval(() => {
      // Skip polling while the tab is hidden; it resumes on focus.
      if (document.visibilityState === "visible") void refresh(controller.signal);
    }, POLL_INTERVAL_MS);

    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh(controller.signal);
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      controller.abort();
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  // Refetch just the calendar when the user pages to another month.
  useEffect(() => {
    const controller = new AbortController();
    fetchPnlCalendar(month, controller.signal)
      .then(setCalendar)
      .catch(() => {
        /* the poll loop surfaces connection errors */
      });
    return () => controller.abort();
  }, [month]);

  return (
    <div className="grid-backdrop min-h-screen">
      <StatusHeader overview={overview} connected={connected} lastUpdated={lastUpdated} />

      <main className="mx-auto max-w-[1600px] space-y-5 px-6 py-6">
        {error && (
          <div className="flex items-start gap-2.5 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
            <div className="text-xs">
              <p className="font-medium text-rose-300">Cannot reach the FlowMetrix API</p>
              <p className="mt-0.5 text-rose-400/70">{error}</p>
              <p className="mt-1 font-mono text-[11px] text-rose-400/50">
                npm run api &nbsp;·&nbsp; or &nbsp;npm run dev
              </p>
            </div>
          </div>
        )}

        <KpiCards overview={overview} />

        <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1fr_400px]">
          <TradeHistory active={active} history={history} loading={loading} />

          <div className="space-y-5">
            <PnlCalendar data={calendar} month={month} onMonthChange={setMonth} />
            <ResearchPanel report={research} />
          </div>
        </div>

        <footer className="pt-2 text-center text-[10px] text-zinc-700">
          FlowMetrix paper-trading simulation · zero capital deployed · not financial advice
        </footer>
      </main>
    </div>
  );
}

function ResearchPanel({ report }: { report: ResearchReport | null }) {
  const biasTone =
    report?.bias === "RISK-ON"
      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
      : report?.bias === "RISK-OFF"
        ? "border-rose-500/30 bg-rose-500/10 text-rose-300"
        : "border-zinc-700 bg-zinc-800/50 text-zinc-300";

  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900/40">
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight text-zinc-200">
          <FileText className="h-4 w-4 text-zinc-500" />
          Daily Macro Brief
        </h2>
        {report?.bias && (
          <span className={`rounded border px-2 py-0.5 text-[10px] font-medium ${biasTone}`}>
            {report.bias}
          </span>
        )}
      </div>

      <div className="max-h-[420px] overflow-y-auto px-4 py-3">
        {report ? (
          <>
            <p className="mb-2 font-mono text-[10px] text-zinc-600">{report.reportDate}</p>
            <div className="space-y-1.5 whitespace-pre-wrap text-[11px] leading-relaxed text-zinc-400">
              {report.markdown}
            </div>
          </>
        ) : (
          <p className="py-8 text-center text-[11px] text-zinc-600">
            No research report yet. The macro agent runs daily at 07:00 WIB, or trigger it with
            <span className="mx-1 font-mono text-zinc-500">npm run research:once</span>.
          </p>
        )}
      </div>
    </section>
  );
}
