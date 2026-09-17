#!/usr/bin/env bash
# FASE F — backtest dengan koncesi exit TERUKUR (bukan asumsi 2%).
# Sumber angka: measure_swap_concession.py (on-chain) + exit_economics, sebagai % dari NOTIONAL:
#   median 0,86% · mean 1,08% · terburuk 1,80%   (model live sekarang: 2,00%)
# Bar gate yang implied: 2,5 x (gas 0,444% + slip) -> 3,26% / 3,81% / 5,61% fee/TVL.
# Dataset: 91d pinned 22-pool + 120d stitched. Akun live, gas 0,004, nol fetch jaringan.
set -uo pipefail
cd /home/ubuntu/flowmetrix-ai-agent
PIN=.cache/bt_backup/historical_data_micro.pinned22.2026-09-17.json
CACHE=.cache/historical_data_micro.json
STITCH=.cache/historical_data_micro_120d_stitched.json
OUT=docs/backtests/runs/gate_sweep
mkdir -p "$OUT"
[ -f "$STITCH" ] || python3 scripts/agent_diag/build_stitched_dataset.py 120 >/dev/null

run() {   # run <tag> <days> <src-dataset> <env...>
  local tag="$1" days="$2" src="$3"; shift 3
  cp -f "$src" "$CACHE"; touch "$CACHE"
  env "$@" npm run backtest:micro -- --days="$days" --gas=0.004 > "$OUT/$tag.log" 2>&1
  local rc=$?
  cp -f backtest_micro_capital.json "$OUT/$tag.json" 2>/dev/null
  echo "$tag exit=$rc | $(grep -a 'live-eligible' "$OUT/$tag.log" | tail -1)"
}

for s in 0.86 1.08 1.8; do
  run "91d_slip$s" 91 "$PIN" FORCED_EXIT_SLIPPAGE_PCT=$s
done
for s in 0.86 1.08 1.8; do
  run "120d_slip$s" 120 "$STITCH" FORCED_EXIT_SLIPPAGE_PCT=$s
done

cp -f "$PIN" "$CACHE"; touch "$CACHE"
git checkout -- backtest_micro_capital.json 2>/dev/null
echo "DONE (cache 22-pool dipulihkan)"
