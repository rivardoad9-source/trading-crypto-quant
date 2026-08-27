import type { PositionStatus, StrategyType } from "../config/constants.js";

export interface SimulatedPositionRow {
  id: number;
  position_id: string;
  pool_address: string;
  pair_name: string;
  strategy_type: StrategyType;
  entry_price: number;
  lower_bin_price: number;
  upper_bin_price: number;
  virtual_sol_amount: number;
  entry_tvl: number | null;
  entry_24h_volume: number | null;
  status: PositionStatus;
  unclaimed_fee_usd: number;
  realized_pnl_usd: number;
  realized_pnl_pct: number;
  opened_at: string;
  closed_at: string | null;
  exit_price: number | null;
  reasoning_log: string | null;
  confidence_score: number | null;
  last_checked_at: string | null;
  current_price: number | null;
  impermanent_loss_usd: number | null;
  floating_pnl_usd: number | null;
  entry_sol_price_usd: number | null;
  close_reason: string | null;
  /* Anti-rug screen, captured at entry. SQLite has no boolean: 1 / 0 / null. */
  top10_holder_pct: number | null;
  mint_authority_revoked: number | null;
  freeze_authority_revoked: number | null;
  safety_verdict: string | null;
  /* Priority-fee estimate captured at entry. */
  est_gas_cost_usd: number | null;
  est_priority_micro_lamports: number | null;
  /* Post-trade reflection. */
  post_mortem: string | null;
  post_mortem_at: string | null;
  /** LP value change vs capital deployed — the account-moving figure. */
  position_value_change_usd: number | null;
  breakeven_coverage_ratio: number | null;
  expected_fee_24h_usd: number | null;
}

export interface DailyResearchRow {
  id: number;
  report_date: string;
  raw_macro_json: string | null;
  markdown_output: string;
  created_at: string;
  sentiment_bias: string | null;
}

export interface DailyPnlSnapshotRow {
  id: number;
  date: string;
  total_trades_closed: number;
  winning_trades: number;
  losing_trades: number;
  net_pnl_usd: number;
  net_pnl_sol: number;
  updated_at: string;
}

export interface NewPositionInput {
  positionId: string;
  poolAddress: string;
  pairName: string;
  strategyType: StrategyType;
  entryPrice: number;
  lowerBinPrice: number;
  upperBinPrice: number;
  virtualSolAmount: number;
  entryTvl: number;
  entry24hVolume: number;
  confidenceScore: number;
  reasoningLog: string;
  entrySolPriceUsd: number;
  /**
   * Anti-rug screen results. null means the check could not be run — distinct from
   * false, which means it ran and the authority is still live. Optional so seeds and
   * tests can omit them; the trading agent always supplies them.
   */
  top10HolderPct?: number | null;
  mintAuthorityRevoked?: boolean | null;
  freezeAuthorityRevoked?: boolean | null;
  safetyVerdict?: string | null;
  /* Estimated round-trip Solana transaction cost (open + close). */
  estGasCostUsd?: number | null;
  estPriorityMicroLamports?: number | null;
  /* Friction gate recorded at entry. */
  breakevenCoverageRatio?: number | null;
  expectedFee24hUsd?: number | null;
}

export interface PositionUpdateInput {
  positionId: string;
  currentPrice: number;
  unclaimedFeeUsd: number;
  /** Divergence vs hold. Diagnostic only. */
  impermanentLossUsd: number;
  /** LP value change vs capital. This drives floating PnL. */
  positionValueChangeUsd: number;
  floatingPnlUsd: number;
}

export interface ClosePositionInput {
  positionId: string;
  status: PositionStatus;
  exitPrice: number;
  realizedPnlUsd: number;
  realizedPnlPct: number;
  unclaimedFeeUsd: number;
  /** Divergence vs hold. Diagnostic only. */
  impermanentLossUsd: number;
  /** LP value change vs capital. realizedPnlUsd = fees + this. */
  positionValueChangeUsd: number;
  closeReason: string;
}
