"""Tabel sweet-spot gate: baca semua run di docs/backtests/runs/gate_sweep/ dan cetak
satu baris per skenario, dua arm (full universe dari JSON, live-eligible dari log)."""
import json, glob, os, re, collections

D = '/home/ubuntu/flowmetrix-ai-agent/docs/backtests/runs/gate_sweep'
elig_pat = re.compile(r"\(a\) live-eligible : (\d+) pools · (\d+) trades · net ([+-]?\$[\d.,]+) · PF ([\d.]+|undefined) · maxDD ([\d.]+)%")

def arm(path):
    d = json.load(open(path))
    s = d['scenarios']['unbiased']['summary']
    cfg = d['config']
    tvl = d.get('tvlModel') or {}
    # friksi nyata = gas + slippage yang dibayar
    fric = s['totalGasCostUsd'] + s['totalSlippageCostUsd'] + s.get('totalSwapCostUsd', 0)
    return dict(
        tag=os.path.basename(path)[:-5],
        days=d['windowDays'],
        cov=cfg.get('minFeeCostCoverage'),
        slip=cfg.get('forcedExitSlippagePct'),
        minf=cfg.get('minFeeTvlRatio'), maxf=cfg.get('maxFeeTvlRatio'),
        k=tvl.get('medianK'),
        trades=s['totalTrades'], wr=s['winRatePct'], net=s['netPnlUsd'], netpct=s['returnPct'],
        pf=s['profitFactor'], dd=s['maxDrawdownPct'], fees=s['totalFeesUsd'], fric=fric,
        sl=s['exitReasonCounts'].get('STOP_LOSS', 0), tp=s['exitReasonCounts'].get('TAKE_PROFIT', 0),
        oob=s['exitReasonCounts'].get('OUT_OF_RANGE', 0),
        nocand=None, bars=None,
        notional=d['profile']['notionalUsd'], matches=d['profile']['matchesLive'],
        rejects=(d['scenarios']['unbiased'].get('gateRejections') or {}),
    )

def elig(tag):
    p = f'{D}/{tag}.log'
    if not os.path.exists(p):
        return None
    txt = open(p, errors='replace').read()
    hits = elig_pat.findall(txt)
    if not hits:
        return None
    pools, tr, net, pf, dd = hits[-1]
    return dict(pools=int(pools), trades=int(tr), net=float(net.replace('$', '').replace('+', '').replace(',', '')),
                pf=(None if pf == 'undefined' else float(pf)), dd=float(dd))

rows = [arm(p) for p in sorted(glob.glob(f'{D}/*.json')) if not p.endswith('SUMMARY.json')]
rows.sort(key=lambda r: (r['days'], r['cov'] or 0, r['slip'] or 0))
print(f"{'skenario':20} {'hari':>4} {'cov':>5} {'slip':>5} {'k TVL':>6} | {'trade':>5} {'WR%':>6} {'net $':>9} {'net%':>8} {'PF':>5} {'maxDD%':>7} {'frik/fee':>8} | {'elig trade':>10} {'elig net $':>10} {'elig maxDD':>10}")
print("-"*140)
for r in rows:
    e = elig(r['tag'])
    print(f"{r['tag']:20} {r['days']:4} {str(r['cov']):>5} {str(r['slip']):>5} {r['k']:6.3f} | "
          f"{r['trades']:5} {r['wr']:6.1f} {r['net']:9.2f} {r['netpct']:8.1f} {r['pf']:5.2f} {r['dd']:7.1f} "
          f"{(r['fric']/r['fees'] if r['fees'] else 0):8.2f} | "
          f"{(e or {}).get('trades', 0):10} {(e or {}).get('net', 0):10.2f} {(e or {}).get('dd', 0):10.1f}")

print("\n=== apa yang ditolak gate di tiap skenario (gateRejections) ===")
for r in rows:
    tot = sum(r['rejects'].values())
    top = sorted(r['rejects'].items(), key=lambda x: -x[1])[:4]
    print(f"  {r['tag']:20} total {tot:6} · " + " · ".join(f"{k} {v}" for k, v in top))

# ringkasan mesin-baca: SUMMARY.json di folder yang sama (yang di-commit; raw-nya di-gzip)
out = f'{D}/SUMMARY.json'
with open(out, 'w') as f:
    json.dump({'generatedAt': __import__('datetime').datetime.utcnow().isoformat() + 'Z',
               'note': 'Tabel sweet-spot gate. rows = 1 skenario backtest:micro (arm full universe); elig = arm live-eligible (dari log).',
               'rows': [{**{k: v for k, v in r.items() if k != 'rejects'},
                         'elig': elig(r['tag']), 'rejects': r['rejects']} for r in rows]}, f, indent=1)
print(f"\nSUMMARY.json -> {out} ({len(rows)} skenario)")
