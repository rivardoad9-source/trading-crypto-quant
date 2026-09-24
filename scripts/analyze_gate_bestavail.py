#!/usr/bin/env python3
"""
Analisis sweep gate breakeven (fase G): apakah "main di ticker standar terdekat" works?

Baca docs/backtests/runs/gate_bestavail/*.json (hasil scripts/agent_gate_sweep_bestavail.sh).

Metrik:
  net        = netPnlUsd dari arm "unbiased" (survivor + dead pool, jadi nggak bias selamat)
  WR, PF     = dari summary
  DD         = maxDrawdownPct
  net-koreksi= net dikurangi biaya leg ENTRY yang model backtest nggak hitung:
               0,42% x notional x jumlah trade (angka terukur on-chain, lihat TABLE.txt fase lama)
  rug/cat    = jumlah trade exit RUGGED / catastrophic (netPnlPct <= -80)
"""
import glob, json, os, statistics, sys

RUNS = sys.argv[1] if len(sys.argv) > 1 else "/home/ubuntu/flowmetrix-ai-agent/docs/backtests/runs/gate_bestavail"
ENTRY_LEG_COST_PCT = 0.42  # % notional per trade — terukur (measure_swap_concession.py)


def load(path):
    with open(path) as f:
        return json.load(f)


def row(path):
    d = load(path)
    ub = d["scenarios"]["unbiased"]
    s = ub["summary"]
    tr = ub["trades"]
    notion = d["profile"]["notionalUsd"]
    n = len(tr)
    corr = ENTRY_LEG_COST_PCT / 100 * notion * n
    reasons = {}
    for t in tr:
        reasons[t["exitReason"]] = reasons.get(t["exitReason"], 0) + 1
    pnls = sorted((t["netPnlUsd"] for t in tr))
    best = pnls[-1] if pnls else 0
    worst = pnls[0] if pnls else 0
    fees = sum(t["feesEarnedUsd"] for t in tr)
    gas = sum(t["gasCostUsd"] for t in tr)
    slip = sum(t["slippageCostUsd"] for t in tr)
    swap = sum(t["swapCostUsd"] for t in tr)
    return {
        "tag": os.path.basename(path)[:-5],
        "days": d["windowDays"],
        "cov": d["config"]["minFeeCostCoverage"],
        "notional": notion,
        "trades": n,
        "wr": s.get("winRatePct"),
        "net": s.get("netPnlUsd"),
        "net_pct": (s.get("netPnlUsd") / d["config"]["startingCapitalUsd"] * 100) if s.get("netPnlUsd") is not None else None,
        "net_corr": (s.get("netPnlUsd") - corr) if s.get("netPnlUsd") is not None else None,
        "pf": s.get("profitFactor"),
        "dd": s.get("maxDrawdownPct"),
        "fees": fees, "gas": gas, "slip": slip, "swap": swap,
        "avg_dur": s.get("avgTradeDurationHours"),
        "best": best, "worst": worst,
        "rug": sum(1 for t in tr if t.get("rugged")),
        "cat": sum(1 for t in tr if t.get("catastrophic")),
        "reasons": reasons,
        "no_candidate_bars": ub.get("barsWithNoCandidate"),
        "rej": ub.get("gateRejections"),
        "elig": d.get("eligibility"),
    }


def fmt(v, d=2, comma=True):
    if v is None:
        return "  -  "
    return f"{v:,.{d}f}" if comma else f"{v:.{d}f}"


def main():
    paths = sorted(glob.glob(f"{RUNS}/*.json"))
    if not paths:
        print(f"[!] belum ada hasil di {RUNS}")
        sys.exit(1)
    rows = [row(p) for p in paths]
    rows.sort(key=lambda r: (r["days"], -(r["cov"] or 0)))

    for days in sorted({r["days"] for r in rows}):
        sub = [r for r in rows if r["days"] == days]
        print(f"\n===================== DATASET {days} HARI ({sub[0]['notional']:.0f}$ notional/trade) =====================")
        print(f"{'cov':>5} {'trade':>6} {'WR%':>6} {'net$':>9} {'net%':>7} {'net-koreksi$':>13} {'PF':>6} {'maxDD%':>7} "
              f"{'fee$':>8} {'gas$':>7} {'slip$':>7} {'rug':>4} {'bunuh':>6} {'reasons'}")
        for r in sub:
            print(f"{r['cov']:>5} {r['trades']:>6} {fmt(r['wr'],1):>6} {fmt(r['net']):>9} {fmt(r['net_pct'],1):>7} "
                  f"{fmt(r['net_corr']):>13} {fmt(r['pf']):>6} {fmt(r['dd'],1):>7} {fmt(r['fees']):>8} "
                  f"{fmt(r['gas']):>7} {fmt(r['slip']):>7} {r['rug']:>4} {r['cat']:>6}  "
                  f"{', '.join(f'{k}:{v}' for k, v in sorted(r['reasons'].items(), key=lambda x: -x[1]))}")
        print("\n  funnel yang ditolak gate (total per skenario):")
        for r in sub:
            rej = r["rej"] or {}
            top = sorted(rej.items(), key=lambda x: -x[1])[:6]
            print(f"    cov {r['cov']:>4}: " + " · ".join(f"{k} {v}" for k, v in top) +
                  f"   | bar dengan nol kandidat: {r['no_candidate_bars']}")
        print("\n  eligibility (a=pool yang bisa diakses live):")
        for r in sub:
            print(f"    cov {r['cov']:>4}: {(r['elig'] or ['-'])[0]}")

    doc = {"rows": rows, "entry_leg_cost_pct": ENTRY_LEG_COST_PCT}
    json.dump(doc, open(f"{RUNS}/ANALYSIS.json", "w"), indent=1)
    print(f"\n[tersimpan] {RUNS}/ANALYSIS.json")


if __name__ == "__main__":
    main()
