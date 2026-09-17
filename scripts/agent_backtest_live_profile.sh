#!/usr/bin/env bash
# Integrity runs on the LIVE account and cached datasets only.
#
# runIntegrity injects `--capital=300 --sizepct=63` defaults, so "no flags" is NOT the live
# profile there. We hand it the live account explicitly, derived exactly as liveProfile.ts does:
#   capital = LIVE_CAPITAL_SOL x SOL/USD at the window's first bar
#   size    = LIVE_MAX_POSITION_SOL / LIVE_CAPITAL_SOL
# The header then prints "Profile : LIVE (derived from ...)" — check it, that is the guard.
set -u
cd /home/ubuntu/flowmetrix-ai-agent
RUNS=docs/backtests/runs
mkdir -p "$RUNS"
SIZEPCT=63.1578947368421
export LIVE_CAPITAL_SOL LIVE_MAX_POSITION_SOL

run_window () {
  local w="$1" cap="$2"
  echo "=== window $w | capital=\$$cap (2.85 SOL) | size=${SIZEPCT}% = 1.8 SOL | $(date '+%H:%M:%S') ==="
  npm run backtest:integrity -- --dataset=".cache/historical_data_window_$w.json" \
      --days=91 --windows=1 --capital="$cap" --sizepct="$SIZEPCT" --concurrent=1 \
      > "/tmp/integrity_live_$w.log" 2>&1
  echo "  exit=$?"
  cp backtest_integrity_report.txt "$RUNS/2026-09-17-integrity-LIVEprofile-$w.txt"
  cp backtest_integrity_summary.json "$RUNS/2026-09-17-integrity-LIVEprofile-$w.json"
  grep -E "^Profile|^  capital|^  size|^  concurrent|^  gas|^  SOL/USD|WARNING|live-eligible [0-9]|^  \(a\)|^  \(b\)|^  \(c\)" \
      "/tmp/integrity_live_$w.log" | head -12
}

run_window 2026-06-14_2026-09-13 196.15529373211436
run_window 2026-03-15_2026-06-14 250.29518274873402
echo "selesai $(date '+%H:%M:%S')"
