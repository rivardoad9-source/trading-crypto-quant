/**
 * The "live-eligible" arm: pools the live engine could actually enter.
 *
 * WHY. The 8 Sep benchmark put 35 of 42 trades on pools with NO wSOL leg — the live
 * engine refuses those (`noWsol`, it can only fund an entry in SOL) — and 9 on OPENAI-USDC,
 * a Token-2022 mint with a 50 bps transfer fee AND a transfer hook, which the live token
 * screen refuses. Those 9 were 47.7% of the benchmark's net. The subset live could have
 * traded was 7 trades and -$20.64. A headline over a universe live cannot touch is not a
 * measurement of the strategy live runs, so every run now prints both arms and the gap.
 *
 * Two facts decide eligibility, and both mirror a live gate rather than restating it:
 *
 *   1. a wSOL leg — `hasWsolLeg`, the test `describePair()` applies;
 *   2. the paired mint's Token-2022 extensions — read with `readTokenExtensions` and judged
 *      by `assessTokenFeeScreen`, the SAME functions the live funnel calls. There is no
 *      second decoder and no second copy of the policy here, so the arm cannot drift from
 *      the gate it claims to mirror.
 *
 * FAIL-CLOSED, as live is: a mint that could not be read, or a pool that was never
 * annotated, is NOT eligible. "We did not look" must not resolve to "clean".
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { WSOL_MINT } from "../config/constants.js";
import {
  assessTokenFeeScreen,
  readTokenExtensions,
  type TokenExtensionReading,
} from "../services/tokenExtensions.js";
import type { PoolHistory } from "./historicalData.js";

/** What the ingest stored about a pool's paired mint. */
export interface TokenScreenRecord {
  /** The mint the live screen reads: the non-wSOL leg (the base leg when there is none). */
  mint: string;
  /** Null when the read failed; `error` then says why. */
  reading: TokenExtensionReading | null;
  error: string | null;
}

export type TokenExtensionReader = (mint: string) => Promise<TokenExtensionReading>;

export const TOKEN_EXTENSION_CACHE = ".cache/token_extensions.json";

export const hasWsolLeg = (p: Pick<PoolHistory, "baseMint" | "quoteMint">): boolean =>
  p.baseMint === WSOL_MINT || p.quoteMint === WSOL_MINT;

/** The mint the live token screen would read for this pool. */
export const pairedMintOf = (p: Pick<PoolHistory, "baseMint" | "quoteMint">): string =>
  p.baseMint === WSOL_MINT ? p.quoteMint : p.baseMint;

/* ------------------------------------------------------------------ */
/* Annotation (the only I/O in this module)                            */
/* ------------------------------------------------------------------ */

interface CacheFile {
  readings: Record<string, TokenExtensionReading>;
}

function readCache(path: string): Record<string, TokenExtensionReading> {
  const full = resolve(process.cwd(), path);
  if (!existsSync(full)) return {};
  try {
    return (JSON.parse(readFileSync(full, "utf8")) as CacheFile).readings ?? {};
  } catch {
    return {};
  }
}

function writeCache(path: string, readings: Record<string, TokenExtensionReading>): void {
  const full = resolve(process.cwd(), path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, JSON.stringify({ readings } satisfies CacheFile, null, 2), "utf8");
}

export interface AnnotateOptions {
  read?: TokenExtensionReader;
  /** File cache of successful readings, keyed by mint. `null` disables it (tests). */
  cachePath?: string | null;
  /** Pause between uncached RPC reads, so a public endpoint is not hammered. */
  delayMs?: number;
  /** Re-read pools that already carry a record. */
  force?: boolean;
}

/**
 * Stores a `TokenScreenRecord` on every pool, one `getAccountInfo` per DISTINCT mint.
 *
 * Only successful readings are cached: a mint's extension set is fixed when it is
 * created, so a reading does not go stale in a way that matters here, but a FAILED read
 * is a fact about the RPC at that moment and must be retried next run rather than
 * remembered as a permanent refusal. Returns how many RPC reads it made.
 */
export async function annotateTokenScreens(
  pools: PoolHistory[],
  options: AnnotateOptions = {},
): Promise<{ rpcReads: number; failures: number; changed: boolean }> {
  const read = options.read ?? readTokenExtensions;
  const cachePath = options.cachePath === undefined ? TOKEN_EXTENSION_CACHE : options.cachePath;
  const delayMs = options.delayMs ?? 150;
  const cache = cachePath ? readCache(cachePath) : {};

  const inRun = new Map<string, TokenScreenRecord>();
  let rpcReads = 0;
  let failures = 0;
  let changed = false;
  let cacheDirty = false;

  for (const pool of pools) {
    if (pool.tokenScreen && pool.tokenScreen.reading && !options.force) continue;

    const mint = pairedMintOf(pool);
    let record = inRun.get(mint);
    if (!record) {
      const cached = cache[mint];
      if (cached && !options.force) {
        record = { mint, reading: cached, error: null };
      } else {
        if (rpcReads > 0 && delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
        rpcReads++;
        try {
          const reading = await read(mint);
          record = { mint, reading, error: null };
          cache[mint] = reading;
          cacheDirty = true;
        } catch (err) {
          failures++;
          record = { mint, reading: null, error: err instanceof Error ? err.message : String(err) };
        }
      }
      inRun.set(mint, record);
    }

    pool.tokenScreen = record;
    changed = true;
  }

  if (cachePath && cacheDirty) writeCache(cachePath, cache);
  return { rpcReads, failures, changed };
}

/* ------------------------------------------------------------------ */
/* Classification                                                      */
/* ------------------------------------------------------------------ */

export type IneligibleReason = "noWsol" | "unannotated" | "tokenScreen";

export interface EligibilityVerdict {
  eligible: boolean;
  reason: IneligibleReason | null;
  /** The live screen's own words when it refused, or the read error. */
  detail: string | null;
}

export interface TokenScreenPolicy {
  maxTransferFeeBps: number;
}

/**
 * Whether live could enter this pool. The token half is judged by `assessTokenFeeScreen`
 * itself, handed the stored reading — or the stored read error, which it refuses exactly
 * as it refuses an unreadable mint live.
 */
export async function classifyLiveEligibility(
  pool: PoolHistory,
  policy: TokenScreenPolicy,
): Promise<EligibilityVerdict> {
  if (!hasWsolLeg(pool)) {
    return { eligible: false, reason: "noWsol", detail: "no wSOL leg — live cannot fund the entry" };
  }
  const record = pool.tokenScreen;
  if (!record) {
    return {
      eligible: false,
      reason: "unannotated",
      detail: "the paired mint was never read — refused, as an unread mint is live",
    };
  }
  const verdict = await assessTokenFeeScreen(record.mint, policy.maxTransferFeeBps, async () => {
    if (record.reading) return record.reading;
    throw new Error(record.error ?? "no reading");
  });
  return verdict.blocked
    ? { eligible: false, reason: "tokenScreen", detail: verdict.reason }
    : { eligible: true, reason: null, detail: null };
}

export interface EligibilityPartition {
  eligible: PoolHistory[];
  ineligible: Array<{ pool: PoolHistory; verdict: EligibilityVerdict }>;
  counts: Record<IneligibleReason, number>;
}

export async function partitionLiveEligible(
  pools: PoolHistory[],
  policy: TokenScreenPolicy,
): Promise<EligibilityPartition> {
  const out: EligibilityPartition = {
    eligible: [],
    ineligible: [],
    counts: { noWsol: 0, unannotated: 0, tokenScreen: 0 },
  };
  for (const pool of pools) {
    const verdict = await classifyLiveEligibility(pool, policy);
    if (verdict.eligible) out.eligible.push(pool);
    else {
      out.ineligible.push({ pool, verdict });
      out.counts[verdict.reason as IneligibleReason]++;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* The three lines every run prints                                    */
/* ------------------------------------------------------------------ */

export interface ArmFigures {
  pools: number;
  trades: number;
  netPnlUsd: number;
  profitFactor: number | null;
  maxDrawdownPct: number;
}

const money = (n: number): string => `${n < 0 ? "-" : "+"}$${Math.abs(n).toFixed(2)}`;
const pfText = (v: number | null): string => (v === null ? "undefined" : v.toFixed(2));

/**
 * (a) live-eligible, (b) full universe, (c) the difference — in that order, always.
 *
 * The difference is (b) minus (a): how much of the full-universe result came from pools
 * live cannot enter. It is NOT additive trade-by-trade — the arms are separate accounts
 * competing for the same slot, so a pool removed can hand its bars to another.
 */
export function describeEligibilityArms(
  eligible: ArmFigures,
  full: ArmFigures,
  partition?: Pick<EligibilityPartition, "counts">,
): string[] {
  const why = partition
    ? ` (dropped: ${partition.counts.noWsol} noWsol, ${partition.counts.tokenScreen} token screen, ` +
      `${partition.counts.unannotated} unread)`
    : "";
  return [
    `(a) live-eligible : ${eligible.pools} pools · ${eligible.trades} trades · net ${money(eligible.netPnlUsd)} · ` +
      `PF ${pfText(eligible.profitFactor)} · maxDD ${eligible.maxDrawdownPct.toFixed(1)}%`,
    `(b) full universe : ${full.pools} pools · ${full.trades} trades · net ${money(full.netPnlUsd)} · ` +
      `PF ${pfText(full.profitFactor)} · maxDD ${full.maxDrawdownPct.toFixed(1)}%`,
    `(c) selisih (b-a) : ${full.pools - eligible.pools} pools · ${full.trades - eligible.trades} trades · ` +
      `net ${money(full.netPnlUsd - eligible.netPnlUsd)}${why}`,
  ];
}
