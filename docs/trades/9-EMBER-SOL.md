# Trade #9 — EMBER-SOL (STOP LOSS)

Ditulis otomatis oleh `~/.hermes/scripts/fm_trade_doc.py` — 2026-09-13 20:12 UTC.
Sumber angka: `data/flowmetrix.db` (buku engine) + `wallet_lamports_before/after` (chain).

| | Buku engine | Chain (masuk wallet) |
|---|---|---|
| Hasil | **$-15.211722441721639** (-8.413097971197189%) | **-0.187158488 SOL** (~$-18.80 @ 100.45) |
| Status | `CLOSED_LOSS` | — |
| Exit | Stop-loss hit (-8.41% <= -8%). | — |

- Pair / pool: `EMBER-SOL` — `HdyjL5pE2zJqCLXFPuBthft1mGnRAPER2AjzC8Tufgom`
- Posisi: `C2UjURb4vNMtFPy86qMwkvpUwqnpYZPY4ZjJFf6GccsA`
- Buka: `2026-09-13 15:38:24` UTC (2026-09-13 15:38) · Tutup: `2026-09-13 19:55:07` UTC
- Harga: entry `0.000402153727950912` → exit `0.000329906127012987`
- Confidence 58.0 · coverage fee 2.8687278721638805x
- Fee belum diklaim $1.8330898329310994 · IL $-0.8826885765997432
- Sisa token: ✅ sisa token dijual otomatis ke SOL, rent ATA diambil

## Signature

| Langkah | Signature |
|---|---|
| Swap balancing (masuk) | `5YQ5ZxM8ngu2Yo3Y4NKL7AWq29ihVxhknuPNE4eSL4a5yWg8Qcdxjxub5KbFGGQ34mAQbtmKy7iqWAAec4ahdTLR` |
| Close posisi | `5GiYhZ6GngQoZTbcsrtFSqsS5i1eqNZNg9rZHNkewLY2yLo9QeVR467mLNatMVMTCQh3S88Jinbnc4jzAWcv9LUA` |
| Sweep sisa token → SOL | `JP76gUVLwPuuSwX7tR1Vhw7rWRCATTQJW7TDvr1EQNXvJE3qqPfUeu9NE1vXetndLZspzAf4pLSG5dqNtC63uzJ` |
| Tutup ATA (rent) | `4fHfU1td5pPouyjazDVbxhpP51v3V6vf4mtALsteGUuFwM3VfkhbzGZiHrk6N8HeZrTSCYwbLzb5VKSs8HdjxETJ` |
| Ledger attempt | id 8 — outcome opened, unwind clean, cost 187158488 lamports |

## Postmortem engine

Price fell 17.97% in 4.3 hours, exiting the bin range and hitting the -8% stop-loss before $1.83 in fees could offset the loss, so the lesson is that a 58-confidence entry with a wide range still fails when price moves nearly 18% against…

## Cek ulang (read-only)

```bash
node ~/.hermes/scripts/diag/fm_balance_check.mjs
node ~/.hermes/scripts/fm_chain_sweep.mjs
FM_FLOW_LIMIT=12 node ~/.hermes/scripts/diag/fm_wallet_flow.mjs
```
