#!/usr/bin/env bash
# FASE G — uji usul operator (20 Sep 2026): "kalau nggak ada yang lolos standar,
# main di ticker yang standarnya TERDEKAT" = turunkan/lepas gate breakeven.
#
#   coverage 2.5 = setelan LIVE sekarang (baseline)
#   coverage 1.0 = "minimal impas" (fee 24 jam harus nutup biaya sekali)
#   coverage 0.5 / 0.25 = "terdekat dari standar"
#   coverage 0.0 = gate breakeven DILEPAS → selalu main argmax(feeTvl x volume)
#
# Dua dataset dipakai: 91 hari (22 pool, pinned) dan 120 hari (stitched).
# Akun = profil LIVE, gas 0.004 SOL/tx, NOL fetch jaringan (cache di-pin tiap run).
set -uo pipefail
cd /home/ubuntu/flowmetrix-ai-agent

PIN=.cache/bt_backup/historical_data_micro.pinned22.2026-09-17.json
CACHE=.cache/historical_data_micro.json
STITCH=.cache/historical_data_micro_120d_stitched.json
OUT=docs/backtests/runs/gate_bestavail
mkdir -p "$OUT"

[ -f "$STITCH" ] || python3 scripts/agent_diag/build_stitched_dataset.py 120 >/dev/null

restore() { python3 scripts/agent_repin_cache.py "$PIN" "$CACHE" >/dev/null; }
trap 'restore; echo "[bestavail] selesai — cache dipulihkan"' EXIT

FAILED=0
run() {  # run <tag> <days> <src-dataset> [ENV=VAL ...]
  local tag="$1" days="$2" src="$3"; shift 3
  python3 scripts/agent_repin_cache.py "$src" "$CACHE"
  local pools
  pools=$(python3 -c "import json;print(len(json.load(open('$CACHE'))['pools']))" 2>/dev/null)
  echo "=== $tag · days=$days · pool=$pools · env: ${*:-default} ==="
  env "$@" npm run backtest:micro -- --days="$days" --gas=0.004 > "$OUT/$tag.log" 2>&1
  local rc=$?
  cp -f backtest_micro_capital.json "$OUT/$tag.json" 2>/dev/null
  if [ "$rc" -ne 0 ]; then FAILED=$((FAILED+1)); echo "    !! exit=$rc"; fi
  grep -a "live-eligible" "$OUT/$tag.log" | tail -1
}

echo "########## DATASET 91 HARI (22 pool pinned) ##########"
for c in 2.5 2.0 1.5 1.0 0.75 0.5 0.25 0.0; do
  run "91d_cov${c}" 91 "$PIN" MIN_FEE_COST_COVERAGE="$c"
done

echo "########## DATASET 120 HARI (stitched) ##########"
for c in 2.5 2.0 1.5 1.0 0.75 0.5 0.25 0.0; do
  run "120d_cov${c}" 120 "$STITCH" MIN_FEE_COST_COVERAGE="$c"
done

cp -f "$PIN" "$CACHE"; touch "$CACHE"
echo "########## selesai · run gagal: $FAILED ##########"
ls -1 "$OUT"/*.json | wc -l
