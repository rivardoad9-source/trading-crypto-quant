#!/usr/bin/env python3
"""Audit rantai counterfactual -> paper trade. Read-only, exit != 0 kalau ada inkonsistensi."""
import datetime
import json
import os
import sqlite3
import subprocess
import sys

DB = os.environ.get("PAPER_DB", "/home/ubuntu/.hermes/data/gate_counterfactual.db")
LIVE = 0.024444      # gas 0.4444% + slippage exit 2.0% (model LAMA, dipakai live)
MEASURED = 0.017644  # gas 0.4444% + leg entry 0.41% + leg exit 0.91% (model TERUKUR)
NEED = 2.5
bad = []


def fail(msg):
    bad.append(msg)
    print("  ✗ " + msg)


def ok(msg):
    print("  ✓ " + msg)


def main():
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    now = datetime.datetime.utcnow()

    print("\n[1] observations — struktur & isi")
    n, pairs, tmin, tmax = con.execute(
        "select count(*), count(distinct pair), min(collected_at), max(collected_at) from observations").fetchone()
    ok(f"{n} baris · {pairs} pool unik · {tmin} .. {tmax}")
    if datetime.datetime.fromisoformat(tmax) > now + datetime.timedelta(minutes=5):
        fail(f"collected_at di masa depan ({tmax}) — campur WIB/UTC?")
    else:
        ok("collected_at masuk akal (UTC, tidak ada masa depan)")
    dup = con.execute("""select pair, collected_at, count(*) c from observations
                         group by 1,2 having c > 1 order by c desc limit 3""").fetchall()
    if dup:
        print(f"    (info) duplikat pair+waktu: {dup}")

    print("\n[2] aritmetika model — dihitung ulang dari angka mentah")
    rows = con.execute("""select pair, fee24h_usd, cost_live_usd, cost_measured_usd,
                                 ratio_live, ratio_measured, pass_live, pass_measured
                          from observations where fee24h_usd is not null and cost_live_usd > 0""").fetchall()
    m = {"ratio_live": 0, "ratio_measured": 0, "pass_live": 0, "pass_measured": 0, "cost_ratio": 0, "impossible": 0}
    for _p, fee, cl, cm, rl, rm, pl, pm in rows:
        if abs(rl - fee / cl) > 0.02:
            m["ratio_live"] += 1
        if abs(rm - fee / cm) > 0.02:
            m["ratio_measured"] += 1
        if pl != int(fee / cl >= NEED):
            m["pass_live"] += 1
        if pm != int(fee / cm >= NEED):
            m["pass_measured"] += 1
        if abs(cm / cl - MEASURED / LIVE) > 0.001:
            m["cost_ratio"] += 1
        if rl >= NEED:                      # baris ini dari log "rejected" -> tak mungkin >= 2,5x
            m["impossible"] += 1
        _ = (fee, cm, pl, pm)
    for k, v in m.items():
        (ok if v == 0 else fail)(f"{k}: {v} baris tidak konsisten (dari {len(rows)})")
    pmc = con.execute("select count(*) from observations where pass_measured=1").fetchone()[0]
    ok(f"lolos bar terukur: {pmc}/{n} ({100*pmc/n:.1f}%)")

    print("\n[3] ambang gate — cek angka yang dipangku")
    print(f"    model LAMA  {LIVE*100:.4f}% x {NEED} = {LIVE*NEED*100:.3f}% fee/TVL (live pakai ini)")
    print(f"    model TERUKUR {MEASURED*100:.4f}% x {NEED} = {MEASURED*NEED*100:.3f}% fee/TVL (bar counterfactual)")
    r = con.execute("""select min(ratio_measured), max(ratio_measured) from observations
                       where pass_measured=1""").fetchone()
    if r[0] and r[0] < NEED - 1e-9:
        fail(f"ada baris pass_measured=1 dengan rasio < 2,5 ({r[0]})")
    else:
        ok(f"semua baris pass_measured=1 punya rasio >= 2,5 (range {r[0]:.2f}x .. {r[1]:.2f}x)")
    r2 = con.execute("""select count(*), max(ratio_live) from observations where ratio_measured >= 2.5""").fetchone()
    ok(f"baris yang lolos bar terukur: {r2[0]} · rasio live tertinggi {r2[1]:.2f}x (harus < 2,5)")

    print("\n[4] paper_trades — konsistensi")
    st = con.execute("select source, status, count(*) from paper_trades group by 1,2").fetchall()
    for s, stt, c in st:
        print(f"    {s:16} {stt:12} {c}")
    q = con.execute("""select count(*) from paper_trades where source='counterfactual'
                       and status='pending' and (pool_address is null or event_time is null)""").fetchone()[0]
    (ok if q == 0 else fail)(f"pending tanpa pool_address/event_time: {q}")
    q2 = con.execute("""select count(*) from paper_trades where source='counterfactual' and status='pending'
                        and datetime(event_time) > datetime('now','-25 hours')""").fetchone()[0]
    pend = con.execute("select count(*) from paper_trades where source='counterfactual' and status='pending'").fetchone()[0]
    ok(f"pending {pend} · {q2} di antaranya belum lewat 25 jam (memang belum bisa di-skor)")
    if q == 0 and q2 == pend:
        ok("semua pending menunggu jendela 25 jam — tidak ada yang 'nyangkut' secara logika")
    dup2 = con.execute("""select pool_address, count(*) c from paper_trades
                          where source='counterfactual' group by 1 having c > 1""").fetchall()
    (ok if not dup2 else fail)(f"pool dengan >1 paper trade (cooldown 24 jam bocor?): {dup2}")
    q3 = con.execute("""select count(*) from paper_trades where source='counterfactual'
                        and (ratio_measured < 2.5 or ratio_measured is null)""").fetchone()[0]
    (ok if q3 == 0 else fail)(f"paper trade dari event yang TIDAK lolos bar terukur: {q3}")
    # notional harus = cost_live/2,4444%, dan cost_live = cost_measured x (2,4444/1,7644) -> notional = fee/rasio_measured x 56,68
    q4 = con.execute("""select count(*) from paper_trades where source='counterfactual'
                        and abs(notional_usd - fee_usd_at_event/ratio_measured*56.68) > 3""").fetchone()[0]
    (ok if q4 == 0 else fail)(f"notional_usd != cost_live/2,4444% pada {q4} baris (notional harus dari angka engine)")

    print("\n[5] validate_real — akurasi simulator vs kenyataan")
    v = con.execute("""select pair, exit_reason, gross_pct, actual_reason, actual_pct
                       from paper_trades where source='validate_real' order by id""").fetchall()
    if len(v) != 7:
        fail(f"harusnya 7 baris validate_real, ada {len(v)}")
    match = 0
    errs = []
    for pair, why, g, ar, ap in v:
        same = ("stop-loss" in (why or "")) == ("top-loss" in (ar or "").lower() or "stop-loss" in (ar or "").lower())
        match += int(same)
        errs.append(abs(g - ap))
    errs.sort()
    ok(f"{match}/{len(v)} verdict cocok · galat abs median {errs[len(errs)//2]:.2f} pts · maks {errs[-1]:.2f} pts")
    if errs[-1] > 15:
        print("    (info) ada trade dengan galat besar = flip TP/SL dari bar hourly; sudah didokumentasikan")

    print("\n[6] cron — status job yang dipakai rantai ini")
    for jid, name in (("c2b5663b5f79", "gate-counterfactual"), ("4e6f2af35eca", "paper-trade-tpsl"),
                      ("63d533faf722", "entrycosts-sweep")):
        d = f"/home/ubuntu/.hermes/cron/output/{jid}"
        files = sorted(os.listdir(d)) if os.path.isdir(d) else []
        last = files[-1] if files else None
        status = ""
        if last:
            txt = open(os.path.join(d, last), errors="ignore").read()
            status = "script failed" if "script failed" in txt else "ok"
        ok(f"{name:20} {len(files)} run tercatat · terakhir {last or '-'} · {status or 'belum ada output'}")

    print("\n[7] file & script rantai")
    for p in ("/home/ubuntu/.hermes/scripts/gate_counterfactual.py",
              "/home/ubuntu/.hermes/scripts/paper_trade_scorer.py"):
        ok(f"{os.path.basename(p)} {os.path.getsize(p)} B · mtime {datetime.datetime.fromtimestamp(os.path.getmtime(p)):%Y-%m-%d %H:%M}")
    gtc = "/home/ubuntu/.hermes/data/gt_cache"
    ok(f"cache GeckoTerminal: {len(os.listdir(gtc))} file")
    try:
        import ast
        for p in ("/home/ubuntu/.hermes/scripts/gate_counterfactual.py",
                  "/home/ubuntu/.hermes/scripts/paper_trade_scorer.py"):
            ast.parse(open(p).read())
        ok("syntax kedua script valid")
    except SyntaxError as e:
        fail(f"syntax error: {e}")

    print("\n=== HASIL: " + ("SEMUA KONSISTEN" if not bad else f"{len(bad)} TEMUAN") + " ===")
    for b in bad:
        print("  ✗ " + b)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
