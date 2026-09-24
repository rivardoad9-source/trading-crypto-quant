#!/usr/bin/env bash
# FASE H — permintaan operator (20 Sep 2026): "backtest $300, periode 90 hari, metode sama"
# = grid coverage gate breakeven (termasuk gate dilepas) di akun $300.
#
# Akun: $300 modal, posisi = 63,158% x ekuitas (rasio profil LIVE yang sama) -> notional ~$189
#        (dibanding run lama $195 modal / $123,5 notional). Gas 0.004 SOL/tx.
# Dataset: 91 hari, 22 pool pinned (NOL fetch jaringan).
# ⚠️ JANGAN dijalankan bareng sweep lain: semua run memakai .cache/historical_data_micro.json
#    dan menulis backtest_micro_capital.json yang sama.
set -uo pipefail
cd /home/ubuntu/flowmetrix-ai-agent

PIN=.cache/bt_backup/historical_data_micro.pinned22.2026-09-17.json
CACHE=.cache/historical_data_micro.json
OUT=docs/backtests/runs/gate_bestavail_300
mkdir -p "$OUT"

restore() { python3 scripts/agent_repin_cache.py "$PIN" "$CACHE" >/dev/null; }
trap 'restore; echo "[bestavail300] selesai — cache dipulihkan"' EXIT

FAILED=0
run() {  # run <tag> <cov> [flag tambahan...]
  local tag="$1" cov="$2"; shift 2
  python3 scripts/agent_repin_cache.py "$PIN" "$CACHE"
  echo "=== $tag · cov=$cov · capital=300 sizepct=63.158 ==="
  env MIN_FEE_COST_COVERAGE="$cov" npm run backtest:micro -- \
      --days=91 --gas=0.004 --capital=300 --sizepct=63.1578947368421 "$@" \
      > "$OUT/$tag.log" 2>&1
  local rc=$?
  cp -f backtest_micro_capital.json "$OUT/$tag.json" 2>/dev/null
  if [ "$rc" -ne 0 ]; then FAILED=$((FAILED+1)); echo "    !! exit=$rc"; fi
  grep -a "live-eligible" "$OUT/$tag.log" | tail -1
}

for c in 2.5 2.0 1.5 1.0 0.75 0.5 0.25 0.0; do
  run "300usd_91d_cov${c}" "$c"
done

cp -f "$PIN" "$CACHE"; touch "$CACHE"
echo "########## selesai · run gagal: $FAILED ##########"
ls -1 "$OUT"/*.json | wc -l
