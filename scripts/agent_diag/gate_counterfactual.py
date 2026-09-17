#!/usr/bin/env python3
"""Counterfactual gate: pool mana yang BAKAL lolos kalau bar-nya pakai biaya terukur.

Sumber: log engine sendiri, baris `[friction] rejected <pair>: 24h fee $X covers round-trip
cost $Y only Rx (need 2.5x)` — angka milik engine, jadi tidak ada reimplementasi funnel.

Model biaya:
  LAMA  (live)   : cost = N x (gas 0,4444% + slippage 2,00%)  = N x 2,4444%
  BARU  (terukur): cost = N x (gas 0,4444% + exit 0,91% + entry 0,41%) = N x 1,7644%
  => cost_baru / cost_lama = 0,72183   (gas 0,008 SOL & notional 1,8 SOL, rasionya tetap)

Jadi: fee yang dibutuhkan di model terukur = 2,5 x cost_lama x 0,72183 = 1,80458 x cost_lama.
Read-only: log engine dibaca, tulisannya cuma ke DB sendiri. Nol notional, nol order.
"""
import os, re, sqlite3, sys, datetime, collections

LOG = "/home/ubuntu/.pm2/logs/flowmetrix-engine-error.log"
DB = "/home/ubuntu/.hermes/data/gate_counterfactual.db"
STATE = "/home/ubuntu/.hermes/data/gate_counterfactual.state"

COST_RATIO = 0.72183          # cost model terukur / cost model live
NEED = 2.5                    # multiplier, tidak diubah
NEED_MEASURED_FACTOR = NEED * COST_RATIO   # 1,80458 x cost_lama

PAT = re.compile(
    r"\[friction\] rejected (?P<pair>[^:]+): (?P<hours>\d+)h fee \$(?P<fee>[\d.]+) "
    r"covers round-trip cost \$(?P<cost>[\d.]+) only (?P<ratio>[\d.]+)x \(need (?P<need>[\d.]+)x\)"
)


def init_db():
    os.makedirs(os.path.dirname(DB), exist_ok=True)
    con = sqlite3.connect(DB)
    con.execute("""CREATE TABLE IF NOT EXISTS observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        collected_at TEXT NOT NULL,
        pair TEXT NOT NULL,
        hour_window INTEGER,
        fee24h_usd REAL,
        cost_live_usd REAL,
        ratio_live REAL,
        need_live REAL,
        cost_measured_usd REAL,
        need_measured_usd REAL,
        ratio_measured REAL,
        pass_live INTEGER,
        pass_measured INTEGER,
        raw TEXT
    )""")
    con.execute("CREATE INDEX IF NOT EXISTS idx_pair ON observations(pair, collected_at)")
    con.commit()
    return con


def parse_log(offset):
    """Baca mulai offset; balikin (baris_baru, offset_baru)."""
    if not os.path.exists(LOG):
        return [], offset
    size = os.path.getsize(LOG)
    if offset > size:            # log diputar/dipotong -> mulai dari awal
        offset = 0
    out = []
    with open(LOG, "r", errors="replace") as fh:
        fh.seek(offset)
        for line in fh:
            out.append(line.rstrip("\n"))
        new_offset = fh.tell()
    return out, new_offset


def rows_from_lines(lines, now):
    rows = []
    for ln in lines:
        m = PAT.search(ln)
        if not m:
            continue
        fee = float(m.group("fee"))
        cost = float(m.group("cost"))
        need_m = NEED_MEASURED_FACTOR * cost
        rows.append((
            now, m.group("pair").strip(), int(m.group("hours")), fee, cost,
            # rasio dihitung ulang dari fee/cost: teks log dibulatkan ("2.50x" bisa aslinya 2,4978)
            (fee / cost if cost else None), float(m.group("need")),
            cost * COST_RATIO, need_m, fee / (cost * COST_RATIO) if cost else None,
            1 if fee >= NEED * cost else 0,
            1 if fee >= need_m else 0,
            ln[-300:],
        ))
    return rows


def insert(con, rows):
    con.executemany("""INSERT INTO observations
        (collected_at,pair,hour_window,fee24h_usd,cost_live_usd,ratio_live,need_live,
         cost_measured_usd,need_measured_usd,ratio_measured,pass_live,pass_measured,raw)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""", rows)
    con.commit()


def summary(con, since_hours=None):
    where, args = "", ()
    if since_hours:
        where = "WHERE collected_at >= datetime('now', ?)"
        args = (f"-{since_hours} hours",)
    tot, pairs = con.execute(f"select count(*), count(distinct pair) from observations {where}", args).fetchone()
    pm = con.execute(f"select count(*) from observations {where} {'AND' if where else 'WHERE'} pass_measured=1", args).fetchone()[0]
    pl = con.execute(f"select count(*) from observations {where} {'AND' if where else 'WHERE'} pass_live=1", args).fetchone()[0]
    print(f"observasi {tot} · pool unik {pairs} · lolos model LAMA {pl} · lolos model TERUKUR {pm}")
    top = con.execute(f"""select pair, count(*) n, sum(pass_measured) pm, max(ratio_measured) best_ratio,
        max(fee24h_usd) best_fee from observations {where}
        group by pair order by pm desc, best_ratio desc limit 14""", args).fetchall()
    print(f"\n{'pool':16} {'observasi':>9} {'lolos terukur':>13} {'rasio terbaik':>13} {'fee 24h terbaik':>15}")
    for p, n, npm, br, bf in top:
        star = " *" if br >= NEED else ""
        print(f"{p:16} {n:9} {npm or 0:13} {br:12.2f}x ${bf:13.2f}{star}")
    print("\n* rasio terbaik >= 2,5x (model terukur). Angka ini cuma throughput gate, BUKAN hasil trade.")
    return pm


def main():
    mode_summary = "--summary" in sys.argv
    summary_hours = None
    if mode_summary:
        i = sys.argv.index("--summary")
        if i + 1 < len(sys.argv) and sys.argv[i + 1].isdigit():
            summary_hours = int(sys.argv[i + 1])
    con = init_db()
    now = datetime.datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")   # UTC: biar cocok dgn datetime('now') SQLite

    offset = int(open(STATE).read().strip()) if os.path.exists(STATE) else 0
    first_run = offset == 0
    lines, new_offset = parse_log(offset)
    rows = rows_from_lines(lines, now)
    if rows:
        insert(con, rows)

    # lapor hanya kalau ada yang BARU lolos model terukur, atau mode --summary
    newly = [r for r in rows if r[11] == 1]
    if mode_summary:
        print(f"=== counterfactual gate ({'semua observasi' if not summary_hours else f'{summary_hours} jam terakhir'}) ===")
        summary(con, summary_hours)
    elif newly:
        seen = collections.Counter(r[1] for r in newly)
        print(f"[gate-cf] {len(rows)} penolakan diproses; {len(newly)} di antaranya lolos model TERUKUR "
              f"({len(seen)} pool) padahal live menolaknya:")
        for pair, n in seen.most_common(8):
            best = max((r for r in newly if r[1] == pair), key=lambda r: r[9])
            print(f"  {pair:16} fee ${best[3]:7.2f} · butuh(live) ${best[4]*NEED:7.2f} · butuh(terukur) ${best[8]:7.2f} · rasio {best[9]:.2f}x")
    elif not first_run:
        pass  # diam: tidak ada yang baru
    else:
        print("[gate-cf] backfill selesai")
        summary(con)

    with open(STATE, "w") as fh:
        fh.write(str(new_offset))


if __name__ == "__main__":
    main()
