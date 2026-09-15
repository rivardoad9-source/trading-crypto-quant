# Trade #6 — EMBER-SOL (TAKE PROFIT)

Ditulis otomatis oleh `~/.hermes/scripts/fm_trade_doc.py` — 2026-09-12 22:12 UTC.
Sumber angka: `data/flowmetrix.db` (buku engine) + `wallet_lamports_before/after` (chain).

| | Buku engine | Chain (masuk wallet) |
|---|---|---|
| Hasil | **$10.092300853324002** (5.5169082036822035%) | **0.051062270 SOL** (~$+5.19 @ 101.63) |
| Status | `CLOSED_PROFIT` | — |
| Exit | Take-profit hit (5.52% >= 5%). | — |

- Pair / pool: `EMBER-SOL` — `HdyjL5pE2zJqCLXFPuBthft1mGnRAPER2AjzC8Tufgom`
- Posisi: `AoUoL72z3PdDy8QQbkhJqKxkS8PUUnmSo3NZaAYgYj1c`
- Buka: `2026-09-12 19:36:09` UTC (2026-09-12 19:36) · Tutup: `2026-09-12 21:53:06` UTC
- Harga: entry `0.000201087968790839` → exit `0.00021766408440828`
- Confidence 72.0 · coverage fee 6.420254934732504x
- Fee belum diklaim $2.701767253324207 · IL $-0.14337924815762482
- Sisa token: ✅ sisa token dijual otomatis ke SOL, rent ATA diambil

## Signature

| Langkah | Signature |
|---|---|
| Swap balancing (masuk) | `28hBFDhQmbWVegbu4pNnnNhjUzVKeN1gLsxFUrnYqU95XhVcQNLiQRXq439c5NMJt9nbKoLLA2TB3x5bza3Cc7Xw` |
| Close posisi | `21x4kNpnJ26nLZKx65nJgCN3fRpJfUiy9MbzVmt27w8ZfB7NurH54TVVaEzZ3YxXJ1D4qQ48vjHbHLxoT1UsPH2W` |
| Sweep sisa token → SOL | `4ywcS8Hat4iFLyTyvU68SCRGHGoWyTux2niEVVuFvvcWZUoZr5gAFZtD9V2mG6h82e1sMD2rMmqa8HuV6qgKSGgj` |
| Tutup ATA (rent) | `3kBkK7ASxgXU5bY4dTuoUELP6eTEh7FqHCKEpAGjZCVFkUiKMocw3CGTyi6rm7j3ycKBCn8PKwz1p1JQ5CNcNYiH` |
| Ledger attempt | id 4 — outcome opened, unwind clean, cost -51062270 lamports |

## Postmortem engine

Price rose 8.24% in 2.3h and exited the upper bin, so the 5% take-profit closed it before fees could compound further, showing that a tight TP on a fast mover caps upside more than IL ever threatened it.

## Cek ulang (read-only)

```bash
node ~/.hermes/scripts/diag/fm_balance_check.mjs
node ~/.hermes/scripts/fm_chain_sweep.mjs
FM_FLOW_LIMIT=12 node ~/.hermes/scripts/diag/fm_wallet_flow.mjs
```
