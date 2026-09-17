#!/usr/bin/env bash
# Sweep size-percentage (equity compounding) on the SAME 90-day dataset.
# Each run reuses the cached history (6h TTL) so the pool set / window is identical.
set -u
cd /home/ubuntu/flowmetrix-ai-agent || exit 1
OUT=docs/backtests/runs
mkdir -p "$OUT"

for PCT in "$@"; do
  echo "=== sizepct=$PCT  $(date '+%H:%M:%S') ==="
  npm run backtest:micro -- --days=91 --capital=300 --sizepct="$PCT" --concurrent=1 --gas=0.004 \
    > "/tmp/micro_${PCT}.log" 2>&1
  rc=$?
  if [ $rc -ne 0 ]; then
    echo "  GAGAL rc=$rc  (lihat /tmp/micro_${PCT}.log)"
    tail -20 "/tmp/micro_${PCT}.log"
    continue
  fi
  cp backtest_micro_capital.json "$OUT/micro_sizepct${PCT}.json"
  cp backtest_micro_capital_report.txt "$OUT/micro_sizepct${PCT}_report.txt"
  echo "  ok -> $OUT/micro_sizepct${PCT}.json"
done
echo "=== selesai $(date '+%H:%M:%S') ==="
