"""Compare the runs side by side: what changed the answer — window length, universe, or the TVL
model? Reads the archived run JSONs and prints one row per run."""
import json

RUNS = [
    ('120d stitched (51 pool)', 'docs/backtests/runs/micro_stitched120d_sizepct70.json'),
    (' 91d stitched (32 pool)', 'docs/backtests/runs/micro_stitched91d_sizepct70.json'),
    (' 91d micro 22-pool (sample lama)', 'docs/backtests/runs/micro_sizepct70.json'),
]

def row(label, path):
    d = json.load(open(path))
    sc = d['scenarios']['unbiased']
    s = sc['summary']
    tm = d.get('tvlModel') or {}
    k = tm.get('medianK', tm.get('kMedian'))
    print(f"\n{label}")
    print(f"  window {sc['windowStart'][:16]} → {sc['windowEnd'][:16]} · {sc['barsSimulated']} bar · {len(sc['poolsSimulated'])} pool")
    print(f"  TVL model k median {k} · pools di window {len(sc['poolsSimulated'])}")
    print("  field summary:", {k: (round(v, 2) if isinstance(v, (int, float)) else v) for k, v in s.items()})
    mix = {}
    for t in sc['trades']:
        mix[t['exitReason']] = mix.get(t['exitReason'], 0) + 1
    print(f"  exit mix      : {', '.join(f'{a} {b}' for a, b in sorted(mix.items(), key=lambda x: -x[1]))}")
    print(f"  eligibility   : {d['eligibility'][0] if d.get('eligibility') else '-'}")

for label, path in RUNS:
    row(label, path)
