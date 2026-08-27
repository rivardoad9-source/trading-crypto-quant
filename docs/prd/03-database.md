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
    status TEXT NOT NULL,                 -- 'ACTIVE' | 'CLOSED_PROFIT' | 'CLOSED_OUT_OF_RANGE' | 'CLOSED_TIMEOUT'
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