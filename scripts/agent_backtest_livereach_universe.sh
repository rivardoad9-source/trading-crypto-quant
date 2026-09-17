#!/usr/bin/env bash
# Simulate ONLY the live-reachable pools (wSOL leg + clean token screen) at the live profile.
# Post-filtering another run's trades is not equivalent: capital, cooldown and entry order differ
# once the unreachable pools are absent. The pinned cache is swapped for the filtered dataset and
# restored at the end, whatever happens.
set -u
cd /home/ubuntu/flowmetrix-ai-agent
SRC=.cache/historical_data_micro.json
BAK=.cache/bt_backup/historical_data_micro.pinned22.2026-09-17.json
FIL=.cache/historical_data_micro_livereach.json

python3 - <<'PY'
import json, datetime, shutil, os
os.chdir('/home/ubuntu/flowmetrix-ai-agent')
WSOL = 'So11111111111111111111111111111111111111112'
def reachable(p):
    if not (p['baseMint'] == WSOL or p['quoteMint'] == WSOL):
        return False
    ts = p.get('tokenScreen') or {}
    r = ts.get('reading') or {}
    if ts.get('error'):
        return False
    return not ((r.get('transferFeeBps') or 0) > 0 or r.get('hasTransferHook') or r.get('nonTransferable'))
d = json.load(open('.cache/bt_backup/historical_data_micro.pinned22.2026-09-17.json'))
keep = [p for p in d['pools'] if reachable(p)]
drop = [p['pairName'] for p in d['pools'] if not reachable(p)]
sub = dict(d)
sub['pools'] = keep
sub['fetchedAt'] = datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%S.000Z')
sub['pinnedFrom'] = d.get('pinnedFrom') or d.get('fetchedAt')
sub['filteredTo'] = 'live-reachable only (wSOL leg + token screen clean)'
json.dump(sub, open('.cache/historical_data_micro_livereach.json', 'w'))
shutil.copy2('.cache/historical_data_micro_livereach.json', '.cache/historical_data_micro.json')
print(f'reachable {len(keep)}/{len(d["pools"])} pools (dropped {drop})', flush=True)
PY

npm run backtest:micro -- --days=91 > /tmp/micro_livereach.log 2>&1
echo "npm exit=$?"
cp backtest_micro_capital.json docs/backtests/runs/micro_liveprofile_livereach_90d.json 2>/dev/null
cp "$BAK" "$SRC"
echo "cache 22-pool direstore; hasil -> docs/backtests/runs/micro_liveprofile_livereach_90d.json"
grep -E "Profile|capital |size |concurrent|gas |SOL/USD|live-eligible|full universe|selisih" /tmp/micro_livereach.log | head -14
date '+selesai %H:%M:%S'
