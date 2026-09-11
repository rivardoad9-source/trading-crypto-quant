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

/** Live on-chain wallet reading. `null` figures mean UNKNOWN, never zero. */
export interface WalletSnapshot {
  status: "ok" | "unavailable" | "unconfigured";
  /** Whether the live micro-capital profile is armed. Reported, not a gate. */
  armed: boolean;
  /** LIVE_MIN_WALLET_SOL, the startup floor. */
  floorSol: number;
  address: string | null;
  label: string;
  /** SOL held. null when the balance could not be read — do not render as 0. */
  sol: number | null;
  lamports: number | null;
  usd: number | null;
  solPriceUsd: number | null;
  /** RPC host only; the full URL can embed an API key and never leaves the server. */
  endpoint: string;
  checkedAt: string;
  detail: string | null;
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
  /**
   * The macro-news window currently holding NEW entries back, or null.
   *
   * Null in paper mode always, because the gate is inert there — anything rendering
   * this must not present its absence as "no release is scheduled". Open positions are
   * monitored and closed through a blackout exactly as at any other time.
   */
  newsBlackout: { event: string; untilWib: string } | null;
  /**
   * Why new entries are held, by SOURCE. Never collapse these into one boolean: only
   * the Telegram hold is cleared by /resume, so a reader shown a single "paused" has
   * no way to know which lever lifts it. `pausedByFile` is always false in paper mode.
   */
  control: {
    pausedByTelegram: boolean;
    pausedByFile: boolean;
    fileReason: string | null;
  };
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

/**
 * The LIVE on-chain wallet. A different quantity from `Overview.currentBalanceUSD`,
 * which is a simulation baseline plus paper PnL — never render the two as the same
 * thing.
 *
 * `refresh` forces a genuine chain read and is for the manual refresh button only; the
 * poll loop must use the cached path or every open tab probes the RPC on its own clock.
 */
export const fetchWallet = (refresh = false, signal?: AbortSignal) =>
  get<WalletSnapshot>(`/wallet${refresh ? "?refresh=1" : ""}`, signal);

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

/**
 * One screener cycle's entry funnel, from `GET /api/funnel`.
 *
 * `scanned` is null — never 0 — when the cycle never reached the screener (engine
 * paused, or already at capacity). "Not measured" and "measured zero" are different
 * facts, and the UI renders them differently.
 */
export interface FunnelCycle {
  id: number;
  cycleAt: string;
  scanned: number | null;
  screenRejections: Record<string, number>;
  /**
   * Survivors of the quantitative screen alone — the FIRST stage of the local funnel.
   * Null on a cycle recorded before this field existed, which the UI renders as
   * unknown rather than as zero.
   */
  screenerCandidates: number | null;
  /** Screener survivors dropped for already holding a position on that pool. */
  heldExcluded: number;
  /**
   * Survivors of EVERY local filter — the LAST stage, not the first.
   *
   * The panel used to label this "Passed screen" and draw it directly under `scanned`,
   * with no cooldown or exec-guard rows at all. So a cycle that screened 30 pools and
   * had 26 refused by the width cap rendered as "Passed screen 4" with the gate that
   * did the refusing nowhere on the page.
   */
  candidates: number;
  cooldownRejected: number;
  /** Total refused by the execution gates, broken out by gate below. */
  executionRejected: number;
  execDenylistRejected: number;
  execBreakerRejected: number;
  /**
   * Refused by the operator's own `LIVE_MAX_POSITION_BINS`.
   *
   * Its own number because it is the only one of the three that is a setting rather
   * than a fact about a pool, and it is what says whether the narrow-only cap is
   * costing the engine its universe.
   */
  execBinCapRejected: number;
  /**
   * Refused because a SIBLING pool of the same token is benched, not this pool.
   *
   * Separate from `execBreakerRejected` because they lead to different actions: that
   * one says this pool failed, this one says a pool with a clean record of its own is
   * being held out because another pool of the same token failed. Added 10 Sep 2026,
   * when a benched pool's sibling was found to sail straight past the breaker.
   */
  execTokenBenchRejected: number;
  antirugPassed: number;
  antirugRejected: number;
  volatilityRejected: number;
  coverageRejected: number;
  microRejected: number;
  reachedDecision: boolean;
  opened: boolean;
  skipReason: string | null;
  positionsChecked: number;
  positionsClosed: number;
  durationMs: number;
}

export const fetchFunnel = (limit = 48, signal?: AbortSignal) =>
  get<{ cycles: FunnelCycle[] }>(`/funnel?limit=${limit}`, signal).then((r) => r.cycles);

/**
 * Wallet reconciliation, from `GET /api/reconciliation`.
 *
 * The engine's book against the chain. Every figure a live position carries comes from
 * the same valuation model that values simulated ones — the close returns signatures,
 * not amounts — and that model cannot see the balancing swap's slippage, the priority
 * fees, or bin-array rent that is never recovered. All three make the wallet poorer than
 * the book, so the drift is systematic rather than noisy.
 */
export interface ReconciliationReport {
  positions: Array<{
    positionId: string;
    pairName: string;
    closedAt: string | null;
    modelPnlUsd: number;
    chainDeltaSol: number | null;
    chainDeltaUsd: number | null;
    driftUsd: number | null;
    overlapping: boolean;
    /** Anything but "settled" carries no chain figure: its after-balance is not final. */
    settlement?: "settled" | "unsettled" | "pre-sweep";
  }>;
  /** Closed live positions carrying BOTH balance reads. Only these are in the totals. */
  measured: number;
  /** Closed live positions that could not be measured, and are excluded from the totals. */
  unmeasured: number;
  /**
   * Closed live positions whose after-balance was read before the paired token was sold
   * back to SOL. Excluded from the totals. Optional: an older engine does not send it.
   */
  unsettled?: number;
  modelPnlUsd: number;
  chainPnlUsd: number;
  /** chainPnlUsd - modelPnlUsd. Negative = the book is optimistic, the expected sign. */
  driftUsd: number;
  /** True when a measured window overlapped another, so only the total is meaningful. */
  anyOverlap: boolean;
  /** Null — never 0 — when nothing is measured. "No basis" is not "they agree". */
  driftPctOfModel: number | null;
  generatedAt: string;
}

export const fetchReconciliation = (signal?: AbortSignal) =>
  get<ReconciliationReport>(`/reconciliation`, signal);
