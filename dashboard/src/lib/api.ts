/** Typed client for the FlowMetrix REST API. */

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api";

/**
 * Which slice of trading history a payload was computed over.
 *
 * 'current' is the v1.1 engine — the anti-churn gates plus the 60s exit monitor.
 * 'all' is every simulated trade ever, both engine versions.
 */
export type CohortId = "current" | "all";

export interface CohortMeta {
  id: CohortId;
  label: string;
  description: string;
  /** ISO cutoff, or null for the unfiltered archive. */
  cutoff: string | null;
  /**
   * True when the figures cover a subset. Balance and equity are then REBASED on
   * startingBalanceUSD: they answer "what would this engine have done starting
   * fresh", not "what is in the account". The UI must label that.
   */
  filtered: boolean;
}

export interface Overview {
  cohort: CohortMeta;
  /** Closed trades the cohort filter removed. 0 when unfiltered. */
  excludedTrades: number;
  /** Realised PnL of those excluded trades. */
  excludedRealizedPnLUSD: number;
  currentBalanceUSD: number;
  currentEquityUSD: number;
  liveFloatingPnLUSD: number;
  liveFloatingPnLPct: number;
  todayRealizedPnLUSD: number;
  todayClosedTrades: number;
  totalSimulatedTrades: number;
  winRatePct: number;
  totalWins: number;
  totalLosses: number;
  unclaimedFeesUSD: number;
  activePositionsCount: number;
  startingBalanceUSD: number;
  maxDrawdownPct: number;
  maxDrawdownUSD: number;
  currentDrawdownPct: number;
  drawdownPeakUSD: number;
  drawdownTroughUSD: number;
  /** null when undefined: no closed trades, or no losing trades yet. */
  profitFactor: number | null;
  grossProfitUSD: number;
  grossLossUSD: number;
  serverStatus: "ONLINE";
  isDryRun: boolean;
  serverTime: string;
  timezone: string;
}

export interface Position {
  positionId: string;
  poolAddress: string;
  pairName: string;
  strategyType: "SPOT" | "BID_ASK" | "CURVE";
  status: string;
  entryPrice: number;
  currentPrice: number;
  exitPrice: number | null;
  lowerBinPrice: number;
  upperBinPrice: number;
  virtualSolAmount: number;
  entrySolPriceUsd: number | null;
  notionalUsd: number;
  entryTvl: number | null;
  entry24hVolume: number | null;
  unclaimedFeeUsd: number;
  /** LP value vs capital deployed — the account-moving figure. */
  positionValueChangeUsd: number;
  /** Divergence vs holding. Diagnostic only, never part of PnL. */
  divergenceVsHoldUsd: number;
  floatingPnlUsd: number;
  realizedPnlUsd: number;
  realizedPnlPct: number;
  confidenceScore: number;
  thesis: string;
  closeReason: string;
  postMortem: string | null;
  postMortemAt: string | null;
  safety: {
    verdict: string | null;
    top10HolderPct: number | null;
    /** null means the check never ran — distinct from false, which means still live. */
    mintAuthorityRevoked: boolean | null;
    freezeAuthorityRevoked: boolean | null;
  };
  estGasCostUsd: number | null;
  estPriorityMicroLamports: number | null;
  breakevenCoverageRatio: number | null;
  expectedFee24hUsd: number | null;
  openedAt: string;
  closedAt: string | null;
  lastCheckedAt: string | null;
  inRange: boolean;
}

export interface CalendarDay {
  date: string;
  day: number;
  trades: number;
  wins: number;
  losses: number;
  netPnlUsd: number;
}

export interface PnlCalendar {
  month: string;
  daysInMonth: number;
  firstWeekday: number;
  days: CalendarDay[];
  monthNetPnlUsd: number;
  monthTrades: number;
  monthWinRatePct: number;
}

export interface ResearchReport {
  reportDate: string;
  markdown: string;
  bias: string | null;
  createdAt: string;
}

export class ApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiError";
  }
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, { cache: "no-store", signal });
  if (!res.ok) throw new ApiError(`${res.status} ${res.statusText} on ${path}`);
  return (await res.json()) as T;
}

/*
 * Every trade-facing fetch takes the cohort explicitly. The API defaults to the
 * all-time archive when the parameter is absent, so passing it is what keeps the
 * dashboard's default ("Current Run") from silently becoming the archive.
 */
export const fetchOverview = (cohort: CohortId, signal?: AbortSignal) =>
  get<Overview>(`/overview?cohort=${cohort}`, signal);

export const fetchActivePositions = (cohort: CohortId, signal?: AbortSignal) =>
  get<{ positions: Position[] }>(`/positions/active?cohort=${cohort}`, signal).then(
    (r) => r.positions,
  );

export const fetchPositionHistory = (cohort: CohortId, limit = 100, signal?: AbortSignal) =>
  get<{ positions: Position[] }>(
    `/positions/history?limit=${limit}&cohort=${cohort}`,
    signal,
  ).then((r) => r.positions);

export const fetchPnlCalendar = (cohort: CohortId, month?: string, signal?: AbortSignal) =>
  get<PnlCalendar>(
    `/pnl-calendar?cohort=${cohort}${month ? `&month=${month}` : ""}`,
    signal,
  );

export const fetchLatestResearch = (signal?: AbortSignal) =>
  get<{ report: ResearchReport | null }>("/research/latest", signal).then((r) => r.report);

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

/**
 * Rounds first, then derives the sign from the rounded magnitude. Signing off the
 * raw value renders a -0.0004 impermanent loss as "-$0.00", which reads as a
 * negative amount that is actually zero.
 */
function splitAmount(value: number, digits: number): { sign: -1 | 0 | 1; abs: string } {
  const factor = 10 ** digits;
  const rounded = Math.round(value * factor) / factor;
  const sign = rounded > 0 ? 1 : rounded < 0 ? -1 : 0;
  return {
    sign,
    abs: Math.abs(rounded).toLocaleString("en-US", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }),
  };
}

export function formatUsd(value: number, digits = 2): string {
  const { sign, abs } = splitAmount(value, digits);
  return `${sign < 0 ? "-" : ""}$${abs}`;
}

export function formatSignedUsd(value: number, digits = 2): string {
  const { sign, abs } = splitAmount(value, digits);
  return `${sign > 0 ? "+" : sign < 0 ? "-" : ""}$${abs}`;
}

export function formatPct(value: number, digits = 2): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(digits)}%`;
}

export function formatCompactUsd(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(value / 1e3).toFixed(1)}K`;
  return formatUsd(value);
}

/** Prices span many orders of magnitude across pairs, so scale the precision. */
export function formatPrice(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value === 0) return "0";
  const abs = Math.abs(value);
  if (abs >= 1000) return value.toFixed(2);
  if (abs >= 1) return value.toFixed(4);
  if (abs >= 0.001) return value.toFixed(6);
  return value.toExponential(3);
}

/** SQLite stores UTC timestamps without a zone marker; make that explicit. */
export function parseSqliteDate(value: string): Date {
  return new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
}

export function formatDateTime(value: string | null): string {
  if (!value) return "—";
  return parseSqliteDate(value).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatDuration(from: string, to: string | null): string {
  const start = parseSqliteDate(from).getTime();
  const end = to ? parseSqliteDate(to).getTime() : Date.now();
  const hours = (end - start) / 36e5;
  if (!Number.isFinite(hours) || hours < 0) return "—";
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 24) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}
