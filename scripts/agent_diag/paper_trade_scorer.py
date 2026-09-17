#!/usr/bin/env python3
"""Paper trade: skor tiap event counterfactual gate pakai aturan exit live (TP +5% / SL -8% / max 24h).

Alur:
  1. event dari DB counterfactual (pass_measured=1)  ->  kandidat paper trade
  2. pair -> pool address lewat daftar pool Meteora (mesin pencari nama)
  3. entry & exit dari bar HOURLY GeckoTerminal, bukan harga "sekarang" (biar bisa diulang ulang)
  4. exit: TP +5% / SL -8% / umur 24 jam -- aturan yang sama dengan live (TAKE_PROFIT_PCT, STOP_LOSS_PCT)
  5. PnL dihitung di DUA model biaya: LAMA (2,4444%) dan TERUKUR (1,7644%)

Aturan kejujuran (sama kayak sisi pengukuran lain):
  - entry = CLOSE bar hourly terakhir yang SUDAH SELESAI saat event terjadi. Live masuk di harga
    pasar saat itu, jadi angka ini punya galat sampai ~1 jam -- besar galatnya diukur oleh --validate.
  - kalau satu bar menyentuh TP DAN SL, yang dipakai SL (asumsi terburuk). Live polling tiap
    beberapa menit, jadi bar hourly TIDAK BISA tahu mana yang kena dulu.
  - data harga kurang -> status 'unscoreable' + alasan, BUKAN 0.

Read-only: log/DB dibaca, nol order, nol notional.
"""
import datetime
import fcntl
import json
import os
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.request

DB = os.environ.get("PAPER_DB", "/home/ubuntu/.hermes/data/gate_counterfactual.db")
REPO = "/home/ubuntu/flowmetrix-ai-agent"
ENV_FILE = f"{REPO}/.env"

NOTIONAL_SOL = 1.8
GAS_RT_FRAC = 0.008 / NOTIONAL_SOL          # 0,4444% dari notional
LEGS_MEASURED_FRAC = 0.0132                 # exit 0,91% + entry 0,41% (terukur)
SLIP_LIVE_FRAC = 0.02                       # asumsi live
COST_LIVE_FRAC = GAS_RT_FRAC + SLIP_LIVE_FRAC           # 2,4444%
COST_MEASURED_FRAC = GAS_RT_FRAC + LEGS_MEASURED_FRAC   # 1,7644%
TP_PCT, SL_PCT, MAX_AGE_H = 5.0, -8.0, 24

UA = {"User-Agent": "flowmetrix-paper-scorer/1.0"}


def env_val(key):
    if not os.path.exists(ENV_FILE):
        return None
    for line in open(ENV_FILE):
        m = re.match(rf"^{key}=(.*)$", line.strip())
        if m:
            return m.group(1).strip().strip('"').strip("'")
    return None


GT_CACHE = "/home/ubuntu/.hermes/data/gt_cache"

# GeckoTerminal membatasi laju (429). Karena engine live juga memakai kuota yang sama,
# hasilnya disimpan ke disk supaya satu pool+window tidak pernah diambil dua kali.
def http_json(url, tries=6):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=25) as fh:
                return json.loads(fh.read().decode())
        except urllib.error.HTTPError as exc:
            if exc.code == 429 and i < tries - 1:
                time.sleep(20 + 20 * i)      # 20s, 40s, 60s, 80s, 100s
                continue
            if i == tries - 1:
                raise
            time.sleep(2 + 3 * i)
        except Exception:
            if i == tries - 1:
                raise
            time.sleep(2 + 3 * i)
    return None


def gt_bars(pool_address, before_ts):
    """Bar hourly dari GeckoTerminal, urut lama -> baru: (ts, o, h, l, c). Di-cache ke disk."""
    os.makedirs(GT_CACHE, exist_ok=True)
    cache = f"{GT_CACHE}/{pool_address}_{before_ts}.json"
    if os.path.exists(cache):
        try:
            bars = json.load(open(cache))
            if bars:
                return [(int(b[0]), float(b[1]), float(b[2]), float(b[3]), float(b[4])) for b in bars]
        except Exception:
            pass
    url = (f"https://api.geckoterminal.com/api/v2/networks/solana/pools/{pool_address}"
           f"/ohlcv/hour?aggregate=1&limit=30&currency=usd&token=base&before_timestamp={before_ts}")
    raw = http_json(url)
    rows = (raw or {}).get("data", {}).get("attributes", {}).get("ohlcv_list", []) or []
    bars = sorted(((int(r[0]), float(r[1]), float(r[2]), float(r[3]), float(r[4])) for r in rows if len(r) >= 5),
                  key=lambda b: b[0])
    if bars:
        json.dump(bars, open(cache, "w"))
    return bars


def init_db():
    os.makedirs(os.path.dirname(DB), exist_ok=True)
    con = sqlite3.connect(DB)
    con.execute("""CREATE TABLE IF NOT EXISTS paper_trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        source TEXT NOT NULL,               -- counterfactual | validate_real
        pair TEXT NOT NULL,
        pool_address TEXT,
        event_time TEXT,                    -- waktu event (UTC)
        entry_ref_time TEXT,                -- waktu bar yang dipakai jadi entry
        entry_price REAL,
        tp_price REAL, sl_price REAL,
        exit_time TEXT, exit_price REAL, exit_reason TEXT,
        bars_total INTEGER, bars_used INTEGER,
        gross_pct REAL, net_pct_live REAL, net_pct_measured REAL,
        net_usd_live REAL, net_usd_measured REAL,
        notional_usd REAL, fee_usd_at_event REAL, ratio_measured REAL,
        actual_reason TEXT, actual_pct REAL,   -- cuma utk source=validate_real
        attempts INTEGER NOT NULL DEFAULT 0, -- berapa kali gagal di-skor (biar tidak dihajar terus)
        status TEXT NOT NULL,               -- pending | scored | unscoreable
        note TEXT
    )""")
    have = {r[1] for r in con.execute("pragma table_info(paper_trades)")}
    for col in ("net_usd_live", "net_usd_measured", "attempts"):   # DB lama: tambah kolom tanpa migrasi manual
        if col not in have:
            con.execute(f"ALTER TABLE paper_trades ADD COLUMN {col} "
                        + ("INTEGER NOT NULL DEFAULT 0" if col == "attempts" else "REAL"))
    con.execute("CREATE INDEX IF NOT EXISTS idx_pt_pool ON paper_trades(pool_address, event_time)")
    con.commit()
    return con


# ------------------------------------------------------------------ pool address

def resolve_addresses(con, names):
    """pair name -> pool address, dari listing Meteora. Ambil TVL terbesar kalau nama kembar."""
    base = env_val("METEORA_API_URL")
    if not base:
        return {}
    out = {}
    page = 1
    while page <= 8:
        url = f"{base}/pools?page={page}&page_size=200"
        try:
            raw = http_json(url)
        except Exception:
            break
        if not raw:
            break
        rows = raw.get("data") if isinstance(raw, dict) else raw
        if not rows:
            break
        for p in rows:
            nm = p.get("name")
            if nm in names:
                tvl = p.get("tvl") or 0
                if nm not in out or tvl > out[nm][1]:
                    out[nm] = (p.get("address"), tvl)
        if page >= (raw.get("pages") or 1):
            break
        page += 1
    return {k: v[0] for k, v in out.items()}


# ------------------------------------------------------------------ harga

def tou(ts):
    return datetime.datetime.utcfromtimestamp(ts)


def simulate(bars, entry_ref_ts, entry_price):
    """Jalan bar demi bar: TP, SL, atau umur. SL menang kalau satu bar menyentuh dua-duanya."""
    tp = entry_price * (1 + TP_PCT / 100)
    sl = entry_price * (1 + SL_PCT / 100)
    deadline = entry_ref_ts + MAX_AGE_H * 3600
    used = 0
    last = None
    for ts, _o, high, low, close in bars:
        if ts <= entry_ref_ts:
            continue
        if ts > deadline:
            break
        used += 1
        last = (ts, close)
        if low <= sl and high >= tp:
            # satu bar menyentuh dua-duanya: urutan intra-bar tak diketahui -> ambil yang lebih buruk
            return sl, sl, "stop-loss (bar sentuh TP+SL; exit diasumsikan di SL)", ts, used
        if low <= sl:
            return sl, sl, "stop-loss", ts, used
        if high >= tp:
            return tp, sl, "take-profit", ts, used
    if last:
        return last[1], sl, f"umur {MAX_AGE_H} jam habis (exit di close bar terakhir)", last[0], used
    # PENTING: tidak ada bar setelah entry -> TIDAK bisa dinilai. Jangan pernah balikin harga TP
    # (dulu baris ini bisa nulis +5,00% palsu).
    return None, sl, "tidak ada bar hourly setelah event (data GT bolong / pool mati)", None, used


def new_row(con, **kw):
    cols = ",".join(kw)
    ph = ",".join("?" * len(kw))
    cur = con.execute(f"INSERT INTO paper_trades ({cols}) VALUES ({ph})", tuple(kw.values()))
    con.commit()
    return cur.lastrowid


# ------------------------------------------------------------------ mode

def cmd_create(con, limit=6):
    now = datetime.datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    ev = con.execute("""select pair, collected_at, fee24h_usd, ratio_measured, cost_live_usd from observations
                        where pass_measured=1 and collected_at >= datetime('now','-3 days')
                        order by collected_at desc, rowid desc""").fetchall()
    # cooldown 24 jam per pool: pool yang sama boleh di-paper-trade lagi setelah trade sebelumnya tutup
    recent = {r[0] for r in con.execute(
        "select pair from paper_trades where event_time >= datetime('now','-24 hours')")}
    todo, taken = [], set()
    for e in [x for x in ev if x[0] not in recent]:      # ambil 1 event per pool (yang paling baru)
        if e[0] in taken:
            continue
        taken.add(e[0])
        todo.append(e)
        if len(todo) >= limit:
            break
    if not todo:
        return 0
    addr = resolve_addresses(con, {e[0] for e in todo})
    # batch seed = event dari backfill log (semua ber-collected_at paling awal) -> event_time bukan waktu asli
    oldest = con.execute("select min(collected_at) from observations").fetchone()[0]
    made = 0
    seen = set()
    for pair, when, fee, ratio, cost_live in todo:
        if pair in seen:
            continue
        seeded = (when == oldest)
        # notional di event itu = cost_live / 2,4444% (dari angka engine sendiri)
        notional = (cost_live / COST_LIVE_FRAC) if cost_live else None
        if not addr.get(pair):
            new_row(con, created_at=now, source="counterfactual", pair=pair, pool_address=None,
                    event_time=when, status="unscoreable", notional_usd=notional,
                    note="pool address tidak ketemu di listing Meteora", fee_usd_at_event=fee,
                    ratio_measured=ratio)
            seen.add(pair)
            continue
        new_row(con, created_at=now, source="counterfactual", pair=pair, pool_address=addr[pair],
                event_time=when, status="pending", fee_usd_at_event=fee, ratio_measured=ratio,
                notional_usd=notional, entry_ref_time=None,
                note=("paper dari event counterfactual (event_time = waktu catat; log pm2 asli tak ada timestamp)"
                      if seeded else
                      "paper trade dari event counterfactual; harga entry dipakai saat scoring"))
        seen.add(pair)
        made += 1
    return made


def cmd_score(con, limit=3):     # 3 pool per run: jaga kuota GeckoTerminal (engine live pakai kuota sama)
    notional_cache = dict(con.execute("select id, notional_usd from paper_trades").fetchall())
    rows = con.execute("""select id, pair, pool_address, event_time, source, entry_price, actual_reason, actual_pct
                          from paper_trades
                          where status='pending' and pool_address is not null
                            and event_time <= datetime('now','-25 hours')
                          order by event_time limit ?""", (limit,)).fetchall()
    def bump(con, tid, why):
        """catat percobaan gagal; habis 5x jangan dihajar terus (jaga kuota GeckoTerminal)."""
        n = con.execute("select attempts from paper_trades where id=?", (tid,)).fetchone()[0] + 1
        done = n >= 5
        con.execute("""update paper_trades set attempts=?, status=?, note=coalesce(note,'')||' | '||? where id=?""",
                    (n, "unscoreable" if done else "pending",
                     f"{why} (percobaan {n})" + (" -> menyerah" if done else ""), tid))
        con.commit()

    scored = 0
    for tid, pair, pool, when, source, fixed_entry, _ar, _ap in rows:
        t_event = int(datetime.datetime.strptime(when, "%Y-%m-%d %H:%M:%S")
                      .replace(tzinfo=datetime.timezone.utc).timestamp())
        try:
            bars = gt_bars(pool, t_event + 26 * 3600)
        except Exception as exc:
            bump(con, tid, f"GT gagal: {exc}")
            time.sleep(2)
            continue
        prior = [b for b in bars if b[0] <= t_event]
        if not prior:
            bump(con, tid, "tidak ada bar hourly sebelum event (pool baru / data GT kosong)")
            time.sleep(1.2)
            continue
        entry_ref_ts, entry_price = prior[-1][0], fixed_entry or prior[-1][4]
        exit_price, _sl, reason, exit_ts, used = simulate(bars, t_event, entry_price)
        if exit_price is None or exit_ts is None:
            con.execute("""update paper_trades set status='unscoreable', attempts=attempts+1,
                note=coalesce(note,'')||' | '||? where id=?""", (reason, tid))
            con.commit()
            continue
        gross = (exit_price / entry_price - 1) * 100
        con.execute("""update paper_trades set status='scored', entry_price=?, entry_ref_time=?,
            tp_price=?, sl_price=?, exit_price=?, exit_time=?, exit_reason=?, bars_total=?, bars_used=?,
            gross_pct=?, net_pct_live=?, net_pct_measured=?,
            net_usd_live=?, net_usd_measured=?, note=coalesce(note,'')||? where id=?""",
            (entry_price, tou(entry_ref_ts).strftime("%Y-%m-%d %H:%M:%S"),
             entry_price * (1 + TP_PCT / 100), entry_price * (1 + SL_PCT / 100),
             exit_price, tou(exit_ts).strftime("%Y-%m-%d %H:%M:%S") if exit_ts else None,
             reason, len(bars), used, gross,
             gross - COST_LIVE_FRAC * 100, gross - COST_MEASURED_FRAC * 100,
             (gross - COST_LIVE_FRAC * 100) / 100 * (notional_cache.get(tid) or 0),
             (gross - COST_MEASURED_FRAC * 100) / 100 * (notional_cache.get(tid) or 0),
             " | exit = TP/SL/umur dari bar hourly; SL menang kalau satu bar kena dua-duanya", tid))
        con.commit()
        scored += 1
        time.sleep(1.2)          # sopan ke rate limit GeckoTerminal
    return scored


def cmd_validate(con):
    """Skor 7 trade LIVE nyata dengan mesin yang sama, lalu bandingkan ke hasil sebenarnya."""
    live = sqlite3.connect(f"file:{REPO}/data/flowmetrix.db?mode=ro", uri=True)
    rows = live.execute("""select pair_name, pool_address, opened_at, entry_price, exit_price,
                                  close_reason, realized_pnl_pct from simulated_positions
                           where execution_mode='LIVE' and pool_address is not null order by opened_at""").fetchall()
    con.execute("delete from paper_trades where source='validate_real'")
    con.commit()
    print(f"{'pair':13} {'paper':10} {'actual':10} {'paper%':>8} {'actual%':>8} {'galat':>7}  harga entry")
    errs = []
    for pair, pool, opened, entry_db, exit_db, reason, pnl in rows:
        t_event = int(datetime.datetime.strptime(opened, "%Y-%m-%d %H:%M:%S")
                      .replace(tzinfo=datetime.timezone.utc).timestamp())
        bars = gt_bars(pool, t_event + 26 * 3600)
        prior = [b for b in bars if b[0] <= t_event]
        if not prior:
            print(f"{pair:13} BAR KOSONG")
            continue
        entry_px = prior[-1][4]
        exit_price, _sl, why, exit_ts, used = simulate(bars, t_event, entry_px)
        gross = (exit_price / entry_px - 1) * 100
        short = re.sub(r" \(.*", "", reason or "")
        paper_short = "take-profit" if why.startswith("take-profit") else ("stop-loss" if why.startswith("stop-loss") else "umur")
        errs.append(abs(gross - (pnl or 0)))
        new_row(con, created_at=datetime.datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
                source="validate_real", pair=pair, pool_address=pool, event_time=opened,
                entry_ref_time=tou(prior[-1][0]).strftime("%Y-%m-%d %H:%M:%S"), entry_price=entry_px,
                tp_price=entry_px * (1 + TP_PCT / 100), sl_price=entry_px * (1 + SL_PCT / 100),
                exit_price=exit_price, exit_time=tou(exit_ts).strftime("%Y-%m-%d %H:%M:%S") if exit_ts else None,
                exit_reason=why, bars_total=len(bars), bars_used=used, gross_pct=gross,
                net_pct_live=gross - COST_LIVE_FRAC * 100, net_pct_measured=gross - COST_MEASURED_FRAC * 100,
                actual_reason=short, actual_pct=pnl, status="scored",
                note=f"validasi: entry_db {entry_db:.8f} vs bar {entry_px:.8f}")
        print(f"{pair:13} {paper_short:10} {short[:10]:10} {gross:7.2f}% {pnl:7.2f}% {gross-(pnl or 0):+6.2f}  db {entry_db:.8f} vs bar {entry_px:.8f}")
        time.sleep(1.2)
    if errs:
        errs.sort()
        print(f"\nverdict cocok: {sum(1 for r in rows)} trade diuji · galat abs median {errs[len(errs)//2]:.2f} pts · maks {errs[-1]:.2f} pts")
    return len(rows)


def cmd_summary(con):
    tot = con.execute("select count(*) from paper_trades where source='counterfactual'").fetchone()[0]
    st = dict(con.execute("select status, count(*) from paper_trades where source='counterfactual' group by 1").fetchall())
    print(f"paper trade counterfactual: {tot} · {st}")
    rows = con.execute("""select pair, count(*) n, sum(exit_reason like 'take-profit%') tp, sum(exit_reason like 'stop-loss%') sl,
                          round(avg(net_pct_live),2) net_live, round(avg(net_pct_measured),2) net_measured
                          from paper_trades where source='counterfactual' and status='scored' group by pair
                          order by net_measured desc""").fetchall()
    if not rows:
        print("belum ada yang scored (butuh >= 25 jam setelah event)")
        return
    print(f"\n{'pool':14} {'n':>3} {'TP':>3} {'SL':>3} {'net LAMA':>9} {'net TERUKUR':>12}")
    for p, n, tp, sl, nl, nm in rows:
        print(f"{p:14} {n:3} {tp or 0:3} {sl or 0:3} {nl or 0:8.2f}% {nm or 0:11.2f}%")
    agg = con.execute("""select count(*), round(avg(gross_pct),2), round(avg(net_pct_live),2), round(avg(net_pct_measured),2)
                         from paper_trades where source='counterfactual' and status='scored'""").fetchone()
    print(f"\nagregat: n={agg[0]} · gross rata2 {agg[1]}% · net LAMA {agg[2]}% · net TERUKUR {agg[3]}%")
    print("angka ini hasil paper trade, BUKAN hasil live; entry pakai close bar hourly (galat ~1 jam).")


LOCK = "/tmp/paper_trade_scorer.lock"


def acquire_lock():
    """Cuma 1 proses boleh jalan: cron 30 menit bisa tumpang-tindih kalau GT balas 429 terus."""
    fh = open(LOCK, "w")
    try:
        fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        print("[paper] run sebelumnya masih jalan — dilewati", file=sys.stderr)
        return None
    fh.write(str(os.getpid()))
    fh.flush()
    return fh


if __name__ == "__main__":
    _lock = acquire_lock()
    if _lock is None:
        sys.exit(0)
    con = init_db()
    mode = sys.argv[1] if len(sys.argv) > 1 else "run"
    if mode == "--validate":
        cmd_validate(con)
    elif mode == "--summary":
        cmd_summary(con)
    else:
        made = cmd_create(con)
        done = cmd_score(con)
        if made or done:
            print(f"[paper] kandidat baru {made} · di-skor {done}")
            cmd_summary(con)
