/**
 * What an exit actually costs, as a function of the pool — not a flat 2%.
 *
 * WHY. The harness charged `forcedExitSlippagePct` (the live `.env` 2.0) to OUT_OF_RANGE,
 * STOP_LOSS, RATCHET_STOP and rugged exits only, and charged NOTHING to a TAKE_PROFIT —
 * the exit most live trades take. Live says otherwise:
 *
 *   - EMBER-SOL #5 (bin_step 200, TVL $82.8k, ~0.79 SOL sold): the residual sale landed
 *     **3.95% below** the pool's reported price, on a take-profit. The book said +5.26%,
 *     the wallet +2.65%.
 *   - NEARKAT-SOL (bin_step 400): swap in + immediate unwind lost **8.77%** of 0.9 SOL —
 *     of which ~5.91% is the token's 3% transfer fee paid on both legs.
 *   - MANLET-SOL (bin_step 80): book-vs-chain gap **~0.6pp**.
 *
 * A DLMM pool quotes in discrete bins `bin_step` apart, and a seller walks the book at
 * least one bin down, so the concession grows with the bin step; impact grows with the
 * share of the pool being sold. That is the shape modelled here:
 *
 *   concessionPct = max(minPct, spreadPerBinStepPct x binStepPct + impactPerTvlPct x (notional/TVL x 100))
 *
 * The concession is a PRICE haircut on the exit ratio, the same unit `forcedExitSlippagePct`
 * already has, so the engine's `sqrt(r) - 1` valuation turns it into roughly half that
 * much of notional — which is right: about half a balanced position is the token being sold.
 *
 * THIS IS A CALIBRATION FROM THREE CONFOUNDED POINTS, NOT A MEASUREMENT. EMBER sold into a
 * 10% move; NEARKAT's legs were routed by Jupiter (not necessarily through the 400 pool);
 * the TVLs for MANLET and NEARKAT are today's, not the trade's. The fit and the pessimistic
 * envelope disagree by ~3x, which is why the runner reports BOTH and trusts a conclusion
 * only where it holds across the pair.
 *
 * Pure — no I/O — so every number here is unit-tested.
 */

export interface ExitCostModel {
  /** Label printed in reports, so a figure always names the model that produced it. */
  label: string;
  /** Price concession per 1% of bin step (bin_step 200 bps = 2%). */
  spreadPerBinStepPct: number;
  /** Price concession per 1% of the pool's TVL being sold. */
  impactPerTvlPct: number;
  /** Floor: no exit is cheaper than this. `flatExitCostModel` uses it alone. */
  minPct: number;
}

/** The legacy flat assumption applied to EVERY exit instead of forced ones only. */
export const flatExitCostModel = (pct: number): ExitCostModel => ({
  label: `flat ${pct}% (all exits)`,
  spreadPerBinStepPct: 0,
  impactPerTvlPct: 0,
  minPct: pct,
});

/**
 * Exit price concession, in percent, for one pool at one position size.
 *
 * An unknown TVL (0, NaN) contributes NO impact term rather than an infinite one: the
 * modelled TVL is already the entry gate's input, and a pool with no TVL never reaches
 * a close. A non-finite or non-positive bin step contributes nothing either — the floor
 * still applies, so a pool with a missing bin step is never exited for free.
 */
export function exitConcessionPct(
  model: ExitCostModel,
  binStepBps: number,
  notionalUsd: number,
  tvlUsd: number,
): number {
  const binStepPct = Number.isFinite(binStepBps) && binStepBps > 0 ? binStepBps / 100 : 0;
  const shareOfTvlPct =
    Number.isFinite(tvlUsd) && tvlUsd > 0 && Number.isFinite(notionalUsd) && notionalUsd > 0
      ? (notionalUsd / tvlUsd) * 100
      : 0;
  const modelled = model.spreadPerBinStepPct * binStepPct + model.impactPerTvlPct * shareOfTvlPct;
  // A concession of 100% or more would mark the sale below zero; clamp, never wrap.
  return Math.min(99, Math.max(model.minPct, modelled));
}

/* ------------------------------------------------------------------ */
/* Calibration                                                         */
/* ------------------------------------------------------------------ */

/** One live observation of what a swap leg cost, net of any Token-2022 transfer fee. */
export interface ExitCostObservation {
  label: string;
  binStepBps: number;
  /** Amount swapped over the pool's TVL at the time, as a percentage. */
  shareOfTvlPct: number;
  /** Price concession per leg on the amount swapped, in percent. */
  concessionPct: number;
  /** Where the number came from and what it cannot see. */
  source: string;
}

/**
 * The three live points, converted to ONE unit: concession per leg on the amount swapped.
 *
 *  MANLET  gap ~0.6pp of notional over two legs that each swap about half the position,
 *          so ~0.6% per leg. TVL today $43.6k (the trade's is unknown); ~0.9 SOL x $100.
 *  EMBER   the exit leg directly: 0.786983 SOL received against 0.81929 at pool price.
 *          TVL $82.8k at the trade, ~0.79 SOL x $102 sold.
 *  NEARKAT 8.77% round trip, less the 3% transfer fee on both legs (1 - 0.97^2 = 5.91%),
 *          = 2.86% over two legs = 1.43% per leg. TVL today $50.1k.
 */
export const LIVE_EXIT_OBSERVATIONS: readonly ExitCostObservation[] = [
  {
    label: "MANLET-SOL",
    binStepBps: 80,
    shareOfTvlPct: ((0.9 * 100) / 43_600) * 100,
    concessionPct: 0.6,
    source: "book-vs-chain gap 0.6pp / 2 legs x 0.5 notional; TVL = today",
  },
  {
    label: "EMBER-SOL",
    binStepBps: 200,
    shareOfTvlPct: ((0.79 * 102) / 82_800) * 100,
    concessionPct: 3.95,
    source: "residual sale vs pool price, 12 Sep; sold into a ~10% move",
  },
  {
    label: "NEARKAT-SOL",
    binStepBps: 400,
    shareOfTvlPct: ((0.9 * 100) / 50_100) * 100,
    concessionPct: ((1 - 0.822476 / 0.901586 - (1 - 0.97 ** 2)) * 100) / 2,
    source: "round trip 8.77% less 3% transfer fee x2, per leg; Jupiter-routed; TVL = today",
  },
];

export interface ExitCostCalibration {
  /** Least squares through the origin on (binStepPct, shareOfTvlPct). */
  fit: ExitCostModel;
  /** The worst observed concession per 1% of bin step — the pessimistic bound. */
  envelope: ExitCostModel;
  residuals: Array<{ label: string; observedPct: number; fitPct: number; envelopePct: number }>;
}

/**
 * Fits the model to observations.
 *
 * Two regressors, no intercept: an exit on a zero-bin-step, zero-share pool costs nothing
 * beyond the floor, and an intercept fitted on three points would be pure noise. When the
 * two-variable solve gives a NEGATIVE coefficient — more impact making an exit cheaper,
 * which is physically meaningless and happens on three confounded points — that
 * regressor is dropped and the other refitted alone. A negative coefficient would let a
 * bigger sale be modelled as cheaper, which is the permissive direction.
 *
 * The envelope is `max(concession / binStepPct)`, no impact term: "at least as bad as
 * the worst exit we have seen, scaled by bin step". It is the bound a conclusion has to
 * survive.
 */
export function calibrateExitCostModel(
  observations: readonly ExitCostObservation[],
  minPct = 0,
): ExitCostCalibration {
  const usable = observations.filter(
    (o) => o.binStepBps > 0 && Number.isFinite(o.concessionPct) && Number.isFinite(o.shareOfTvlPct),
  );
  if (usable.length === 0) throw new Error("[exit-cost] no usable observation to calibrate on");

  const x1 = usable.map((o) => o.binStepBps / 100);
  const x2 = usable.map((o) => Math.max(0, o.shareOfTvlPct));
  const y = usable.map((o) => o.concessionPct);
  const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * (b[i] as number), 0);

  const s11 = dot(x1, x1);
  const s22 = dot(x2, x2);
  const s12 = dot(x1, x2);
  const s1y = dot(x1, y);
  const s2y = dot(x2, y);

  let spread = s11 > 0 ? s1y / s11 : 0;
  let impact = 0;
  const det = s11 * s22 - s12 * s12;
  if (usable.length >= 2 && Math.abs(det) > 1e-12) {
    const a = (s1y * s22 - s2y * s12) / det;
    const b = (s2y * s11 - s1y * s12) / det;
    if (a >= 0 && b >= 0) {
      spread = a;
      impact = b;
    } else if (a < 0 && s22 > 0) {
      spread = 0;
      impact = Math.max(0, s2y / s22);
    }
    // b < 0 (with a >= 0): keep the one-variable bin-step fit computed above.
  }
  spread = Math.max(0, spread);

  const envelopeSpread = Math.max(...usable.map((o, i) => o.concessionPct / (x1[i] as number)));

  const fit: ExitCostModel = {
    label: `fit (${spread.toFixed(3)}%/bin-step% + ${impact.toFixed(3)}%/TVL%)`,
    spreadPerBinStepPct: spread,
    impactPerTvlPct: impact,
    minPct,
  };
  const envelope: ExitCostModel = {
    label: `envelope (${envelopeSpread.toFixed(3)}%/bin-step%)`,
    spreadPerBinStepPct: envelopeSpread,
    impactPerTvlPct: 0,
    minPct,
  };

  const at = (m: ExitCostModel, o: ExitCostObservation) =>
    Math.max(m.minPct, m.spreadPerBinStepPct * (o.binStepBps / 100) + m.impactPerTvlPct * o.shareOfTvlPct);

  return {
    fit,
    envelope,
    residuals: usable.map((o) => ({
      label: o.label,
      observedPct: o.concessionPct,
      fitPct: at(fit, o),
      envelopePct: at(envelope, o),
    })),
  };
}

/* ------------------------------------------------------------------ */
/* Observations from the exit_economics ledger                         */
/* ------------------------------------------------------------------ */

/** The ledger columns a calibration needs (structural, so this file stays DB-free). */
export interface MeasuredExitRow {
  position_id: string;
  pair_name: string | null;
  bin_step: number | null;
  sweep_concession_bps: number | null;
  expected_out_lamports: number | null;
  tvl_usd_at_exit: number | null;
  entry_tvl_usd: number | null;
  source: string;
}

/**
 * Ledger rows -> calibration observations, in the SAME unit as `LIVE_EXIT_OBSERVATIONS`
 * (concession per leg on the amount swapped).
 *
 * Only rows with a measured concession and a bin step become observations — an unmeasured
 * row is left out, never read as a zero-cost exit. The share of TVL is NaN (and the row
 * then only informs a bin-step-only fit) when neither TVL at exit nor the entry proxy is
 * known, or no SOL/USD was given to convert the swapped SOL into dollars.
 */
export function observationsFromLedger(
  rows: readonly MeasuredExitRow[],
  solUsd: number | null,
): { observations: ExitCostObservation[]; excluded: Array<{ id: string; why: string }> } {
  const observations: ExitCostObservation[] = [];
  const excluded: Array<{ id: string; why: string }> = [];
  for (const r of rows) {
    if (r.sweep_concession_bps === null || !Number.isFinite(r.sweep_concession_bps)) {
      excluded.push({ id: r.position_id, why: "concession unmeasured" });
      continue;
    }
    if (!(r.bin_step !== null && r.bin_step > 0)) {
      excluded.push({ id: r.position_id, why: "bin_step unmeasured" });
      continue;
    }
    const tvl = r.tvl_usd_at_exit ?? r.entry_tvl_usd;
    const share =
      tvl !== null && tvl > 0 && solUsd !== null && solUsd > 0 && r.expected_out_lamports !== null
        ? (((r.expected_out_lamports / 1e9) * solUsd) / tvl) * 100
        : Number.NaN;
    observations.push({
      label: `${r.pair_name ?? "?"}#${r.position_id.slice(0, 8)}`,
      binStepBps: r.bin_step,
      shareOfTvlPct: share,
      concessionPct: r.sweep_concession_bps / 100,
      source:
        `${r.source}` +
        (r.tvl_usd_at_exit === null && r.entry_tvl_usd !== null ? "; TVL = entry proxy" : "") +
        (Number.isNaN(share) ? "; share of TVL unknown" : ""),
    });
  }
  return { observations, excluded };
}

/** Least-squares slope through the origin of concession% on bin-step% — the envelope's shape, fitted. */
export function binStepOnlySlope(observations: readonly ExitCostObservation[]): number | null {
  let sxx = 0;
  let sxy = 0;
  for (const o of observations) {
    const x = o.binStepBps / 100;
    sxx += x * x;
    sxy += x * o.concessionPct;
  }
  return sxx > 0 ? sxy / sxx : null;
}

export interface StabilityRow {
  n: number;
  meanSlope: number;
  standardError: number;
  /** standardError / meanSlope; null when the mean is not positive. */
  relativeError: number | null;
}

/**
 * How stable the bin-step slope is at each sample size, by bootstrap: draw `n` observations
 * WITH replacement `draws` times, fit, and report the spread of the fitted slopes.
 *
 * Deterministic (seeded LCG), so the report is reproducible. Resampling from the points we
 * have cannot reveal exits we have not seen — it measures the noise of THIS sample, which
 * is the lower bound of the real uncertainty, and the report says so.
 */
export function bootstrapSlopeStability(
  observations: readonly ExitCostObservation[],
  sizes: readonly number[],
  draws = 1_000,
  seed = 1_234_567,
): StabilityRow[] {
  if (observations.length === 0) return [];
  let state = seed >>> 0;
  const next = () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
  return sizes.map((n) => {
    const slopes: number[] = [];
    for (let d = 0; d < draws; d++) {
      const sample = Array.from({ length: n }, () => observations[Math.floor(next() * observations.length)]!);
      const s = binStepOnlySlope(sample);
      if (s !== null) slopes.push(s);
    }
    const mean = slopes.reduce((a, b) => a + b, 0) / Math.max(1, slopes.length);
    const variance = slopes.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, slopes.length - 1);
    const se = Math.sqrt(variance);
    return { n, meanSlope: mean, standardError: se, relativeError: mean > 0 ? se / mean : null };
  });
}

/**
 * The smallest n at which the bootstrap relative error falls to `target`, extrapolating the
 * 1/sqrt(n) law from the largest measured size when no measured size reaches it. Null when
 * the error cannot be computed.
 */
export function observationsNeededFor(rows: readonly StabilityRow[], target: number): { n: number; extrapolated: boolean } | null {
  const hit = rows.find((r) => r.relativeError !== null && r.relativeError <= target);
  if (hit) return { n: hit.n, extrapolated: false };
  const last = [...rows].reverse().find((r) => r.relativeError !== null && r.relativeError > 0);
  if (!last || last.relativeError === null) return null;
  return { n: Math.ceil(last.n * (last.relativeError / target) ** 2), extrapolated: true };
}

export type ExitCostFlag = "legacy" | "flat" | "fit" | "envelope";

/**
 * Resolves `--exitcost=<legacy|flat|fit|envelope>` for every runner, so they cannot each
 * grow a slightly different meaning of the same word. `legacy` (null) is the default
 * everywhere: forced exits flat, chosen exits free — what every published figure used.
 */
export function exitCostModelFromFlag(
  flag: string | undefined,
  forcedExitSlippagePct: number,
): ExitCostModel | null {
  const value = (flag ?? "legacy").toLowerCase();
  if (value === "legacy") return null;
  if (value === "flat") return flatExitCostModel(forcedExitSlippagePct);
  const calibration = calibrateExitCostModel(LIVE_EXIT_OBSERVATIONS);
  if (value === "fit") return calibration.fit;
  if (value === "envelope") return calibration.envelope;
  throw new Error(`--exitcost must be legacy, flat, fit or envelope — got "${flag}"`);
}

/* ------------------------------------------------------------------ */
/* What a take-profit is worth after the exit                          */
/* ------------------------------------------------------------------ */

export interface TakeProfitAfterCost {
  binStepBps: number;
  exitConcessionPct: number;
  /** Net result as % of notional when a TP fires exactly at `takeProfitPct` gross. */
  netAtTakeProfitPct: number;
  profitable: boolean;
}

/**
 * The net a take-profit books once the round trip is paid, per bin step.
 *
 * The engine fires TP on a MARK that is gross of costs, then charges costs at the close,
 * so a "+5%" exit books 5% less:
 *
 *   - gas: `gasRoundTripPctOfNotional` (two transactions / notional)
 *   - the entry balancing swap: half the notional at `entrySwapPct`
 *   - the exit: the modelled concession through `sqrt`, i.e. `1 - sqrt(1 - c)` of notional
 *
 * The exit term is computed the way the engine applies it rather than approximated as c/2,
 * so this table and the simulation cannot disagree about the same trade.
 */
export function takeProfitAfterCost(params: {
  model: ExitCostModel;
  binStepsBps: readonly number[];
  takeProfitPct: number;
  notionalUsd: number;
  tvlUsd: number;
  gasRoundTripPctOfNotional: number;
  entrySwapPct: number;
}): TakeProfitAfterCost[] {
  return params.binStepsBps.map((binStepBps) => {
    const c = exitConcessionPct(params.model, binStepBps, params.notionalUsd, params.tvlUsd);
    const exitCostPctOfNotional = (1 - Math.sqrt(1 - c / 100)) * 100;
    const net =
      params.takeProfitPct -
      params.gasRoundTripPctOfNotional -
      0.5 * params.entrySwapPct -
      exitCostPctOfNotional;
    return { binStepBps, exitConcessionPct: c, netAtTakeProfitPct: net, profitable: net > 0 };
  });
}

/** The largest bin step (from the candidates) at which a TP still books a profit, or null. */
export function maxProfitableBinStep(rows: readonly TakeProfitAfterCost[]): number | null {
  const ok = rows.filter((r) => r.profitable).map((r) => r.binStepBps);
  return ok.length === 0 ? null : Math.max(...ok);
}
