#!/usr/bin/env bash
# 120-day run at $300 / 70% sizing on a dataset stitched from the two cached 91-day ingests.
# No network: the dataset comes from .cache only. The 22-pool pinned cache is swapped out for the
# stitched file and always restored at the end.
set -u
cd /home/ubuntu/flowmetrix-ai-agent
SRC=.cache/historical_data_micro.json
BAK=.cache/bt_backup/historical_data_micro.pinned22.2026-09-17.json
DAYS="${1:-120}"
PCT="${2:-70}"

STITCH_ONLY=1 python3 /home/ubuntu/.hermes/scripts/diag/build_stitched_dataset.py "$DAYS" || exit 1
cp -f "$BAK" "$BAK" 2>/dev/null
cp -f "$SRC" /tmp/cache_before_stitch.json
cp -f ".cache/historical_data_micro_${DAYS}d_stitched.json" "$SRC"

npm run backtest:micro -- --days="$DAYS" --capital=300 --sizepct="$PCT" --concurrent=1 --gas=0.004 > "/tmp/micro_stitched${DAYS}d_pct${PCT}.log" 2>&1
echo "npm exit=$?"
cp -f backtest_micro_capital.json "docs/backtests/runs/micro_stitched${DAYS}d_sizepct${PCT}.json"

cp -f "$BAK" "$SRC"
echo "cache 22-pool direstore ($(python3 -c "import json;print(len(json.load(open('$SRC'))['pools']))") pool)"

grep -E "Profile|capital |size |concurrent|gas |SOL/USD|Window |Universe |live-eligible|full universe|selisih|NEXT" "/tmp/micro_stitched${DAYS}d_pct${PCT}.log" | head -20
