# Trade #7 — EMBER-SOL (TAKE PROFIT)

Ditulis otomatis oleh `~/.hermes/scripts/fm_trade_doc.py` — 2026-09-13 12:12 UTC.
Sumber angka: `data/flowmetrix.db` (buku engine) + `wallet_lamports_before/after` (chain).

| | Buku engine | Chain (masuk wallet) |
|---|---|---|
| Hasil | **$10.368053181242884** (5.675465114922589%) | **0.066753919 SOL** (~$+6.77 @ 101.49) |
| Status | `CLOSED_PROFIT` | — |
| Exit | Take-profit hit (5.68% >= 5%). | — |

- Pair / pool: `EMBER-SOL` — `HdyjL5pE2zJqCLXFPuBthft1mGnRAPER2AjzC8Tufgom`
- Posisi: `83gui5YitN775MUovNnRJzSwDtDFkjrz1maQGV65LPG6`
- Buka: `2026-09-13 06:32:52` UTC (2026-09-13 06:32) · Tutup: `2026-09-13 11:17:39` UTC
- Harga: entry `0.000343234334544311` → exit `0.000371527882126961`
- Confidence 72.0 · coverage fee 3.913860466715288x
- Fee belum diklaim $2.987700381242926 · IL $-0.14318173664781406
- Sisa token: ✅ sisa token dijual otomatis ke SOL, rent ATA diambil

## Signature

| Langkah | Signature |
|---|---|
| Swap balancing (masuk) | `4kBzR5Xabbjk81aJeWYonfGiAGMjJ2rhkvoUCmVcU6n8uQweD7tz6DJ2jWuw7y8kbuYjtHUh5iyiVjjBJCr7sX8j` |
| Close posisi | `5yPvakrLZ8GYsacMafB6pxsn5UyXiBNA7XVyeUxGdZPyCMqK5Y6ozUsRZDQLZeH9tRW1aBFP6gTAhZyBR7ib1AVe` |
| Sweep sisa token → SOL | `3XoiQLUd7XaK1axtNJbJTYQQKoF7NvS8ZsKXi71DWHmGJnpQDQDM1Yhmuzpqgb8tkXU1eyCFaLZJCdqWtaZtvPpH` |
| Tutup ATA (rent) | `2pKfrms197rsCwqXZvmdn9P8rKdpfzxqkL8UN6gJehxGbm84ekuEoYQcFDqepSgQSkhDw4UodcjbSbwu2CQ8wKEH` |
| Ledger attempt | id 6 — outcome opened, unwind clean, cost -66753919 lamports |

## Postmortem engine

Price rose 8.24% in 4.7h and exited the upper bin range, so the 5.68% net gain came almost entirely from price appreciation rather than the 2.99 USD in fees, which barely covered the 0.14 USD impermanent loss.

## Cek ulang (read-only)

```bash
node ~/.hermes/scripts/diag/fm_balance_check.mjs
node ~/.hermes/scripts/fm_chain_sweep.mjs
FM_FLOW_LIMIT=12 node ~/.hermes/scripts/diag/fm_wallet_flow.mjs
```
