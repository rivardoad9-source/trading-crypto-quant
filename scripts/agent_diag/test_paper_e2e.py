#!/usr/bin/env python3
"""Uji end-to-end jalur skor paper trade TANPA menyentuh DB asli.

Skenario (di salinan DB):
  A. baris pending yang event-nya dibackdate 30 jam  -> harus ke-skor
  B. baris pending dengan pool_address palsu         -> harus gagal rapi (attempts naik, tidak crash)
  C. baris pending yang belum 25 jam                 -> harus DILEWATI
  D. jalankan dua kali                               -> idempoten (tidak dobel skor)

Exit 0 = semua perilaku sesuai harapan.
"""
import json
import os
import shutil
import sqlite3
import subprocess
import sys

SRC = "/home/ubuntu/.hermes/data/gate_counterfactual.db"
TEST = "/tmp/paper_test.db"
SCORER = "/home/ubuntu/.hermes/scripts/paper_trade_scorer.py"
fails = []


def check(cond, msg):
    print(("  ✓ " if cond else "  ✗ ") + msg)
    if not cond:
        fails.append(msg)


def run():
    env = dict(os.environ, PAPER_DB=TEST)
    p = subprocess.run([sys.executable, SCORER, "run"], capture_output=True, text=True, env=env, timeout=900)
    return p


def main():
    shutil.copyfile(SRC, TEST)
    # migrasi skema di salinan (jalur yang sama dipakai produksi saat cron pertama jalan)
    mig = subprocess.run([sys.executable, "-c",
                          "import sys; sys.path.insert(0,'/home/ubuntu/.hermes/scripts');"
                          "import paper_trade_scorer as p; p.init_db()"],
                         capture_output=True, text=True, env=dict(os.environ, PAPER_DB=TEST), timeout=60)
    if mig.returncode != 0:
        print("migrasi gagal:", mig.stderr[-400:])
        return 1
    con = sqlite3.connect(TEST)
    real = con.execute("select id, pair from paper_trades where source='counterfactual' and status='pending' "
                       "order by id limit 1").fetchone()
    # A: backdate 30 jam
    con.execute("update paper_trades set event_time=datetime('now','-30 hours') where id=?", (real[0],))
    # B: pool palsu
    con.execute("""insert into paper_trades (created_at, source, pair, pool_address, event_time, status,
                    attempts, note, notional_usd) values (datetime('now'),'counterfactual','BOGUS-SOL',
                    'Bogus1111111111111111111111111111111111111', datetime('now','-30 hours'),'pending',0,'uji',180)""")
    bogus = con.execute("select max(id) from paper_trades").fetchone()[0]
    # C: belum 25 jam
    con.execute("""insert into paper_trades (created_at, source, pair, pool_address, event_time, status,
                    attempts, note, notional_usd) values (datetime('now'),'counterfactual','FRESH-SOL',?,
                    datetime('now','-1 hours'),'pending',0,'uji',180)""", (con.execute(
        "select pool_address from paper_trades where id=?", (real[0],)).fetchone()[0],))
    fresh = con.execute("select max(id) from paper_trades").fetchone()[0]
    con.commit()
    con.close()
    print(f"skenario: id {real[0]} ({real[1]}) dibackdate 30 jam · bogus id {bogus} · fresh id {fresh}\n")

    print("[run 1]")
    p = run()
    print("  stdout:", p.stdout.strip()[:300] or "(kosong)")
    if p.returncode != 0:
        print("  stderr:", p.stderr.strip()[-500:])
    check(p.returncode == 0, f"script keluar 0 (dapat {p.returncode})")

    con = sqlite3.connect(TEST)
    a = con.execute("""select status, entry_price, exit_price, exit_reason, gross_pct, net_pct_live,
                       net_pct_measured, bars_used, entry_ref_time from paper_trades where id=?""", (real[0],)).fetchone()
    print(f"\n  A id{real[0]}: status={a[0]} entry={a[1]} exit={a[2]} alasan={a[3]}")
    print(f"          gross={a[4] and round(a[4],3)}% net_lama={a[5] and round(a[5],3)}% net_terukur={a[6] and round(a[6],3)}% bar_terpakai={a[7]}")
    check(a[0] == "scored", "A: baris yang siap diskor -> status 'scored'")
    check(a[1] and a[2] and a[1] > 0, "A: harga entry & exit terisi dan masuk akal")
    check(a[3] and ("profit" in a[3] or "loss" in a[3] or "umur" in a[3]), "A: alasan exit = TP/SL/umur")
    check(a[5] is not None and a[6] is not None and abs(abs(a[5] - a[6]) - 0.68) < 0.001,
          "A: selisih net_lama vs net_terukur = 0,68 pts (beda model biaya)")
    check(a[5] == round(a[4] - 2.4444, 10) or abs(a[5] - (a[4] - 2.4444)) < 0.01, "A: net_lama = gross - 2,4444")
    check(a[7] and 1 <= a[7] <= 24, f"A: bar terpakai dalam 1..24 ({a[7]})")
    check(a[8] is not None, "A: entry_ref_time tercatat")

    b = con.execute("select status, attempts, note from paper_trades where id=?", (bogus,)).fetchone()
    print(f"  B id{bogus} (pool palsu): status={b[0]} attempts={b[1]} note={b[2][:70]!r}")
    check(b[0] == "pending", "B: pool palsu tidak dianggap scored")
    check(b[1] >= 1, "B: percobaan gagal tercatat (attempts naik)")
    check("gagal" in (b[2] or "").lower() or "bar" in (b[2] or "").lower(), "B: alasan gagal tercatat")

    c = con.execute("select status, attempts from paper_trades where id=?", (fresh,)).fetchone()
    check(c[0] == "pending" and c[1] == 0, f"C: baris <25 jam dilewati (status {c[0]}, attempts {c[1]})")

    snap = con.execute("""select count(*), sum(status='scored') from paper_trades
                          where status='scored' and source='counterfactual'""").fetchone()
    con.close()

    print("\n[run 2 — idempotensi]")
    p2 = run()
    print("  stdout:", p2.stdout.strip()[:200] or "(kosong)")
    con = sqlite3.connect(TEST)
    snap2 = con.execute("""select count(*), sum(status='scored') from paper_trades
                           where status='scored' and source='counterfactual'""").fetchone()
    con.close()
    check(snap == snap2, f"jumlah baris scored tidak berubah antar run ({snap} -> {snap2})")
    check("kandidat baru 0" in p2.stdout or "(kosong)" in (p2.stdout.strip() or "(kosong)"),
          "run 2 tidak bikin kandidat baru")

    print("\n=== HASIL UJI: " + ("SEMUA LOLOS" if not fails else f"{len(fails)} GAGAL") + " ===")
    for f in fails:
        print("  ✗ " + f)
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
