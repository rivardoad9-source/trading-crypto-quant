# Trade #5 — EMBER-SOL (TAKE PROFIT)

Ditulis otomatis oleh `~/.hermes/scripts/fm_trade_doc.py` — 2026-09-12 15:23 UTC.
Sumber angka: `data/flowmetrix.db` (buku engine) + `wallet_lamports_before/after` (chain).

| | Buku engine | Chain (masuk wallet) |
|---|---|---|
| Hasil | **$9.661988401170516** (5.263552984882938%) | **0.047701225 SOL** (~$+4.86 @ 101.98) |
| Status | `CLOSED_PROFIT` | — |
| Exit | Take-profit hit (5.26% >= 5%). | — |

- Pair / pool: `EMBER-SOL` — `HdyjL5pE2zJqCLXFPuBthft1mGnRAPER2AjzC8Tufgom`
- Posisi: `Ai1MCg5YKxSJRWUQ7q6JvEAV9tW5yQTqHHj118VTd2no`
- Buka: `2026-09-12 15:00:45` UTC (2026-09-12 15:00) · Tutup: `2026-09-12 15:15:03` UTC
- Harga: entry `0.000164962173322913` → exit `0.000182131568819979`
- Confidence 72.0 · coverage fee 8.174203752876396x
- Fee belum diklaim $0.3456576316188633 · IL $-0.22471904062904705
- Sisa token: ✅ sisa token dijual otomatis ke SOL, rent ATA diambil

## Signature

| Langkah | Signature |
|---|---|
| Swap balancing (masuk) | `3V74RQRhD4rTMoF29TaE77qY5HZD2SCG6DTPdydW2wYbssWqKw9YmhjACn5CG7ycHS1T2XqAQLw2ezDSSeNdNZzs` |
| Close posisi | `CSghumWJgVKovraDtJbP9Myf69bt7L4s6QBF7crS1JuMPh47KbgLZgGDAVsvD8nCa31i7PCvGHpQuJJmSpCndRx` |
| Sweep sisa token → SOL | `3SiT78RBbiy9UAdvax9Hx2AwngzXru2H73ZVPVAmL1Fg1hQMWFWafjhMntzuKfZh6MPXXuPisA4DXzBPfWgRExvi` |
| Tutup ATA (rent) | `5h8b5RqhpD6j3jvEN9NbRG4cHvcd63pQ47VZ9vo7BXXX73KqpXznX5Z1GqXtamrKUtu65NjsUW8AbyDMXEqmuyvE` |
| Ledger attempt | id 3 — outcome opened, unwind clean, cost -47701225 lamports |

## Postmortem engine

Price rose 10.41% in just 0.2h and exited the upper bin, so the 5.26% take-profit closed the position before fees could compound, leaving only $0.35 earned against -$0.22 IL.

## Cek ulang (read-only)

```bash
node ~/.hermes/scripts/diag/fm_balance_check.mjs
node ~/.hermes/scripts/fm_chain_sweep.mjs
FM_FLOW_LIMIT=12 node ~/.hermes/scripts/diag/fm_wallet_flow.mjs
```
