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

-- Columns added after the initial schema are handled by the migration step in db.ts,
-- so a pre-existing database is upgraded in place rather than recreated. Those include
-- the anti-rug screen (top10_holder_pct, mint_authority_revoked, freeze_authority_revoked,
-- safety_verdict), the priority-fee estimate (est_gas_cost_usd,
-- est_priority_micro_lamports) and the post-trade reflection (post_mortem,
-- post_mortem_at).

CREATE INDEX IF NOT EXISTS idx_positions_status    ON simulated_positions(status);
CREATE INDEX IF NOT EXISTS idx_positions_pool      ON simulated_positions(pool_address);
CREATE INDEX IF NOT EXISTS idx_positions_closed_at ON simulated_positions(closed_at);
CREATE INDEX IF NOT EXISTS idx_positions_opened_at ON simulated_positions(opened_at);
CREATE INDEX IF NOT EXISTS idx_research_date       ON daily_research_logs(report_date);
CREATE INDEX IF NOT EXISTS idx_snapshot_date       ON daily_pnl_snapshots(date);
