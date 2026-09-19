/**
 * READ-ONLY reader for the OPERATOR'S MANUAL LP positions (see
 * `~/.hermes/data/fm_manual_positions.json`).
 *
 * WHY. The operator runs LP by hand in the same wallet the engine signs with, and Meteora
 * DLMM has NO native take-profit / stop-loss: a position is exited by removing liquidity,
 * so without an outside keeper the exit happens whenever a human happens to look. This
 * script is the read half of that keeper — it prints the live state of every registered
 * manual position (bin range, active bin, amounts, unclaimed fees, current value in SOL)
 * as JSON so `fm_manual_lp_monitor.py` can decide whether a threshold was crossed.
 *
 * NOTHING HERE SIGNS. Read-only, no key material, no transactions.
 *
 * Usage: node --env-file=.env --import tsx scripts/manualLpState.ts
 */
import { createRequire } from "node:module";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const { Connection, PublicKey } = require("@solana/web3.js");
const dlmmPkg = require("@meteora-ag/dlmm");
const DLMM = dlmmPkg.default ?? dlmmPkg;

const WSOL = "So11111111111111111111111111111111111111112";
const REGISTRY =
  process.env.FM_MANUAL_POSITIONS || `${process.env.HOME}/.hermes/data/fm_manual_positions.json`;

type RegistryPosition = {
  label?: string;
  position?: string;
  pool?: string;
  capital_sol?: number | string;
  rent_sol?: number | string;
};

const registry: { positions?: RegistryPosition[] } = JSON.parse(
  fs.readFileSync(REGISTRY, "utf8"),
);
const rpc = process.env.SOLANA_RPC_URL;
if (!rpc) {
  console.error("SOLANA_RPC_URL missing");
  process.exit(2);
}
const conn = new Connection(rpc, "confirmed");

const num = (v: unknown): number | null => {
  try {
    const source = v as { toString?: () => string } | null | undefined;
    return Number(source?.toString?.() ?? v);
  } catch {
    return null;
  }
};

/**
 * UI units from base units, NaN when the base amount could not be read.
 *
 * NaN rather than 0 on purpose: `0` is a claim about the position's contents, and it would
 * flow into the value and the P&L as if the position were empty. NaN propagates and the
 * caller turns a non-finite value into `null`, which is what "not measured" means here.
 */
const ui = (v: unknown, decimals: number): number => {
  const n = num(v);
  return n === null ? Number.NaN : n / 10 ** decimals;
};

type PositionState = {
  lowerBinId: number;
  upperBinId: number;
  amountX: number;
  amountY: number;
  feeX: number;
  feeY: number;
  lastUpdatedAt: unknown;
};

const out: Record<string, unknown>[] = [];
for (const p of registry.positions ?? []) {
  const entry = {
    label: p.label ?? "LP manual",
    position: p.position,
    pool: p.pool,
    capital_sol: num(p.capital_sol),
    rent_sol: num(p.rent_sol),
  };
  try {
    const pool = await DLMM.create(conn, new PublicKey(String(p.pool)));
    const active = await pool.getActiveBin();
    const decX = pool.tokenX?.mint?.decimals;
    const decY = pool.tokenY?.mint?.decimals;
    const mintX = pool.tokenX?.publicKey?.toBase58?.() ?? null;
    const mintY = pool.tokenY?.publicKey?.toBase58?.() ?? null;

    let state: PositionState | null = null;
    let stateError: string | null = null;
    try {
      const read = await pool.getPosition(new PublicKey(String(p.position)));
      const d = read.positionData;
      state = {
        lowerBinId: Number(d.lowerBinId),
        upperBinId: Number(d.upperBinId),
        amountX: ui(d.totalXAmount, decX ?? 0),
        amountY: ui(d.totalYAmount, decY ?? 0),
        feeX: ui(d.feeX, decX ?? 0),
        feeY: ui(d.feeY, decY ?? 0),
        lastUpdatedAt: d.lastUpdatedAt ?? null,
      };
    } catch (e) {
      stateError = String((e as { message?: string } | null)?.message ?? e).slice(0, 300);
    }

    // Value in SOL: the SOL side is exact; the token side is marked at the active bin price
    // (the same public price the pool itself would trade at). Approximation, and stated as
    // one: bin prices are stepwise, so this is not a mid-price mark.
    const priceYperX = num(active.price); // Y (SOL) per X, in UI units, at the active bin
    let valueSol: number | null = null;
    if (state && priceYperX) {
      const solSideMint = mintY === WSOL ? "Y" : mintX === WSOL ? "X" : null;
      const sumY = state.amountY + state.feeY;
      const sumX = state.amountX + state.feeX;
      const marked =
        solSideMint === "Y" ? sumY + sumX * priceYperX : solSideMint === "X" ? sumX + sumY / priceYperX : Number.NaN;
      // `Number.isFinite`, not a null check: a NaN from an unreadable amount must land as
      // "not measured", never as a value the keeper thresholds against.
      valueSol = Number.isFinite(marked) ? marked : null;
    }

    const inRange =
      state !== null ? active.binId >= state.lowerBinId && active.binId <= state.upperBinId : null;

    out.push({
      ...entry,
      ok: true,
      pair: `${pool.tokenX?.mint?.symbol ?? "X"}-${pool.tokenY?.mint?.symbol ?? "Y"}`,
      mintX,
      mintY,
      binStep: num(pool.lbPair?.binStep),
      activeBinId: active.binId,
      activePrice: priceYperX,
      inRange,
      binsBelow: state ? active.binId - state.lowerBinId : null,
      binsAbove: state ? state.upperBinId - active.binId : null,
      state: state ?? { error: stateError },
      valueSol,
      pnlSol: valueSol !== null && entry.capital_sol ? valueSol - entry.capital_sol : null,
      pnlPct:
        valueSol !== null && entry.capital_sol
          ? ((valueSol - entry.capital_sol) / entry.capital_sol) * 100
          : null,
    });
  } catch (e) {
    out.push({
      ...entry,
      ok: false,
      error: String((e as { message?: string } | null)?.message ?? e).slice(0, 300),
    });
  }
}

console.log(JSON.stringify({ at: new Date().toISOString(), positions: out }, null, 2));
process.exit(0);
