-- FlowMetrix / Meteora AI Engine — SQLite schema
-- Applied idempotently on boot by src/database/db.ts.

PRAGMA foreign_keys = ON;

-- Menyimpan riwayat riset makro harian
CREATE TABLE IF NOT EXISTS daily_research_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_date TEXT NOT NULL UNIQUE,
    raw_macro_json TEXT,
    markdown_output TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Menyimpan posisi simulasi (Paper Trading) DLMM
CREATE TABLE IF NOT EXISTS simulated_positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    position_id TEXT UNIQUE NOT NULL,
    pool_address TEXT NOT NULL,
    pair_name TEXT NOT NULL,
    strategy_type TEXT NOT NULL,          -- 'SPOT' | 'BID_ASK' | 'CURVE'
    entry_price REAL NOT NULL,
    lower_bin_price REAL NOT NULL,
    upper_bin_price REAL NOT NULL,
    virtual_sol_amount REAL NOT NULL,     -- e.g. 1.0 SOL
    entry_tvl REAL,
    entry_24h_volume REAL,
    status TEXT NOT NULL,                 -- 'ACTIVE' | 'CLOSED_PROFIT' | 'CLOSED_LOSS' | 'CLOSED_OUT_OF_RANGE' | 'CLOSED_TIMEOUT'
    unclaimed_fee_usd REAL DEFAULT 0.0,
    realized_pnl_usd REAL DEFAULT 0.0,
    realized_pnl_pct REAL DEFAULT 0.0,
    opened_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    closed_at DATETIME,
    exit_price REAL,
    reasoning_log TEXT
);

-- Snapshot harian untuk Calendar Heatmap PnL
CREATE TABLE IF NOT EXISTS daily_pnl_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT UNIQUE NOT NULL,            -- 'YYYY-MM-DD'
    total_trades_closed INTEGER DEFAULT 0,
    winning_trades INTEGER DEFAULT 0,
    losing_trades INTEGER DEFAULT 0,
    net_pnl_usd REAL DEFAULT 0.0,
    net_pnl_sol REAL DEFAULT 0.0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- One row per screener cycle: the full entry funnel, from pools fetched to the
-- decision. Diagnostic only — nothing in the trading path reads it back.
--
-- It exists because the funnel was previously reconstructible only by parsing PM2
-- stdout, and the one step that mattered most was not in the log at all: `screenPools`
-- computed its rejection buckets and `seekNewEntry` discarded them, so the 600 -> ~20
-- narrowing could only be quoted as a nominal figure. `screen_rejections` is the JSON
-- of that bucket map; it is JSON rather than columns because the bucket list is the
-- screener's business and will grow with it, and a schema change per new gate would
-- make adding a gate needlessly expensive.
--
-- NULL is not zero here either: `scanned` is NULL when the cycle never reached the
-- screener (paused, or at capacity), which is a different fact from "scanned nothing".
CREATE TABLE IF NOT EXISTS scan_funnel_cycles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cycle_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    scanned INTEGER,
    screen_rejections TEXT,               -- JSON: {"lowTvl": 412, "highTvl": 9, ...}
    -- Survivors of the quantitative screen ALONE. Reconciles against the two columns
    -- above, whose buckets are exhaustive: scanned - sum(screen_rejections).
    screener_candidates INTEGER,
    held_excluded INTEGER DEFAULT 0,      -- dropped for already holding that pool
    -- Pools that survived EVERY local filter and reached the anti-rug screen. This is
    -- the LAST step of the narrowing, not the first: it is screener_candidates minus
    -- held_excluded, cooldown_rejected and execution_rejected. It was documented here
    -- as "survivors after the quantitative screen" and is not that, which is what made
    -- a row reading candidates=4 alongside execution_rejected=26 look like corruption.
    candidates INTEGER DEFAULT 0,
    cooldown_rejected INTEGER DEFAULT 0,
    antirug_passed INTEGER DEFAULT 0,
    antirug_rejected INTEGER DEFAULT 0,
    volatility_rejected INTEGER DEFAULT 0,
    coverage_rejected INTEGER DEFAULT 0,  -- the 2.5x MIN_FEE_COST_COVERAGE gate
    micro_rejected INTEGER DEFAULT 0,     -- the live $1.50 net-PnL floor
    reached_decision INTEGER DEFAULT 0,   -- 1 when the LLM was actually consulted
    opened INTEGER DEFAULT 0,
    skip_reason TEXT,
    positions_checked INTEGER DEFAULT 0,
    positions_closed INTEGER DEFAULT 0,
    duration_ms INTEGER
);

-- Columns added after the initial schema are handled by the migration step in db.ts,
-- so a pre-existing database is upgraded in place rather than recreated. Those include
-- the anti-rug screen (top10_holder_pct, mint_authority_revoked, freeze_authority_revoked,
-- safety_verdict), the priority-fee estimate (est_gas_cost_usd,
-- est_priority_micro_lamports) and the post-trade reflection (post_mortem,
-- post_mortem_at).

-- Execution-failure breaker (live path only).
--
-- Deliberately NOT the same thing as the V1.1 cooldown/lockout, which is reconstructed
-- from closed simulated_positions rows and counts failed EXITS. A failed OPEN never
-- writes a position row — "the chain decides, the database records" — so that gate is
-- blind to it by construction. On 7 Sep 2026 one pool was therefore re-elected every
-- 30 minutes and spent real money twice before an operator added a manual denylist
-- entry. This table is the automatic version of that intervention: it answers "can the
-- engine OPEN this pool at all", which is a different question from "did the last
-- trade on it go well".
--
-- One row per pool, upserted. `consecutive_failures` resets to 0 on a confirmed open.
CREATE TABLE IF NOT EXISTS pool_execution_failures (
    pool_address         TEXT PRIMARY KEY,
    pair_name            TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    last_failure_at      DATETIME,
    last_stage           TEXT,               -- rehearsal | swap | open | fund | unknown
    last_reason          TEXT,
    total_failures       INTEGER NOT NULL DEFAULT 0,
    last_success_at      DATETIME
);

CREATE INDEX IF NOT EXISTS idx_positions_status    ON simulated_positions(status);
CREATE INDEX IF NOT EXISTS idx_positions_pool      ON simulated_positions(pool_address);
CREATE INDEX IF NOT EXISTS idx_positions_closed_at ON simulated_positions(closed_at);
CREATE INDEX IF NOT EXISTS idx_positions_opened_at ON simulated_positions(opened_at);
CREATE INDEX IF NOT EXISTS idx_research_date       ON daily_research_logs(report_date);
CREATE INDEX IF NOT EXISTS idx_snapshot_date       ON daily_pnl_snapshots(date);
CREATE INDEX IF NOT EXISTS idx_funnel_cycle_at     ON scan_funnel_cycles(cycle_at);
