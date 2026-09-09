/**
 * GMGN holder-structure gate — an OPTIONAL, FAIL-OPEN, REPORT-ONLY-BY-DEFAULT
 * screening layer over the anti-rug screen.
 *
 * WHY IT EXISTS (9 Sep 2026): OTC-SOL passed every engine screen (antirug,
 * volatility, fee/TVL, age) yet was a `...pump` memecoin being driven by bundled
 * wallets — its price moved bins in the seconds between create and fund, and the
 * wide open failed with ExceededBinSlippageTolerance (~0.033 SOL). Engine screens
 * are on-chain facts; GMGN adds off-chain wallet-labelling (bundler / sniper /
 * rat_trader / transfer_in) that flags WHO is holding the token, not just whether
 * the mint is clean.
 *
 * CALIBRATION (live sample, 9 Sep): bare bundler presence is NOT a signal —
 * Jimothy-SOL (the backtest's 20/20-trade pool) has 6 tagged wallets too. The
 * distinguishing signals, measured across Muk (bad, caused the loss), TripleT
 * (clean open), Jimothy, ANSEM, PUMP, USELESS:
 *   1. FREE-INSIDER TOP HOLDER — holder #1 got tokens near-free (transfer_in,
 *      cost well under its position value) and sits on a huge unrealized
 *      multiple: an insider who can dump at any moment. Muk: cost $2.7k,
 *      unrealized 462x. Healthy pools' top holders either paid real money or
 *      hold at a small/negative multiple.
 *   2. BUNDLER CONCENTRATION — tagged bad wallets (bundler/sniper/rat_trader)
 *      holding >= GMGN_MAX_BAD_CONCENTRATION_PCT of supply. Muk ~9.4% across 7
 *      wallets; TripleT 3.99% across 3 (passes); Jimothy 8.17% (passes).
 *
 * FAIL-OPEN: any error, timeout, or rate-limit makes the assessment `null` and
 * the pool PASSES — this gate must never take the engine down or block a trade
 * because a third-party API hiccuped. The engine's own screens still run.
 *
 * REPORT-ONLY: `GMGN_GATE_MODE=report` (default) logs flags and never rejects;
 * `GMGN_GATE_MODE=enforce` rejects flagged pools before the LLM sees them.
 * Calibrate in report mode first, then flip to enforce.
 */
import { env } from "../config/env.js";

export type GmgnHolderTag = string;

export interface GmgnHolderRow {
  /** Share of supply, 0-100. */
  pct: number;
  tags: GmgnHolderTag[];
  /** Unrealized PnL multiple (x) — null when GMGN has no cost basis. */
  unrealizedX: number | null;
  /** Total cost paid in USD. */
  costUsd: number;
}

export interface GmgnHolderAssessment {
  /** Top holders by balance, 1-15 rows. */
  holders: GmgnHolderRow[];
  /** Wallets tagged bundler/sniper/rat_trader. */
  badWallets: GmgnHolderRow[];
  /** Sum of bad-wallet holdings, 0-100. */
  badConcentrationPct: number;
  top1: GmgnHolderRow | null;
  checkedAt: string;
}

export interface GmgnVerdict {
  /** True when the gate is in enforce mode and the pool must be rejected. */
  reject: boolean;
  /** Human-readable reasons; empty when the pool is clean. */
  reasons: string[];
  /** True when the assessment could not be completed (fail-open). */
  unavailable: boolean;
}

const BAD_TAGS = new Set(["bundler", "sniper", "rat_trader"]);
const FREE_INSIDER_UNREALIZED_MIN_X = 20;
const FREE_INSIDER_MAX_COST_USD = 10_000;

/**
 * Free-tier pacing: the holders endpoint weighs 5 against a bucket of ~20 with a
 * burst of ~4, so a scan cycle touching several pools WILL get 429-banned for 5
 * minutes if fired back-to-back (measured 9 Sep 2026: 2 requests OK, 6 requests
 * in ~30s -> RATE_LIMIT_BANNED, reset 5 min). The gate is fail-open, so a ban is
 * not an outage — it is just a blind cycle. Delay between calls keeps more pools
 * assessed before the bucket empties. Callers may still hit the ban on a heavy
 * cycle; that is accepted and logged as unavailable.
 */
const REQUEST_INTERVAL_MS = 1_500;
let lastRequestAt = 0;
async function pace(): Promise<void> {
  const wait = REQUEST_INTERVAL_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
}

/**
 * Fetch top holders for a token mint from GMGN. Returns null on any failure
 * (network, rate limit, malformed body) — callers treat null as fail-open.
 */
export async function fetchGmgnTopHolders(mint: string): Promise<GmgnHolderAssessment | null> {
  const apiKey = env.GMGN_API_KEY;
  if (!apiKey) return null;
  if (mint === "n/a" || mint.length < 30) return null;

  await pace();
  const ts = Math.floor(Date.now() / 1000);
  const url =
    `https://openapi.gmgn.ai/v1/market/token_top_holders` +
    `?chain=sol&address=${mint}&limit=15&timestamp=${ts}&client_id=${crypto.randomUUID()}`;

  try {
    const res = await fetch(url, {
      headers: { "X-APIKEY": apiKey, "User-Agent": "flowmetrix-engine/0.1" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      // 429 = rate limited; do NOT retry inside a scan cycle.
      return null;
    }
    const body = (await res.json()) as { code?: number; data?: { list?: unknown[] } };
    if (body.code !== 0 || !Array.isArray(body.data?.list)) return null;

    const holders: GmgnHolderRow[] = (body.data.list as Record<string, unknown>[])
      .map((h) => {
        const tags = Array.isArray(h.maker_token_tags)
          ? (h.maker_token_tags as string[])
          : [];
        const unrealRaw = h.unrealized_pnl;
        const unrealizedX =
          typeof unrealRaw === "number" && Number.isFinite(unrealRaw) ? unrealRaw : null;
        return {
          pct: (Number(h.amount_percentage ?? 0) || 0) * 100,
          tags,
          unrealizedX,
          costUsd: Number(h.total_cost ?? 0) || 0,
        };
      })
      .filter((h: GmgnHolderRow) => h.pct > 0);

    const badWallets = holders.filter((h) => h.tags.some((t) => BAD_TAGS.has(t)));
    return {
      holders,
      badWallets,
      badConcentrationPct: badWallets.reduce((acc, h) => acc + h.pct, 0),
      top1: holders[0] ?? null,
      checkedAt: new Date().toISOString(),
    };
  } catch {
    // Timeout / network error / abort — fail open.
    return null;
  }
}

/**
 * Judge an assessment. Pure, so it is unit-testable without the network.
 */
export function judgeGmgnHolders(
  assessment: GmgnHolderAssessment,
  thresholds: {
    maxBadConcentrationPct: number;
    mode: "report" | "enforce";
  },
): GmgnVerdict {
  const reasons: string[] = [];
  const top1 = assessment.top1;

  // Free-insider top holder: near-free acquisition + huge unrealized multiple.
  if (
    top1 &&
    top1.tags.includes("transfer_in") &&
    top1.costUsd < FREE_INSIDER_MAX_COST_USD &&
    top1.unrealizedX !== null &&
    top1.unrealizedX > FREE_INSIDER_UNREALIZED_MIN_X
  ) {
    reasons.push(
      `top holder ${top1.pct.toFixed(1)}% got tokens near-free (cost $${Math.round(top1.costUsd)}) ` +
        `at ${top1.unrealizedX.toFixed(0)}x unrealized — insider dump risk`,
    );
  }

  // Bundler concentration: tagged bad wallets above the threshold.
  if (assessment.badConcentrationPct >= thresholds.maxBadConcentrationPct) {
    reasons.push(
      `${assessment.badWallets.length} bundler/sniper/rat wallets hold ` +
        `${assessment.badConcentrationPct.toFixed(1)}% (limit ${thresholds.maxBadConcentrationPct}%)`,
    );
  }

  if (reasons.length === 0) return { reject: false, reasons: [], unavailable: false };
  return { reject: thresholds.mode === "enforce", reasons, unavailable: false };
}

/**
 * One-shot: fetch + judge. Returns a pass-through verdict on any failure.
 */
export async function assessGmgnPool(mint: string): Promise<GmgnVerdict> {
  const apiKey = env.GMGN_API_KEY;
  if (!apiKey) {
    return { reject: false, reasons: [], unavailable: true };
  }
  const assessment = await fetchGmgnTopHolders(mint);
  if (assessment === null) {
    return { reject: false, reasons: [], unavailable: true };
  }
  return judgeGmgnHolders(assessment, {
    maxBadConcentrationPct: env.GMGN_MAX_BAD_CONCENTRATION_PCT,
    mode: env.GMGN_GATE_MODE,
  });
}
