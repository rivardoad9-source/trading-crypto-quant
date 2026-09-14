/**
 * Validating the modelled TVL against TVL measured on-chain, at past instants.
 *
 * WHY. Every backtest conclusion stands on `TVL_t = k x volume24h_t` (see `tvlModel.ts`), and
 * on 14 Sep 2026 k moved 0.195 -> 0.491 merely because the candidate list changed, taking the
 * V1.1 arm from trades to zero trades in all three windows. A number that moves that much with
 * the sample cannot be trusted by assumption, and "no free provider serves historical TVL" was
 * only true of APIs: a DLMM pool's TVL is its two reserve token accounts priced, and a reserve's
 * balance at instant T is the post-balance of the last transaction that touched it before T.
 *
 * One consequence is structural and needs no data: with ONE global k, the engine's
 *   fee/TVL = feeRate x vol24h / (k x vol24h) = feeRate / k
 * so the "fee/TVL" entry gate is a FEE-RATE gate and the TVL band is a VOLUME band. Changing k
 * moves the whole universe across the gate at once, which is exactly the 0-trade collapse.
 *
 * Everything here is pure; the I/O lives in `src/scripts/validateTvlModel.ts`.
 */

export interface TvlObservation {
  pool: string;
  pairName: string;
  window: string;
  t: number;
  feeRate: number;
  vol24hUsd: number;
  realTvlUsd: number;
  /** k from the pool's own TODAY figures (tvl_today / vol24h_today); null when unusable. */
  perPoolKToday: number | null;
}

export const STABLE_SYMBOLS = ["USDC", "USDT", "USDH", "PYUSD", "FDUSD", "DAI", "USD1"];
export const WSOL = "So11111111111111111111111111111111111111112";

/**
 * TVL in USD from reserve amounts (human units) and the pool ratio Y-per-X at the same instant.
 * Priced through whichever side is SOL or a stable; null when neither side can be priced —
 * never guessed.
 */
export function tvlFromReserves(input: {
  x: number;
  y: number;
  ratioYPerX: number;
  xIsSol: boolean;
  yIsSol: boolean;
  xIsStable: boolean;
  yIsStable: boolean;
  solUsd: number | null;
}): number | null {
  const { x, y, ratioYPerX: r } = input;
  if (!(r > 0) || !Number.isFinite(r) || !(x >= 0) || !(y >= 0)) return null;
  const inY = x * r + y; // whole pool in Y units
  const inX = x + y / r; // whole pool in X units
  if (input.yIsStable) return inY;
  if (input.xIsStable) return inX;
  if (input.solUsd === null || !(input.solUsd > 0)) return null;
  if (input.yIsSol) return inY * input.solUsd;
  if (input.xIsSol) return inX * input.solUsd;
  return null;
}

/** Post-balance (human units) of `account` in a parsed transaction, or null when the tx does not carry it. */
export function postBalanceOf(
  tx: {
    transaction?: { message?: { accountKeys?: Array<string | { pubkey: string }> } };
    meta?: { postTokenBalances?: Array<{ accountIndex: number; uiTokenAmount: { uiAmountString?: string; amount: string; decimals: number } }> } | null;
  } | null | undefined,
  account: string,
): number | null {
  const keys = (tx?.transaction?.message?.accountKeys ?? []).map((k) => (typeof k === "string" ? k : k.pubkey));
  for (const b of tx?.meta?.postTokenBalances ?? []) {
    if (keys[b.accountIndex] !== account) continue;
    const v = Number(b.uiTokenAmount.uiAmountString ?? Number(b.uiTokenAmount.amount) / 10 ** b.uiTokenAmount.decimals);
    return Number.isFinite(v) ? v : null;
  }
  return null;
}

const sortedCopy = (xs: readonly number[]) => [...xs].sort((a, b) => a - b);

export function quantile(xs: readonly number[], q: number): number | null {
  if (xs.length === 0) return null;
  const s = sortedCopy(xs);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

/** Average ranks, ties shared. */
function ranks(xs: readonly number[]): number[] {
  const idx = xs.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(xs.length);
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1]![0] === idx[i]![0]) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[idx[k]![1]] = r;
    i = j + 1;
  }
  return out;
}

/** Spearman rank correlation; null below 3 points or when either side is constant. */
export function spearman(a: readonly number[], b: readonly number[]): number | null {
  if (a.length !== b.length || a.length < 3) return null;
  const ra = ranks(a);
  const rb = ranks(b);
  const mean = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length;
  const ma = mean(ra);
  const mb = mean(rb);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < ra.length; i++) {
    num += (ra[i]! - ma) * (rb[i]! - mb);
    da += (ra[i]! - ma) ** 2;
    db += (rb[i]! - mb) ** 2;
  }
  return da === 0 || db === 0 ? null : num / Math.sqrt(da * db);
}

export interface ErrorSummary {
  n: number;
  /** Quantiles of log2(modelled / real): 0 = exact, +1 = model 2x too high, -1 = half. */
  log2Ratio: { p10: number | null; p25: number | null; median: number | null; p75: number | null; p90: number | null };
  /** Share of observations with the model within 2x of the truth. */
  within2x: number | null;
  /** Median of |modelled - real| / real. */
  medianAbsPctError: number | null;
}

export function summariseErrors(pairs: ReadonlyArray<{ modelled: number; real: number }>): ErrorSummary {
  const usable = pairs.filter((p) => p.real > 0 && p.modelled > 0 && Number.isFinite(p.modelled));
  const l2 = usable.map((p) => Math.log2(p.modelled / p.real));
  const ape = usable.map((p) => Math.abs(p.modelled - p.real) / p.real);
  return {
    n: usable.length,
    log2Ratio: {
      p10: quantile(l2, 0.1),
      p25: quantile(l2, 0.25),
      median: quantile(l2, 0.5),
      p75: quantile(l2, 0.75),
      p90: quantile(l2, 0.9),
    },
    within2x: usable.length ? l2.filter((v) => Math.abs(v) <= 1).length / usable.length : null,
    medianAbsPctError: quantile(ape, 0.5),
  };
}

export interface BandConfusion {
  bothIn: number;
  bothOut: number;
  /** Model says in band, chain says out: pools the backtest trades that live would have refused. */
  falseAccept: number;
  /** Model says out, chain says in: pools the backtest never trades that live could have. */
  falseReject: number;
}

export function bandConfusion(
  pairs: ReadonlyArray<{ modelled: number; real: number }>,
  band: { minUsd: number; maxUsd: number },
): BandConfusion {
  const inBand = (v: number) => v >= band.minUsd && v <= band.maxUsd;
  const out: BandConfusion = { bothIn: 0, bothOut: 0, falseAccept: 0, falseReject: 0 };
  for (const p of pairs) {
    const m = inBand(p.modelled);
    const r = inBand(p.real);
    if (m && r) out.bothIn++;
    else if (!m && !r) out.bothOut++;
    else if (m) out.falseAccept++;
    else out.falseReject++;
  }
  return out;
}

/** Top-n overlap of two rankings over the same items (higher = better), as a share of n. */
export function topNOverlap(items: ReadonlyArray<{ id: string; a: number; b: number }>, n: number): number | null {
  const m = Math.min(n, items.length);
  if (m === 0) return null;
  const top = (key: "a" | "b") => new Set([...items].sort((x, y) => y[key] - x[key] || x.id.localeCompare(y.id)).slice(0, m).map((x) => x.id));
  const ta = top("a");
  const tb = top("b");
  let shared = 0;
  for (const id of ta) if (tb.has(id)) shared++;
  return shared / m;
}

/**
 * For each k variant: TVL error distribution, band decisions, and whether the ORDER of pools
 * survives (TVL and fee/TVL, Spearman over one sample instant per pool).
 */
export function evaluateKVariant(
  obs: readonly TvlObservation[],
  k: number | "per-pool-today",
  band: { minUsd: number; maxUsd: number },
  feeTvlGate: { min: number; max: number },
): {
  k: number | "per-pool-today";
  n: number;
  errors: ErrorSummary;
  band: BandConfusion;
  spearmanTvl: number | null;
  spearmanFeeTvl: number | null;
  top10OverlapFeeTvl: number | null;
  /** How many observations pass the fee/TVL gate (floor AND outlier ceiling) under the model vs on-chain. */
  feeTvlGate: { modelledPass: number; realPass: number; agree: number };
} {
  const rows = obs
    .map((o) => {
      const kk = k === "per-pool-today" ? o.perPoolKToday : k;
      if (kk === null || !(o.vol24hUsd > 0) || !(o.realTvlUsd > 0)) return null;
      const modelled = kk * o.vol24hUsd;
      return {
        id: `${o.pool}@${o.t}`,
        modelled,
        real: o.realTvlUsd,
        feeTvlModelled: (o.feeRate * o.vol24hUsd) / modelled,
        feeTvlReal: (o.feeRate * o.vol24hUsd) / o.realTvlUsd,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);
  const pass = (v: number) => v >= feeTvlGate.min && v <= feeTvlGate.max;
  return {
    k,
    n: rows.length,
    errors: summariseErrors(rows),
    band: bandConfusion(rows, band),
    spearmanTvl: spearman(rows.map((r) => r.modelled), rows.map((r) => r.real)),
    spearmanFeeTvl: spearman(rows.map((r) => r.feeTvlModelled), rows.map((r) => r.feeTvlReal)),
    top10OverlapFeeTvl: topNOverlap(rows.map((r) => ({ id: r.id, a: r.feeTvlModelled, b: r.feeTvlReal })), 10),
    feeTvlGate: {
      modelledPass: rows.filter((r) => pass(r.feeTvlModelled)).length,
      realPass: rows.filter((r) => pass(r.feeTvlReal)).length,
      agree: rows.filter((r) => pass(r.feeTvlModelled) === pass(r.feeTvlReal)).length,
    },
  };
}

/**
 * Implied k split by a grouping (e.g. quote side). A global median over a mixed sample is a
 * statement about the MIX: if groups differ by an order of magnitude, the median moves with
 * whichever group the candidate list happens to hold.
 */
export function impliedKByGroup(
  obs: readonly TvlObservation[],
  group: (o: TvlObservation) => string,
): Record<string, ReturnType<typeof impliedK>> {
  const groups = new Map<string, TvlObservation[]>();
  for (const o of obs) groups.set(group(o), [...(groups.get(group(o)) ?? []), o]);
  return Object.fromEntries([...groups.entries()].sort().map(([g, xs]) => [g, impliedK(xs)]));
}

/**
 * TIME vs COMPOSITION. For pools observed in both windows of a pair, the median over pools of
 * log2(k_older / k_newer), each pool's k being its own median in that window. Near 0 means the
 * SAME pools did not change their TVL-to-volume ratio: a global k that moves between windows is
 * then moving because the sample changed, not because the market did.
 */
export function samePoolKDrift(
  obs: readonly TvlObservation[],
  newer: string,
  older: string,
): { pools: number; medianLog2OlderOverNewer: number | null } {
  const perPool = new Map<string, Record<string, number[]>>();
  for (const o of obs) {
    if (!(o.vol24hUsd > 0 && o.realTvlUsd > 0)) continue;
    const rec = perPool.get(o.pool) ?? {};
    (rec[o.window] ??= []).push(o.realTvlUsd / o.vol24hUsd);
    perPool.set(o.pool, rec);
  }
  const drifts: number[] = [];
  for (const rec of perPool.values()) {
    const a = rec[newer];
    const b = rec[older];
    if (!a || !b) continue;
    drifts.push(Math.log2(quantile(b, 0.5)! / quantile(a, 0.5)!));
  }
  return { pools: drifts.length, medianLog2OlderOverNewer: quantile(drifts, 0.5) };
}

/** k that the chain implies at each observation: real TVL / trailing 24h volume. */
export function impliedK(obs: readonly TvlObservation[]): { n: number; p25: number | null; median: number | null; p75: number | null } {
  const ks = obs.filter((o) => o.vol24hUsd > 0 && o.realTvlUsd > 0).map((o) => o.realTvlUsd / o.vol24hUsd);
  return { n: ks.length, p25: quantile(ks, 0.25), median: quantile(ks, 0.5), p75: quantile(ks, 0.75) };
}
