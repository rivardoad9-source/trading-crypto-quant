"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, FileText } from "lucide-react";
import StatusHeader from "@/components/StatusHeader";
import PortfolioHero from "@/components/PortfolioHero";
import KpiCards from "@/components/KpiCards";
import TradeHistory from "@/components/TradeHistory";
import PnlCalendar from "@/components/PnlCalendar";
import CohortFilter from "@/components/CohortFilter";
import ScanFunnel from "@/components/ScanFunnel";
import Reconciliation from "@/components/Reconciliation";
import {
  fetchActivePositions,
  fetchLatestResearch,
  fetchOverview,
  fetchPnlCalendar,
  fetchPositionHistory,
  fetchWallet,
  type CohortId,
  type Overview,
  type PnlCalendar as PnlCalendarData,
  type Position,
  type ResearchReport,
  type WalletSnapshot,
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
  const [wallet, setWallet] = useState<WalletSnapshot | null>(null);
  const [walletRefreshing, setWalletRefreshing] = useState(false);

  /*
   * Defaults to the clean v1.1 run. The API defaults to the all-time archive, so this
   * choice has to be sent explicitly on every request rather than relied upon.
   */
  const [cohort, setCohort] = useState<CohortId>("current");

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

  /* Same reason as monthRef: changing cohort must not restart the poll interval. */
  const cohortRef = useRef(cohort);
  useEffect(() => {
    cohortRef.current = cohort;
  }, [cohort]);

  const refresh = useCallback(async (signal: AbortSignal) => {
    try {
      // Not named `active` — that is the open-positions state in this component.
      const cohortId = cohortRef.current;
      const [ov, act, hist, cal, res, wal] = await Promise.all([
        fetchOverview(cohortId, signal),
        fetchActivePositions(cohortId, signal),
        fetchPositionHistory(cohortId, 100, signal),
        fetchPnlCalendar(cohortId, monthRef.current, signal),
        fetchLatestResearch(signal),
        /*
         * Cached read (no ?refresh): the server serves a snapshot for its TTL, so N open
         * tabs polling on their own clocks still produce roughly one chain read per TTL
         * rather than N. Only the hero's refresh button forces a real one.
         */
        fetchWallet(false, signal),
      ]);

      setWallet(wal);
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

  /**
   * The hero's refresh button. Forces a genuine chain read, unlike the poll loop.
   *
   * Deliberately not wired to the whole dashboard refresh: re-pulling five trade
   * endpoints because someone wanted a current balance is work nobody asked for.
   */
  const refreshWallet = useCallback(async () => {
    setWalletRefreshing(true);
    try {
      setWallet(await fetchWallet(true));
    } catch {
      /* the poll loop owns connection-error reporting; leave the last good reading up */
    } finally {
      setWalletRefreshing(false);
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
    fetchPnlCalendar(cohort, month, controller.signal)
      .then(setCalendar)
      .catch(() => {
        /* the poll loop surfaces connection errors */
      });
    return () => controller.abort();
  }, [cohort, month]);

  /*
   * Switching cohort re-pulls everything immediately instead of waiting for the next
   * poll: leaving v1.0 numbers under a "Current Run" label for up to 10 seconds would
   * mislabel them, which matters more here than an extra request.
   */
  useEffect(() => {
    const controller = new AbortController();
    const signal = controller.signal;

    Promise.all([
      fetchOverview(cohort, signal),
      fetchActivePositions(cohort, signal),
      fetchPositionHistory(cohort, 100, signal),
    ])
      .then(([ov, act, hist]) => {
        setOverview(ov);
        setActive(act);
        setHistory(hist);
      })
      .catch(() => {
        /* the poll loop surfaces connection errors */
      });

    return () => controller.abort();
  }, [cohort]);

  return (
    <div className="grid-backdrop min-h-screen">
      <StatusHeader overview={overview} connected={connected} lastUpdated={lastUpdated} />

      <PortfolioHero
        wallet={wallet}
        overview={overview}
        onRefresh={() => void refreshWallet()}
        refreshing={walletRefreshing}
      />

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

        <CohortFilter cohort={cohort} onChange={setCohort} overview={overview} />

        <KpiCards overview={overview} />

        {/*
          `items-start` matters: grid children stretch to the tallest row by default, so
          the execution log was being pulled down to the calendar + macro brief's height
          and rendering a few hundred pixels of empty table under two open positions.
          Each column now sizes to its own content.
        */}
        <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[1fr_400px]">
          <div className="space-y-5">
            <TradeHistory active={active} history={history} loading={loading} />
            {/*
              Above the funnel: the funnel explains why nothing traded, this explains
              whether what DID trade actually made the money the rest of the page says
              it made. On a paper engine it renders nothing at all.
            */}
            <Reconciliation />
            <ScanFunnel />
          </div>

          <div className="space-y-5">
            <PnlCalendar data={calendar} month={month} onMonthChange={setMonth} />
            <ResearchPanel report={research} />
          </div>
        </div>

        {/*
          The footer states what this engine IS, and that changed the day live execution
          was armed. "zero capital deployed" printed under real positions is not a
          harmless leftover — it is the most reassuring sentence on the page, and it
          would be false exactly when being wrong costs money.
        */}
        <footer className="pt-2 text-center text-[10px] text-zinc-700">
          {overview && !overview.isDryRun ? (
            <span className="text-rose-400/70">
              FlowMetrix LIVE · real capital at risk · positions below are real on-chain
              positions · not financial advice
            </span>
          ) : (
            <>FlowMetrix paper-trading simulation · zero capital deployed · not financial advice</>
          )}
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
