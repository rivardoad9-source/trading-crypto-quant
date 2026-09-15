# Trade #8 — EMBER-SOL (TAKE PROFIT)

Ditulis otomatis oleh `~/.hermes/scripts/fm_trade_doc.py` — 2026-09-13 13:12 UTC.
Sumber angka: `data/flowmetrix.db` (buku engine) + `wallet_lamports_before/after` (chain).

| | Buku engine | Chain (masuk wallet) |
|---|---|---|
| Hasil | **$9.53127970039912** (5.306298616204652%) | **0.110576745 SOL** (~$+11.03 @ 99.79) |
| Status | `CLOSED_PROFIT` | — |
| Exit | Take-profit hit (5.31% >= 5%). | — |

- Pair / pool: `EMBER-SOL` — `G6migXbRRTvVhWLQC1KyqXDT2xjVkjcgcyDxSWt3URXG`
- Posisi: `AxQcU8Uavddqmsj2Z2Vz3Pn2xgB3F9FFEsr4JN96acC4`
- Buka: `2026-09-13 12:05:27` UTC (2026-09-13 12:05) · Tutup: `2026-09-13 12:53:15` UTC
- Harga: entry `0.00037340832445241` → exit `0.000412475097002857`
- Confidence 70.0 · coverage fee 3.1781948481146918x
- Fee belum diklaim $0.3687524813370917 · IL $-0.22207358121144846
- Sisa token: ✅ sisa token cuma dust (di bawah dust floor), tidak dijual

## Signature

| Langkah | Signature |
|---|---|
| Swap balancing (masuk) | `2UwKc1NY3X2ss5e6AuyFBZEuwqQ9t8G6SB7TGMNjhaJCwQanYrU8BsinxTRJyUv9wU8kmcCQfzQv9vuKJqSkM4ja` |
| Close posisi | `cdMoAzjWNaPjEzqiyyuUEqGB3kwafDzprtZaJvWKE6vLEp4QQp49W4pYRRw6fbwVaPguU4UtRExPdmDGWaW383R` |
| Sweep sisa token → SOL | `None` |
| Tutup ATA (rent) | `None` |
| Ledger attempt | id 7 — outcome opened, unwind none, cost None lamports |

## Postmortem engine

Price rose 10.46% in 0.8h and exited the upper bin, so the 5% take-profit closed it before fees could compound, showing that a fast directional move, not fee accrual, drove the 5.31% net gain.

## Cek ulang (read-only)

```bash
node ~/.hermes/scripts/diag/fm_balance_check.mjs
node ~/.hermes/scripts/fm_chain_sweep.mjs
FM_FLOW_LIMIT=12 node ~/.hermes/scripts/diag/fm_wallet_flow.mjs
```
