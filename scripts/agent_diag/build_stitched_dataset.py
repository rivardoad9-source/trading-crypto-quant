"""Build a 120-day dataset OFFLINE by stitching the two cached 91-day window files.

Why: the micro runner's 6h-TTL cache gate refuses any dataset shorter than the requested
window (`cached.windowDays >= windowDays`) and then rebuilds the universe from GeckoTerminal.
We have Mar 15 -> Jun 13 and Jun 14 -> Sep 13 offline, so stitching gives the bars needed for
May 16 -> Sep 13 (120 days) with no network access at all.

Honest limits, printed with the result:
  - union universe: the first 29 days are covered only by the Mar-Jun ingest's pools, mid-window
    the universe rotates to the Jun-Sep ingest's pools (only 6 addresses appear in both files);
  - `cohort` labels are inherited from whichever ingest saw the pool (Mar-Jun survivors were
    still alive then, not necessarily in September);
  - tokenScreens come from the same two files.
"""
import json, datetime, os, shutil, subprocess, sys

os.chdir('/home/ubuntu/flowmetrix-ai-agent')
SRC = '.cache/historical_data_micro.json'
BAK = '.cache/bt_backup/historical_data_micro.pinned22.2026-09-17.json'
A_PATH = '.cache/historical_data_window_2026-03-15_2026-06-14.json'
B_PATH = '.cache/historical_data_window_2026-06-14_2026-09-13.json'
DAYS = int(sys.argv[1]) if len(sys.argv) > 1 else 120
OUT = f'.cache/historical_data_micro_{DAYS}d_stitched.json'

A = json.load(open(A_PATH))
B = json.load(open(B_PATH))

pool_by_addr = {}
for src in (A, B):
    for p in src['pools']:
        cur = pool_by_addr.get(p['address'])
        if cur is None:
            pool_by_addr[p['address']] = {**p, 'bars': list(p['bars']), '_from': [src['fetchedAt']]}
        else:
            seen = {b['t'] for b in cur['bars']}
            cur['bars'].extend(b for b in p['bars'] if b['t'] not in seen)
            cur['_from'].append(src['fetchedAt'])
            cur['cohort'] = p['cohort']  # later ingest wins
            cur['tokenScreen'] = p.get('tokenScreen') or cur.get('tokenScreen')

sol = {}
for src in (A, B):
    for b in src.get('solUsdBars') or []:
        sol[b['t']] = b
sol_bars = [sol[t] for t in sorted(sol)]

last_t = max(b['t'] for b in sol_bars)
cutoff = last_t - DAYS * 24 * 3600
f = lambda t: datetime.datetime.utcfromtimestamp(t).strftime('%Y-%m-%d %H:%M')

pools = []
for p in pool_by_addr.values():
    bars = [b for b in p['bars'] if b['t'] >= cutoff]
    bars.sort(key=lambda b: b['t'])
    if len(bars) < 30:
        continue
    q = {k: v for k, v in p.items() if not k.startswith('_')}
    q['bars'] = bars
    pools.append(q)

surv = sum(1 for p in pools if p['cohort'] == 'survivor')
dead = len(pools) - surv
sub = {
    'fetchedAt': datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%S.000Z'),
    'windowDays': DAYS,
    'pools': pools,
    'solUsdBars': [b for b in sol_bars if b['t'] >= cutoff],
    'window': {'start': f(cutoff), 'end': f(last_t)},
    'selection': f'STITCHED OFFLINE from 2 cached ingests ({A["fetchedAt"]} + {B["fetchedAt"]}), trimmed to the last {DAYS} days',
    'stitchedFrom': [A['fetchedAt'], B['fetchedAt']],
}
json.dump(sub, open(OUT, 'w'))
print(f"window {f(cutoff)} -> {f(last_t)} ({DAYS} hari) · pools {len(pools)} ({surv} survivor + {dead} dead)")
print('tulis', OUT)

if os.environ.get('STITCH_ONLY'):
    sys.exit(0)

if not os.path.exists(BAK):
    shutil.copy2(SRC, BAK)
shutil.copy2(OUT, SRC)
try:
    r = subprocess.run(['npm', 'run', 'backtest:micro', '--', f'--days={DAYS}', '--capital=300',
                        '--sizepct=70', '--concurrent=1', '--gas=0.004'],
                       capture_output=True, text=True, timeout=600)
    print('exit', r.returncode)
    print('\n'.join(r.stdout.splitlines()[-40:]))
    shutil.copy2('backtest_micro_capital.json',
                 f'docs/backtests/runs/micro_stitched{DAYS}d_sizepct70.json')
finally:
    shutil.copy2(BAK, SRC)
    print('cache 22-pool direstore')
