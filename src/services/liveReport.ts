/**
 * The "wait and see" live report: what the LIVE engine has actually done, measured in SOL.
 *
 * WHY. The book (`realized_pnl_usd`) is a valuation model and the wallet is the only thing
 * that pays. On 11 Sep 2026 the book showed five winning trades while the wallet sat below
 * the capital it started with, because failed opens write no position row and the model
 * cannot see slippage, fees or bin-array rent. While config is frozen to collect ~30 live
 * trades, this report is the one place that puts the wallet, the chain deltas, the cost of
 * failed attempts, where the profit came from, and token concentration side by side.
 *
 * READ-ONLY, BY CONSTRUCTION. It opens its OWN better-sqlite3 handle with `readonly: true`
 * and never imports `database/db.ts`, which opens `DATABASE_PATH` writable and migrates at
 * import. That is what makes it safe to run on the live host while the engine is writing —
 * and it is why the SQL lives here rather than in `repositories.ts`, whose every function is
 * bound to that writable handle. Precedent: `exports/export_data.cjs` reads the same way.
 * A column missing on an older database degrades that field to null; nothing is migrated.
 *
 * "Unmeasured is null, never 0" throughout: a missing balance read, an unsettled residual,
 * or a failed attempt with no measured cost is COUNTED apart, never summed as zero.
 */
import Database from "better-sqlite3";

export const LAMPORTS_PER_SOL = 1_000_000_000;
/** The live-trade count the operator agreed to collect before re-deciding TP / gate / size. */
export const EVALUATION_TRADES = 30;

/**
 * Settled = the after-balance is the trade's final effect. MUST stay equal to
 * `SETTLED_SWEEPS` in `services/reconciliation.ts`; `liveReport.test.ts` asserts it. It is
 * repeated rather than imported because importing that module opens the writable handle.
 */
export const SETTLED_SWEEPS: ReadonlySet<string> = new Set(["swept", "dust", "operator"]);

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

export interface LivePositionRow {
  id: number;
  position_id: string;
  pair_name: string;
  pool_address: string;
  status: string;
  opened_at: string | null;
  closed_at: string | null;
  realized_pnl_usd: number | null;
  unclaimed_fee_usd: number | null;
  position_value_change_usd: number | null;
  wallet_lamports_before: number | null;
  wallet_lamports_after: number | null;
  residual_sweep: string | null;
  position_address: string | null;
}

export interface AttemptRow {
  id: number;
  attempted_at: string | null;
  pool_address?: string | null;
  pair_name: string | null;
  token_mint: string | null;
  outcome: string;
  stage: string | null;
  wallet_lamports_before: number | null;
  wallet_lamports_after: number | null;
  cost_lamports: number | null;
  unwind: string | null;
  position_address: string | null;
}

export interface ExitEconomicsReadRow {
  position_id: string;
  mint: string | null;
  exit_fee_lamports: number | null;
  sweep_concession_bps: number | null;
  sweep_concession_after_sweep_bps: number | null;
}

/** One `scan_funnel_cycles` row, reduced to what the shadow and concentration sections read. */
export interface FunnelReadRow {
  cycle_at: string | null;
  shortlist_size: number | null;
  llm_pick_pool: string | null;
  llm_pick_pair: string | null;
  rule_pick_pool: string | null;
  rule_pick_pair: string | null;
  concentration_flagged: number | null;
  exec_token_concentration_rejected: number | null;
}

export interface LiveReportInput {
  positions: LivePositionRow[];
  attempts: AttemptRow[];
  exitEconomics: ExitEconomicsReadRow[];
  /**
   * Funnel rows. Absent (older callers / tests) reads as "not read". `shadowColumns` /
   * `concentrationColumns` say whether this database HAS the columns at all, so an old
   * database renders "—" instead of a table of zeros that were never measured.
   */
  funnel?: FunnelReadRow[];
  shadowColumns?: boolean;
  concentrationColumns?: boolean;
  /** Tables or columns this database does not have; their fields read as null. */
  missing: string[];
}

/** Opens the database READ-ONLY. Never creates the file. */
export function openReportDatabase(path: string): Database.Database {
  return new Database(path, { readonly: true, fileMustExist: true });
}

function columnsOf(db: Database.Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

/** `SELECT col` when present, `NULL AS col` when not — recorded in `missing`. */
function selectList(have: Set<string>, table: string, wanted: string[], missing: string[]): string {
  return wanted
    .map((c) => {
      if (have.has(c)) return c;
      missing.push(`${table}.${c}`);
      return `NULL AS ${c}`;
    })
    .join(", ");
}

export function readLiveReportInput(db: Database.Database): LiveReportInput {
  const missing: string[] = [];

  const posCols = columnsOf(db, "simulated_positions");
  let positions: LivePositionRow[] = [];
  if (posCols.size === 0) missing.push("simulated_positions");
  else if (!posCols.has("execution_mode")) missing.push("simulated_positions.execution_mode (no live rows can be identified)");
  else {
    const list = selectList(
      posCols,
      "simulated_positions",
      [
        "id", "position_id", "pair_name", "pool_address", "status", "opened_at", "closed_at",
        "realized_pnl_usd", "unclaimed_fee_usd", "position_value_change_usd",
        "wallet_lamports_before", "wallet_lamports_after", "residual_sweep", "position_address",
      ],
      missing,
    );
    // Paper rows are excluded HERE: the report is about what touched the wallet.
    positions = db
      .prepare(`SELECT ${list} FROM simulated_positions WHERE UPPER(execution_mode) = 'LIVE' ORDER BY id`)
      .all() as LivePositionRow[];
  }

  const attCols = columnsOf(db, "live_execution_attempts");
  let attempts: AttemptRow[] = [];
  if (attCols.size === 0) missing.push("live_execution_attempts");
  else {
    const list = selectList(
      attCols,
      "live_execution_attempts",
      ["id", "attempted_at", "pool_address", "pair_name", "token_mint", "outcome", "stage", "wallet_lamports_before", "wallet_lamports_after", "cost_lamports", "unwind", "position_address"],
      missing,
    );
    attempts = db.prepare(`SELECT ${list} FROM live_execution_attempts ORDER BY id`).all() as AttemptRow[];
  }

  const eeCols = columnsOf(db, "exit_economics");
  let exitEconomics: ExitEconomicsReadRow[] = [];
  if (eeCols.size === 0) missing.push("exit_economics");
  else {
    const list = selectList(
      eeCols,
      "exit_economics",
      ["position_id", "mint", "exit_fee_lamports", "sweep_concession_bps", "sweep_concession_after_sweep_bps"],
      missing,
    );
    exitEconomics = db.prepare(`SELECT ${list} FROM exit_economics`).all() as ExitEconomicsReadRow[];
  }

  const funCols = columnsOf(db, "scan_funnel_cycles");
  let funnel: FunnelReadRow[] = [];
  const shadowWanted = ["shortlist_size", "llm_pick_pool", "llm_pick_pair", "rule_pick_pool", "rule_pick_pair"];
  const concWanted = ["concentration_flagged", "exec_token_concentration_rejected"];
  const shadowColumns = funCols.size > 0 && shadowWanted.every((c) => funCols.has(c));
  const concentrationColumns = funCols.size > 0 && concWanted.every((c) => funCols.has(c));
  if (funCols.size === 0 || !funCols.has("cycle_at")) missing.push("scan_funnel_cycles");
  else {
    const list = selectList(funCols, "scan_funnel_cycles", [...shadowWanted, ...concWanted], missing);
    funnel = db.prepare(`SELECT cycle_at, ${list} FROM scan_funnel_cycles ORDER BY id`).all() as FunnelReadRow[];
  }

  return { positions, attempts, exitEconomics, funnel, shadowColumns, concentrationColumns, missing };
}

/* ------------------------------------------------------------------ */
/* Derivation (pure)                                                   */
/* ------------------------------------------------------------------ */

/** Stored timestamps are UTC without a zone marker; same rule as `parseDbTimestamp`. */
export function parseStamp(stamp: string | null | undefined): number | null {
  if (!stamp) return null;
  const parsed = Date.parse(stamp.includes("T") ? stamp : `${stamp.replace(" ", "T")}Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export interface WalletReading {
  sol: number;
  at: string;
  source: string;
}

export interface PositionLine {
  id: number;
  pair: string;
  openedAt: string | null;
  closedAt: string | null;
  status: string;
  bookPnlUsd: number | null;
  feesUsd: number | null;
  valueChangeUsd: number | null;
  /** fees / (fees + value change) x 100; null when that total is not positive or a part is unmeasured. */
  feeSharePct: number | null;
  settlement: "settled" | "unsettled" | "pre-sweep";
  /** Null unless both balance reads exist AND the residual is settled. */
  chainDeltaSol: number | null;
  exitFeeLamports: number | null;
  concessionDecisionBps: number | null;
  concessionLandingBps: number | null;
  tokenKey: string;
}

export interface AttemptSummary {
  failed: number;
  measuredCostLamports: number;
  /** Failed attempts whose cost could not be measured — counted, never summed as 0. */
  unmeasuredCost: number;
}

export interface ConcentrationLine {
  token: string;
  allTime: number;
  last24h: number;
  lastWindow: number;
}

/** Below this many decisions the report refuses to say anything about the LLM. */
export const MIN_SHADOW_DECISIONS = 20;
/** A live open is attributed to a cycle whose LLM picked its pool at most this long before. */
export const SHADOW_OPEN_MATCH_HOURS = 2;

export interface ShadowScope {
  decisions: number;
  llmDeclined: number;
  same: number;
  different: number;
  /** Cycles where the rule produced no pick (empty or unusable shortlist). */
  ruleNull: number;
  /** same / (same + different) x 100; null when the LLM never picked beside a rule pick. */
  agreementPct: number | null;
  shortlistMedian: number | null;
}

export interface ShadowOpenedLine {
  cycleAt: string;
  llmPair: string | null;
  rulePair: string | null;
  /** Whether the rule had picked the same pool; null when the rule made no pick. */
  ruleSame: boolean | null;
  match: "position" | "failed-attempt";
  positionId: number | null;
  status: string | null;
  bookPnlUsd: number | null;
  chainDeltaSol: number | null;
  /** More than one cycle picked this pool inside the match window; the latest was used. */
  ambiguous: boolean;
}

export interface ShadowSection {
  /** False when the database has no shadow columns: rendered as "—", never as zeros. */
  available: boolean;
  window: ShadowScope;
  allTime: ShadowScope;
  sampleSufficient: boolean;
  recentDifferent: Array<{ cycleAt: string; shortlistSize: number | null; llmPair: string | null; rulePair: string | null }>;
  opened: ShadowOpenedLine[];
}

export interface DailyConcentrationLine {
  day: string;
  liveOpens: number;
  distinctTokens: number;
  topToken: string | null;
  topCount: number;
  /** Null when the database has no concentration columns. */
  flagged: number | null;
  rejected: number | null;
  funnelCycles: number;
}

export interface LiveReport {
  generatedAt: string;
  windowDays: number;
  wallet: {
    latest: WalletReading | null;
    liveCapitalSol: number | null;
    baselineSol: number | null;
    vsLiveCapitalSol: number | null;
    vsBaselineSol: number | null;
  };
  positions: PositionLine[];
  openLivePositions: number;
  attempts: { allTime: AttemptSummary; window: AttemptSummary };
  net: {
    chainDeltaSol: number;
    failedCostSol: number;
    netSol: number;
    measuredPositions: number;
    unmeasuredPositions: number;
    unsettledPositions: number;
    unmeasuredAttemptCosts: number;
    /** False when not a single figure was measured: the render says so instead of printing a 0 net. */
    measuredAnything: boolean;
  };
  concentration: { lines: ConcentrationLine[]; top: { token: string; sharePct: number } | null };
  profitSource: {
    feesUsd: number;
    valueChangeUsd: number;
    tradesCounted: number;
    tradesUnsplit: number;
    valueChangeExceedsFees: boolean | null;
  };
  readiness: { closedLiveTrades: number; target: number };
  shadow: ShadowSection;
  dailyConcentration: { available: boolean; days: DailyConcentrationLine[] };
  missing: string[];
}

function summariseShadow(rows: FunnelReadRow[]): ShadowScope {
  const decided = rows.filter((r) => r.shortlist_size !== null && r.shortlist_size !== undefined);
  let llmDeclined = 0;
  let same = 0;
  let different = 0;
  let ruleNull = 0;
  for (const r of decided) {
    if (!r.rule_pick_pool) ruleNull++;
    if (!r.llm_pick_pool) {
      llmDeclined++;
      continue;
    }
    if (!r.rule_pick_pool) continue;
    if (r.llm_pick_pool === r.rule_pick_pool) same++;
    else different++;
  }
  const sizes = decided.map((r) => r.shortlist_size!).sort((a, b) => a - b);
  const mid = Math.floor(sizes.length / 2);
  const shortlistMedian =
    sizes.length === 0 ? null : sizes.length % 2 === 1 ? sizes[mid]! : (sizes[mid - 1]! + sizes[mid]!) / 2;
  return {
    decisions: decided.length,
    llmDeclined,
    same,
    different,
    ruleNull,
    agreementPct: same + different > 0 ? (same / (same + different)) * 100 : null,
    shortlistMedian,
  };
}

function settlementOf(sweep: string | null): PositionLine["settlement"] {
  if (sweep === null || sweep === undefined) return "pre-sweep";
  return SETTLED_SWEEPS.has(sweep) ? "settled" : "unsettled";
}

function summariseAttempts(rows: AttemptRow[]): AttemptSummary {
  const failed = rows.filter((a) => a.outcome === "failed");
  let measured = 0;
  let unmeasured = 0;
  for (const a of failed) {
    const c = num(a.cost_lamports);
    if (c === null) unmeasured++;
    else measured += c;
  }
  return { failed: failed.length, measuredCostLamports: measured, unmeasuredCost: unmeasured };
}

export function buildLiveReport(
  input: LiveReportInput,
  opts: { nowMs: number; windowDays: number; liveCapitalSol: number | null; baselineSol: number | null },
): LiveReport {
  const { nowMs, windowDays } = opts;
  const windowStart = nowMs - windowDays * 86_400_000;
  const dayStart = nowMs - 86_400_000;

  const econByKey = new Map<string, ExitEconomicsReadRow>();
  for (const e of input.exitEconomics) econByKey.set(String(e.position_id), e);
  const mintByPositionAddress = new Map<string, string>();
  for (const a of input.attempts) {
    if (a.position_address && a.token_mint) mintByPositionAddress.set(a.position_address, a.token_mint);
  }

  // Same scope as reconcilePositions: a LIVE row with an on-chain position address.
  const live = input.positions.filter((p) => Boolean(p.position_address));
  const tokenKeyOf = (p: LivePositionRow): string => {
    const econ = econByKey.get(p.position_id) ?? econByKey.get(String(p.id));
    return econ?.mint ?? (p.position_address ? mintByPositionAddress.get(p.position_address) : undefined) ?? p.pair_name.toUpperCase();
  };

  const closed = live.filter((p) => p.closed_at !== null && p.closed_at !== undefined);
  const positions: PositionLine[] = closed.map((p) => {
    const econ = econByKey.get(p.position_id) ?? econByKey.get(String(p.id));
    const book = num(p.realized_pnl_usd);
    const fees = num(p.unclaimed_fee_usd);
    const value = num(p.position_value_change_usd) ?? (book !== null && fees !== null ? book - fees : null);
    const total = fees !== null && value !== null ? fees + value : null;
    const settlement = settlementOf(p.residual_sweep);
    const before = num(p.wallet_lamports_before);
    const after = num(p.wallet_lamports_after);
    return {
      id: p.id,
      pair: p.pair_name,
      openedAt: p.opened_at,
      closedAt: p.closed_at,
      status: p.status,
      bookPnlUsd: book,
      feesUsd: fees,
      valueChangeUsd: value,
      feeSharePct: total !== null && total > 0 && fees !== null ? (fees / total) * 100 : null,
      settlement,
      chainDeltaSol: settlement === "settled" && before !== null && after !== null ? (after - before) / LAMPORTS_PER_SOL : null,
      exitFeeLamports: num(econ?.exit_fee_lamports),
      concessionDecisionBps: num(econ?.sweep_concession_bps),
      concessionLandingBps: num(econ?.sweep_concession_after_sweep_bps),
      tokenKey: tokenKeyOf(p),
    };
  });

  /* ---- wallet: newest measured balance anywhere ---- */
  const readings: Array<WalletReading & { ms: number }> = [];
  const push = (lamports: unknown, stamp: string | null, source: string) => {
    const l = num(lamports);
    const t = parseStamp(stamp);
    if (l === null || t === null || !stamp) return;
    readings.push({ sol: l / LAMPORTS_PER_SOL, at: stamp, source, ms: t });
  };
  for (const p of live) {
    push(p.wallet_lamports_before, p.opened_at, `posisi #${p.id} sebelum open`);
    // An after-balance is the wallet's level only once the residual settled.
    if (settlementOf(p.residual_sweep) === "settled") push(p.wallet_lamports_after, p.closed_at, `posisi #${p.id} sesudah close`);
  }
  for (const a of input.attempts) {
    push(a.wallet_lamports_after, a.attempted_at, `attempt #${a.id} sesudah (${a.outcome})`);
    push(a.wallet_lamports_before, a.attempted_at, `attempt #${a.id} sebelum (${a.outcome})`);
  }
  // Newest instant; on a tie an "after" beats a "before" of the same moment.
  readings.sort((x, y) => y.ms - x.ms || Number(y.source.includes("sesudah")) - Number(x.source.includes("sesudah")));
  const latest = readings[0] ? { sol: readings[0].sol, at: readings[0].at, source: readings[0].source } : null;

  /* ---- attempts ---- */
  const inWindow = (stamp: string | null, from: number) => {
    const t = parseStamp(stamp);
    return t !== null && t >= from && t <= nowMs;
  };
  const attemptsAll = summariseAttempts(input.attempts);
  const attemptsWindow = summariseAttempts(input.attempts.filter((a) => inWindow(a.attempted_at, windowStart)));

  /* ---- net ---- */
  const measuredPositions = positions.filter((p) => p.chainDeltaSol !== null);
  const chainDeltaSol = measuredPositions.reduce((s, p) => s + (p.chainDeltaSol ?? 0), 0);
  const failedCostSol = attemptsAll.measuredCostLamports / LAMPORTS_PER_SOL;
  const unsettled = positions.filter((p) => p.settlement !== "settled").length;

  /* ---- concentration: every live ENTRY, open or closed ---- */
  const conc = new Map<string, ConcentrationLine>();
  for (const p of live) {
    const key = tokenKeyOf(p);
    const line = conc.get(key) ?? { token: key, allTime: 0, last24h: 0, lastWindow: 0 };
    line.allTime++;
    if (inWindow(p.opened_at, dayStart)) line.last24h++;
    if (inWindow(p.opened_at, windowStart)) line.lastWindow++;
    conc.set(key, line);
  }
  const lines = [...conc.values()].sort((a, b) => b.allTime - a.allTime || a.token.localeCompare(b.token));
  const top = lines[0] && live.length > 0 ? { token: lines[0].token, sharePct: (lines[0].allTime / live.length) * 100 } : null;

  /* ---- profit source ---- */
  const split = positions.filter((p) => p.feesUsd !== null && p.valueChangeUsd !== null);
  const feesUsd = split.reduce((s, p) => s + (p.feesUsd ?? 0), 0);
  const valueChangeUsd = split.reduce((s, p) => s + (p.valueChangeUsd ?? 0), 0);

  /* ---- shadow pick: LLM vs rule ---- */
  const funnel = input.funnel ?? [];
  const shadowAvailable = input.shadowColumns === true;
  const decided = shadowAvailable
    ? funnel.filter((r) => r.shortlist_size !== null && r.shortlist_size !== undefined && parseStamp(r.cycle_at) !== null)
    : [];
  const decidedWindow = decided.filter((r) => inWindow(r.cycle_at, windowStart));
  const byTime = (a: FunnelReadRow, b: FunnelReadRow) => parseStamp(a.cycle_at)! - parseStamp(b.cycle_at)!;
  const recentDifferent = decided
    .filter((r) => r.llm_pick_pool && r.rule_pick_pool && r.llm_pick_pool !== r.rule_pick_pool)
    .sort(byTime)
    .slice(-10)
    .reverse()
    .map((r) => ({ cycleAt: r.cycle_at!, shortlistSize: r.shortlist_size, llmPair: r.llm_pick_pair, rulePair: r.rule_pick_pair }));

  /*
   * JOIN RULE (stated in the render too): a live open — a position row, or a FAILED attempt,
   * which is also an outcome of the LLM's pick — belongs to the LATEST cycle whose LLM picked
   * the same pool address at or before the open, no more than SHADOW_OPEN_MATCH_HOURS earlier.
   * More than one such cycle is marked ambiguous: the latest is used, and the flag says so.
   */
  const matchCycle = (pool: string | null | undefined, stamp: string | null) => {
    const t = parseStamp(stamp);
    if (!pool || t === null) return null;
    const candidates = decided.filter((r) => {
      const c = parseStamp(r.cycle_at)!;
      return r.llm_pick_pool === pool && c <= t && t - c <= SHADOW_OPEN_MATCH_HOURS * 3_600_000;
    });
    if (candidates.length === 0) return null;
    candidates.sort(byTime);
    return { cycle: candidates[candidates.length - 1]!, ambiguous: candidates.length > 1 };
  };
  const lineById = new Map(positions.map((p) => [p.id, p]));
  const opened: ShadowOpenedLine[] = [];
  for (const p of live) {
    const m = matchCycle(p.pool_address, p.opened_at);
    if (!m) continue;
    const line = lineById.get(p.id);
    opened.push({
      cycleAt: m.cycle.cycle_at!,
      llmPair: m.cycle.llm_pick_pair,
      rulePair: m.cycle.rule_pick_pair,
      ruleSame: m.cycle.rule_pick_pool ? m.cycle.rule_pick_pool === m.cycle.llm_pick_pool : null,
      match: "position",
      positionId: p.id,
      status: p.status,
      bookPnlUsd: line?.bookPnlUsd ?? null,
      chainDeltaSol: line?.chainDeltaSol ?? null,
      ambiguous: m.ambiguous,
    });
  }
  for (const a of input.attempts.filter((x) => x.outcome === "failed")) {
    const m = matchCycle(a.pool_address, a.attempted_at);
    if (!m) continue;
    opened.push({
      cycleAt: m.cycle.cycle_at!,
      llmPair: m.cycle.llm_pick_pair,
      rulePair: m.cycle.rule_pick_pair,
      ruleSame: m.cycle.rule_pick_pool ? m.cycle.rule_pick_pool === m.cycle.llm_pick_pool : null,
      match: "failed-attempt",
      positionId: null,
      status: `open gagal (${a.stage ?? "?"})`,
      bookPnlUsd: null,
      chainDeltaSol: num(a.cost_lamports) === null ? null : -num(a.cost_lamports)! / LAMPORTS_PER_SOL,
      ambiguous: m.ambiguous,
    });
  }
  opened.sort((x, y) => parseStamp(x.cycleAt)! - parseStamp(y.cycleAt)!);

  const allTimeShadow = summariseShadow(decided);
  const shadow: ShadowSection = {
    available: shadowAvailable,
    window: summariseShadow(decidedWindow),
    allTime: allTimeShadow,
    sampleSufficient: allTimeShadow.decisions >= MIN_SHADOW_DECISIONS,
    recentDifferent,
    opened,
  };

  /* ---- daily concentration, per UTC day over the window ---- */
  const concAvailable = input.concentrationColumns === true;
  const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const days: DailyConcentrationLine[] = [];
  const firstDay = Date.parse(`${dayKey(windowStart)}T00:00:00Z`);
  for (let d = firstDay; d <= nowMs; d += 86_400_000) {
    const key = dayKey(d);
    const tokens = new Map<string, number>();
    let liveOpens = 0;
    for (const p of live) {
      const t = parseStamp(p.opened_at);
      if (t === null || t < windowStart || t > nowMs || dayKey(t) !== key) continue;
      liveOpens++;
      const tk = tokenKeyOf(p);
      tokens.set(tk, (tokens.get(tk) ?? 0) + 1);
    }
    let flagged = 0;
    let rejected = 0;
    let funnelCycles = 0;
    for (const r of funnel) {
      const t = parseStamp(r.cycle_at);
      if (t === null || t < windowStart || t > nowMs || dayKey(t) !== key) continue;
      funnelCycles++;
      flagged += num(r.concentration_flagged) ?? 0;
      rejected += num(r.exec_token_concentration_rejected) ?? 0;
    }
    const top = [...tokens.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    days.push({
      day: key,
      liveOpens,
      distinctTokens: tokens.size,
      topToken: top?.[0] ?? null,
      topCount: top?.[1] ?? 0,
      flagged: concAvailable ? flagged : null,
      rejected: concAvailable ? rejected : null,
      funnelCycles,
    });
  }

  const liveCap = opts.liveCapitalSol;
  const base = opts.baselineSol;
  return {
    generatedAt: new Date(nowMs).toISOString(),
    windowDays,
    wallet: {
      latest,
      liveCapitalSol: liveCap,
      baselineSol: base,
      vsLiveCapitalSol: latest && liveCap !== null ? latest.sol - liveCap : null,
      vsBaselineSol: latest && base !== null ? latest.sol - base : null,
    },
    positions,
    openLivePositions: live.length - closed.length,
    attempts: { allTime: attemptsAll, window: attemptsWindow },
    net: {
      chainDeltaSol,
      failedCostSol,
      netSol: chainDeltaSol - failedCostSol,
      measuredPositions: measuredPositions.length,
      unmeasuredPositions: positions.length - measuredPositions.length - unsettled,
      unsettledPositions: unsettled,
      unmeasuredAttemptCosts: attemptsAll.unmeasuredCost,
      measuredAnything: measuredPositions.length > 0 || attemptsAll.failed - attemptsAll.unmeasuredCost > 0,
    },
    concentration: { lines, top },
    profitSource: {
      feesUsd,
      valueChangeUsd,
      tradesCounted: split.length,
      tradesUnsplit: positions.length - split.length,
      valueChangeExceedsFees: split.length === 0 ? null : valueChangeUsd > feesUsd,
    },
    readiness: { closedLiveTrades: positions.length, target: EVALUATION_TRADES },
    shadow,
    dailyConcentration: { available: concAvailable, days },
    missing: input.missing,
  };
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

const DASH = "—";
const f = (v: number | null, d = 2, suffix = ""): string => (v === null ? DASH : `${v.toFixed(d)}${suffix}`);
const sgn = (v: number | null, d = 4, suffix = ""): string => (v === null ? DASH : `${v >= 0 ? "+" : ""}${v.toFixed(d)}${suffix}`);

export function renderLiveReport(r: LiveReport): string {
  const out: string[] = [];
  const h = (t: string) => out.push("", `== ${t} ==`);

  out.push(`LAPORAN LIVE FlowMetrix — ${r.generatedAt} (window ${r.windowDays} hari)`);

  h("1. Wallet vs modal");
  if (!r.wallet.latest) out.push("Wallet: BELUM ADA saldo terukur di DB (tidak ada baca wallet pada row live/attempt).");
  else out.push(`Wallet terukur terakhir : ${r.wallet.latest.sol.toFixed(6)} SOL · ${r.wallet.latest.at} UTC · ${r.wallet.latest.source}`);
  out.push(
    `LIVE_CAPITAL_SOL        : ${f(r.wallet.liveCapitalSol, 4)} SOL · selisih ${sgn(r.wallet.vsLiveCapitalSol, 6, " SOL")}`,
    `Baseline (--baseline-sol): ${f(r.wallet.baselineSol, 4)} SOL · selisih ${sgn(r.wallet.vsBaselineSol, 6, " SOL")}`,
  );
  out.push("Catatan: saldo DB = saldo saat trade/attempt terakhir, BUKAN saldo sekarang.");

  h("2. Posisi LIVE yang sudah close");
  if (r.positions.length === 0) out.push("(belum ada posisi live yang close)");
  for (const p of r.positions) {
    out.push(
      `#${p.id} ${p.pair} · ${p.status} · open ${p.openedAt ?? DASH} → close ${p.closedAt ?? DASH}`,
      `   buku $${f(p.bookPnlUsd)} = fee $${f(p.feesUsd)} + nilai posisi $${f(p.valueChangeUsd)} · porsi fee ${f(p.feeSharePct, 1, "%")}`,
      `   chain ${sgn(p.chainDeltaSol, 6, " SOL")} (${p.settlement}) · fee exit ${p.exitFeeLamports === null ? DASH : `${p.exitFeeLamports} lamports`} · ` +
        `konsesi @keputusan ${f(p.concessionDecisionBps, 1, " bps")} · @landing ${f(p.concessionLandingBps, 1, " bps")}`,
    );
  }
  if (r.openLivePositions > 0) out.push(`Posisi live masih terbuka: ${r.openLivePositions} (tidak masuk hitungan di bawah).`);

  h("3. Open yang gagal (live_execution_attempts)");
  const a = (s: AttemptSummary) =>
    `${s.failed} gagal · biaya terukur ${(s.measuredCostLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL · biaya tak terukur ${s.unmeasuredCost} attempt`;
  out.push(`${r.windowDays} hari terakhir : ${a(r.attempts.window)}`, `Sepanjang waktu  : ${a(r.attempts.allTime)}`);

  h("4. Hasil bersih SOL (chain)");
  if (!r.net.measuredAnything) out.push("Hasil bersih: BELUM BISA DIUKUR (tidak ada delta chain maupun biaya gagal yang terukur).");
  else
    out.push(
      `Delta chain posisi close : ${sgn(r.net.chainDeltaSol, 6, " SOL")} (${r.net.measuredPositions} posisi terukur)`,
      `Biaya open gagal         : -${r.net.failedCostSol.toFixed(6)} SOL`,
      `BERSIH                   : ${sgn(r.net.netSol, 6, " SOL")}`,
    );
  out.push(
    `Tidak dihitung: ${r.net.unmeasuredPositions} posisi tanpa baca saldo · ${r.net.unsettledPositions} posisi residual belum settle · ` +
      `${r.net.unmeasuredAttemptCosts} attempt gagal tanpa biaya terukur.`,
  );

  h("5. Konsentrasi token (entry live)");
  if (r.concentration.lines.length === 0) out.push("(belum ada entry live)");
  for (const c of r.concentration.lines) out.push(`${c.token} · total ${c.allTime} · 24j ${c.last24h} · ${r.windowDays}h ${c.lastWindow}`);
  if (r.concentration.top) out.push(`Porsi terbesar: ${r.concentration.top.token} = ${r.concentration.top.sharePct.toFixed(1)}% dari entry live.`);

  h("6. Sumber profit (buku, USD)");
  if (r.profitSource.tradesCounted === 0) out.push("(tidak ada trade dengan pecahan fee/nilai posisi)");
  else {
    out.push(
      `Fee total $${r.profitSource.feesUsd.toFixed(2)} vs perubahan nilai posisi $${r.profitSource.valueChangeUsd.toFixed(2)} ` +
        `(${r.profitSource.tradesCounted} trade${r.profitSource.tradesUnsplit ? `, ${r.profitSource.tradesUnsplit} tanpa pecahan` : ""})`,
    );
    if (r.profitSource.valueChangeExceedsFees) {
      out.push("PERUBAHAN NILAI POSISI > FEE: profit lebih banyak dari gerak harga daripada dari fee LP.");
    }
  }

  h("7. Kesiapan evaluasi");
  out.push(`${r.readiness.closedLiveTrades}/${r.readiness.target} trade live`);

  h("8. LLM vs rule (shadow pick)");
  const s = r.shadow;
  if (!s.available) {
    out.push(`${DASH} DB ini belum punya kolom shadow pick (scan_funnel_cycles.shortlist_size / llm_pick_* / rule_pick_*).`);
  } else {
    const scope = (label: string, x: ShadowScope) =>
      `${label}: ${x.decisions} keputusan · LLM menolak ${x.llmDeclined} · SAMA ${x.same} · BEDA ${x.different} · ` +
      `kesepakatan ${f(x.agreementPct, 1, "%")} · rule tanpa pilihan ${x.ruleNull} · median shortlist ${f(x.shortlistMedian, 1)}`;
    out.push(scope(`${r.windowDays} hari terakhir`, s.window), scope("Sepanjang waktu ", s.allTime));
    out.push(
      "Rule = pool dengan fee/TVL 24h tertinggi di shortlist yang SAMA; tidak pernah dieksekusi. Kesepakatan dihitung dari siklus di mana LLM memilih DAN rule punya pilihan.",
    );
    if (!s.sampleSufficient) {
      out.push(`sampel belum cukup untuk menilai LLM (${s.allTime.decisions}/${MIN_SHADOW_DECISIONS} keputusan).`);
    } else {
      out.push("Sampel sudah melewati batas minimum, tetapi laporan ini TIDAK memberi vonis: kesepakatan bukan hasil.");
    }
    if (s.recentDifferent.length > 0) {
      out.push("Siklus BEDA terakhir (maks 10, terbaru dulu):");
      for (const d of s.recentDifferent) {
        out.push(`   ${d.cycleAt} · shortlist ${d.shortlistSize ?? DASH} · LLM ${d.llmPair ?? DASH} · rule ${d.rulePair ?? DASH}`);
      }
    }
    out.push(
      `Pilihan LLM yang benar-benar dieksekusi (join: posisi live / attempt gagal di pool yang sama, ` +
        `paling lama ${SHADOW_OPEN_MATCH_HOURS} jam sesudah siklus; siklus terakhir yang cocok dipakai, lebih dari satu = ambigu):`,
    );
    if (s.opened.length === 0) out.push("   (belum ada)");
    for (const o of s.opened) {
      out.push(
        `   ${o.cycleAt} · LLM ${o.llmPair ?? DASH} (rule ${o.ruleSame === null ? "tanpa pilihan" : o.ruleSame ? "SAMA" : `BEDA: ${o.rulePair ?? DASH}`}) · ` +
          `${o.match === "position" ? `posisi #${o.positionId} ${o.status}` : o.status} · buku $${f(o.bookPnlUsd)} · chain ${sgn(o.chainDeltaSol, 6, " SOL")}` +
          (o.ambiguous ? " · AMBIGU" : ""),
      );
    }
    out.push(
      "Hasil kontrafaktual pilihan rule TIDAK terukur dari DB: pool itu tidak pernah dibuka. " +
        "Menilainya butuh analisis bar offline per rule_pick_pool + cycle_at.",
    );
  }

  h("9. Konsentrasi harian (UTC)");
  out.push(
    "Mode gate (report/enforce) TIDAK tercatat di DB — itu env LIVE_TOKEN_CONCENTRATION_MODE; 'ditolak' > 0 hanya mungkin di enforce.",
  );
  for (const d of r.dailyConcentration.days) {
    out.push(
      `${d.day} · open live ${d.liveOpens} · token berbeda ${d.distinctTokens} · ` +
        `teratas ${d.topToken === null ? DASH : `${d.topToken} (${d.topCount}x)`} · ` +
        `di-flag ${d.flagged === null ? DASH : d.flagged} · ditolak ${d.rejected === null ? DASH : d.rejected} · siklus funnel ${d.funnelCycles}`,
    );
  }

  if (r.missing.length > 0) {
    out.push("", `Kolom/tabel tidak ada di DB ini (dibaca sebagai ${DASH}): ${r.missing.join(", ")}`);
  }
  return out.join("\n");
}
