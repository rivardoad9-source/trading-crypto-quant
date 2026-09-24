#!/usr/bin/env python3
"""
Salin dataset backtest yang di-pin ke cache kerja, dengan stempel `fetchedAt` DISEGARKAN.

Kenapa perlu: `readCacheFile()` di src/backtest/historicalData.ts menolak cache yang
umurnya > CACHE_TTL_MS (6 jam). Sweep offline yang pin-nya lebih tua dari itu diam-diam
membangun ulang universe lewat GeckoTerminal — kena rate-limit (20-60 s per pool) dan
tiap run jadi belasan menit, tanpa error yang kelihatan.

Isi dataset TIDAK diubah (bar, pool, cohort sama persis) — hanya stempel waktu yang
dimajukan, dan hanya pada SALINAN kerja. File pin aslinya tetap utuh sebagai bukti asal.

Pakai:  python3 scripts/agent_repin_cache.py <pin.json> <.cache/historical_data_micro.json>
"""
import datetime
import json
import os
import sys


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    src, dst = sys.argv[1], sys.argv[2]
    with open(src) as f:
        dataset = json.load(f)
    original = dataset.get("fetchedAt")
    dataset["fetchedAt"] = (
        datetime.datetime.now(datetime.timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )
    os.makedirs(os.path.dirname(os.path.abspath(dst)), exist_ok=True)
    with open(dst, "w") as f:
        json.dump(dataset, f)
    pools = dataset.get("pools", [])
    survivors = sum(1 for p in pools if p.get("cohort") == "survivor")
    dead = sum(1 for p in pools if p.get("cohort") == "dead-or-dormant")
    print(
        f"[repin] {os.path.basename(src)} -> {dst} · fetchedAt {original} => {dataset['fetchedAt']} "
        f"· {len(pools)} pool ({survivors} survivor, {dead} dead) · windowDays={dataset.get('windowDays')}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
