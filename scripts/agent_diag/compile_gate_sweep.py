"""Tabel sweet-spot gate: baca semua run di docs/backtests/runs/gate_sweep/ dan cetak
satu baris per skenario, dua arm (full universe dari JSON, live-eligible dari log)."""
import json, glob, os, re, gzip, collections

D = '/home/ubuntu/flowmetrix-ai-agent/docs/backtests/runs/gate_sweep'
elig_pat = re.compile(r"\(a\) live-eligible : (\d+) pools · (\d+) trades · net ([+-]?\$[\d.,]+) · PF ([\d.]+|undefined) · maxDD ([\d.]+)%")

def load(path):
    return json.load(gzip.open(path, 'rt') if path.endswith('.gz') else open(path))


def arm(path):
    d = load(path)
    s = d['scenarios']['unbiased']['summary']
    cfg = d['config']
    tvl = d.get('tvlModel') or {}
    # friksi nyata = gas + slippage yang dibayar
    fric = s['totalGasCostUsd'] + s['totalSlippageCostUsd'] + s.get('totalSwapCostUsd', 0)
    return dict(
        tag=os.path.basename(path).replace('.json.gz', '').replace('.json', ''),
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
        p = f'{D}/{tag}.log.gz'
    if not os.path.exists(p):
        return None
    txt = gzip.open(p, 'rt', errors='replace').read() if p.endswith('.gz') else open(p, errors='replace').read()
    hits = elig_pat.findall(txt)
    if not hits:
        return None
    pools, tr, net, pf, dd = hits[-1]
    return dict(pools=int(pools), trades=int(tr), net=float(net.replace('$', '').replace('+', '').replace(',', '')),
                pf=(None if pf == 'undefined' else float(pf)), dd=float(dd))

_paths = sorted(glob.glob(f'{D}/*.json') + glob.glob(f'{D}/*.json.gz'))
_paths = [p for p in _paths if not os.path.basename(p).startswith('SUMMARY')]
rows = [arm(p) for p in _paths]
rows.sort(key=lambda r: (r['days'], r['cov'] or 0, r['slip'] or 0))
# koncesi leg ENTRY terukur on-chain (measure_swap_concession.py): median 0,42% dari notional
# per trade — biaya ini TIDAK ada di model backtest, jadi dipotong sebagai baris koreksi.
ENTRY_CUT_PCT = 0.42
print(f"# potong leg entry terukur {ENTRY_CUT_PCT}% x notional x trade (biaya yang model backtest tidak hitung)\n")
print(f"{'skenario':20} {'hari':>4} {'cov':>5} {'slip':>5} {'notion$':>8} | {'trade':>5} {'WR%':>6} {'net $':>9} {'net%':>8} {'net-koreksi':>11} {'PF':>5} {'maxDD%':>7} {'frik/fee':>8} | {'elig':>5} {'elig net$':>10} {'elig-koreksi':>12}")
print("-"*158)
for r in rows:
    e = elig(r['tag'])
    cut = ENTRY_CUT_PCT / 100 * r['notional']
    adj = r['net'] - cut * r['trades']
    eadj = ((e or {}).get('net', 0) - cut * (e or {}).get('trades', 0)) if e else None
    print(f"{r['tag']:20} {r['days']:4} {str(r['cov']):>5} {str(r['slip']):>5} {r['notional']:8.0f} | "
          f"{r['trades']:5} {r['wr']:6.1f} {r['net']:9.2f} {r['netpct']:8.1f} {adj:11.2f} {r['pf']:5.2f} {r['dd']:7.1f} "
          f"{(r['fric']/r['fees'] if r['fees'] else 0):8.2f} | "
          f"{(e or {}).get('trades', 0):5} {(e or {}).get('net', 0):10.2f} {(eadj if eadj is not None else 0):12.2f}")

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
