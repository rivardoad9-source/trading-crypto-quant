#!/usr/bin/env bash
# Sweet-spot sweep of the ENTRY GATE (bukan perubahan live — backtest saja):
#   A) MIN_FEE_COST_COVERAGE 0.5 / 1.0 / 1.5 / 2.0 / 2.5 / 3.0 / 4.0 / 6.0
#   C) FORCED_EXIT_SLIPPAGE_PCT 1.0 / 1.5 / 3.0 / 5.0
#   D) band fee/TVL: MIN_FEE_TVL_RATIO 0.002 & 0.02 · MAX_FEE_TVL_RATIO 0.5 & 1.0
#   B) ulangan sweep coverage di dataset 120 hari (stitched offline)
#
# Akun = profil LIVE (tanpa --capital/--sizepct), gas 0.004 SOL/tx, dataset dari .cache
# (nol request ke GeckoTerminal: cache di-pin ulang SEBELUM tiap run + direstore di akhir).
set -uo pipefail
cd /home/ubuntu/flowmetrix-ai-agent

PIN=.cache/bt_backup/historical_data_micro.pinned22.2026-09-17.json
CACHE=.cache/historical_data_micro.json
STITCH=.cache/historical_data_micro_120d_stitched.json
OUT=docs/backtests/runs/gate_sweep
mkdir -p "$OUT"
SRC_DATASET=""

restore() { cp -f "$PIN" "$CACHE"; touch "$CACHE"; }
trap 'restore; echo "[sweep] selesai — cache 22-pool direstore"' EXIT

FAILED=0
run() {                        # run <tag> <days> [ENV=VAL ...]
  local tag="$1" days="$2"; shift 2
  local src="${SRC_DATASET:-$PIN}"
  cp -f "$src" "$CACHE"; touch "$CACHE"
  local pool_count
  pool_count=$(python3 -c "import json;print(len(json.load(open('$CACHE'))['pools']))")
  echo "=== $tag · days=$days · pool=$pool_count · env: ${*:-default} ==="
  env "$@" npm run backtest:micro -- --days="$days" --gas=0.004 > "$OUT/$tag.log" 2>&1
  local rc=$?
  cp -f backtest_micro_capital.json "$OUT/$tag.json" 2>/dev/null
  if [ "$rc" -ne 0 ]; then FAILED=$((FAILED+1)); echo "    !! exit=$rc"; fi
  grep -a "live-eligible" "$OUT/$tag.log" | tail -1
}

echo "############ FASE A — coverage multiplier (91 hari, 22 pool) ############"
for c in 0.5 1.0 1.5 2.0 2.5 3.0 4.0 6.0; do
  run "91d_cov${c}" 91 MIN_FEE_COST_COVERAGE="$c"
done

echo "############ FASE C — asumsi slippage exit (91 hari, coverage 2.5) ############"
for s in 1.0 1.5 3.0 5.0; do
  run "91d_slip${s}" 91 FORCED_EXIT_SLIPPAGE_PCT="$s"
done

echo "############ FASE D — band fee/TVL (91 hari, coverage 2.5) ############"
run "91d_minfee0.002" 91 MIN_FEE_TVL_RATIO=0.002
run "91d_minfee0.02"  91 MIN_FEE_TVL_RATIO=0.02
run "91d_maxfee0.5"   91 MAX_FEE_TVL_RATIO=0.5
run "91d_maxfee1.0"   91 MAX_FEE_TVL_RATIO=1.0

echo "############ FASE B — coverage sweep di dataset 120 hari (stitched) ############"
python3 scripts/agent_diag/build_stitched_dataset.py 120
SRC_DATASET="$STITCH"
for c in 1.0 2.0 2.5 3.0 4.0; do
  run "120d_cov${c}" 120 MIN_FEE_COST_COVERAGE="$c"
done

echo "############ FASE E — kombinasi (multiplier × slippage × plafon) ############"
SRC_DATASET="$STITCH"
run "120d_cov1.5" 120 MIN_FEE_COST_COVERAGE=1.5
run "120d_slip1.0" 120 FORCED_EXIT_SLIPPAGE_PCT=1.0
run "120d_cov2.5_maxfee0.5" 120 MIN_FEE_COST_COVERAGE=2.5 MAX_FEE_TVL_RATIO=0.5
SRC_DATASET=""
run "91d_cov1.5_maxfee0.5" 91 MIN_FEE_COST_COVERAGE=1.5 MAX_FEE_TVL_RATIO=0.5

echo "############ selesai · run gagal: $FAILED ############"
ls -1 "$OUT"/*.json | wc -l
