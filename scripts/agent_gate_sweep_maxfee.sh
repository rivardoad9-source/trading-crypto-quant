#!/usr/bin/env bash
# FASE I — pembanding arah BERLAWANAN dengan "turunkan standar":
# naikkan PLAFON fee/TVL (MAX_FEE_TVL_RATIO 0.25 -> 0.5/1.0) di gate breakeven tetap 2.5.
# Funnel 91d menunjukkan lowTvl/lowFeeTvl yang mendominasi, dan sweep 17 Sep: maxfee0.5
# = 45 trade, net +$530, PF 3.45 (vs +$247 baseline). Diuji ulang di kode hari ini.
set -uo pipefail
cd /home/ubuntu/flowmetrix-ai-agent
PIN=.cache/bt_backup/historical_data_micro.pinned22.2026-09-17.json
STITCH=.cache/historical_data_micro_120d_stitched.json
CACHE=.cache/historical_data_micro.json
OUT=docs/backtests/runs/gate_bestavail
mkdir -p "$OUT"

restore() { python3 scripts/agent_repin_cache.py "$PIN" "$CACHE" >/dev/null; }
trap 'restore; echo "[faseI] selesai — cache dipulihkan"' EXIT

run() { # run <tag> <days> <src> [ENV=VAL ...]
  local tag="$1" days="$2" src="$3"; shift 3
  python3 scripts/agent_repin_cache.py "$src" "$CACHE" >/dev/null
  echo "=== $tag · days=$days · env: ${*:-default} ==="
  env "$@" npm run backtest:micro -- --days="$days" --gas=0.004 > "$OUT/$tag.log" 2>&1
  cp -f backtest_micro_capital.json "$OUT/$tag.json"
  grep -a "live-eligible" "$OUT/$tag.log" | tail -1
}

run "91d_maxfee0.5"            91 "$PIN"    MAX_FEE_TVL_RATIO=0.5
run "91d_maxfee1.0"            91 "$PIN"    MAX_FEE_TVL_RATIO=1.0
run "91d_cov1.5_maxfee0.5"     91 "$PIN"    MIN_FEE_COST_COVERAGE=1.5 MAX_FEE_TVL_RATIO=0.5
run "120d_maxfee0.5"          120 "$STITCH" MAX_FEE_TVL_RATIO=0.5
run "120d_cov1.0_maxfee0.5"   120 "$STITCH" MIN_FEE_COST_COVERAGE=1.0 MAX_FEE_TVL_RATIO=0.5
restore
