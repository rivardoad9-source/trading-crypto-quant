# Trade #10 — DOGE-1-SOL (TAKE PROFIT)

Ditulis otomatis oleh `~/.hermes/scripts/fm_trade_doc.py` — 2026-09-14 05:12 UTC.
Sumber angka: `data/flowmetrix.db` (buku engine) + `wallet_lamports_before/after` (chain).

| | Buku engine | Chain (masuk wallet) |
|---|---|---|
| Hasil | **$9.187144106583455** (5.1440928725074775%) | **0.057457989 SOL** (~$+5.70 @ 99.22) |
| Status | `CLOSED_PROFIT` | — |
| Exit | Take-profit hit (5.14% >= 5%). | — |

- Pair / pool: `DOGE-1-SOL` — `ErwEeF8y8uLR7LkJcL3xRUuN1d8SrMLZJB92Ydq8vfdw`
- Posisi: `Gdepc2YQuTYq5Dy7G4xkwjdkkjt6VLug1kEKsHXnUFtL`
- Buka: `2026-09-14 00:00:26` UTC (2026-09-14 00:00) · Tutup: `2026-09-14 05:01:54` UTC
- Harga: entry `1.859340061138e-06` → exit `1.997577398854e-06`
- Confidence 56.0 · coverage fee 2.5704190794361454x
- Fee belum diklaim $2.6670738383357686 · IL $-0.11474963333859035
- Sisa token: ✅ sisa token dijual otomatis ke SOL, rent ATA diambil

## Signature

| Langkah | Signature |
|---|---|
| Swap balancing (masuk) | `5SMWZDJ3PivPe96852CVhPERQeKCXtuB2xWbwNMnfhkqkk9vwsmbie8jhbUPrDus2JVWWYsGVGZ85b3Hnw3eDCEY` |
| Close posisi | `PeFCZ39w6ihUDmyV52iovPcJtmhe1QMCdfd2jmBWWouFb5uLkeGByVyxaWUJiR5PwJHFzaKRDh1hCQvHH3ZrPgw` |
| Sweep sisa token → SOL | `3d8vYRvCWG1eucvcLkg1LhJqZENFtsxEdEzUwGUyr8wwCZ88YfmTgV2SBLc9SE6vEZ7bT1Ypk8tDY8MMCb4mpp7Y` |
| Tutup ATA (rent) | `3vQtg9sov6he6vqoqrmSDTexJk4i6HEmgpmQjmsuxV6MkjS11EwsXkcy3pvZQQdJgka5nM4z4gH6hhCcijQqzmRf` |
| Ledger attempt | id 9 — outcome opened, unwind clean, cost -57457989 lamports |

## Postmortem engine

Price rose 7.43% in 5 hours and exited the upper bin, so the 5.14% net gain came mostly from price appreciation rather than the 2.67 USD in fees, which barely offset the -0.11 USD impermanent loss.

## Cek ulang (read-only)

```bash
node ~/.hermes/scripts/diag/fm_balance_check.mjs
node ~/.hermes/scripts/fm_chain_sweep.mjs
FM_FLOW_LIMIT=12 node ~/.hermes/scripts/diag/fm_wallet_flow.mjs
```
