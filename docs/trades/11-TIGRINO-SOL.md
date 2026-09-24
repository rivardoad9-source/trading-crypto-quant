# Trade #11 — TIGRINO-SOL (STOP LOSS)

Ditulis otomatis oleh `~/.hermes/scripts/fm_trade_doc.py` — 2026-09-21 00:12 UTC.
Sumber angka: `data/flowmetrix.db` (buku engine) + `wallet_lamports_before/after` (chain).

| | Buku engine | Chain (masuk wallet) |
|---|---|---|
| Hasil | **$-16.481922119764665** (-8.331777433911972%) | **tidak terukur** |
| Status | `CLOSED_LOSS` | — |
| Exit | Stop-loss hit (-8.33% <= -8%). | — |

- Pair / pool: `TIGRINO-SOL` — `5TTHzu39BskPAz2Vdju6txDuKRPjUoPG5LNSkExV5CBt`
- Posisi: `AvhbuoaTHF3X2xHT4HXeCdEcLhqksPshAy5GiQnxAnZU`
- Buka: `2026-09-20 19:25:19` UTC (2026-09-20 19:25) · Tutup: `2026-09-20 23:23:47` UTC
- Harga: entry `2.3190245076737e-05` → exit `1.9010118678699e-05`
- Confidence 55.0 · coverage fee 3.2285557892181713x
- Fee belum diklaim $2.232157227724083 · IL $-0.9728723924178692
- Sisa token: ⚠️ failed — CEK wallet: sisa token mungkin masih dipegang

## Signature

| Langkah | Signature |
|---|---|
| Swap balancing (masuk) | `4jh4LbLhSoAhH7y5rezTNWsvCT1b3YJeouTTWDCeFgU4pW7yVnxoMjM9ysbziae2PupAzpQDJ6w6jLHydMd5NKx9` |
| Close posisi | `232pCn1FqZE2V5Xwrid3AJm9cMweU5S2E9Ci3E9zuhAcFhgY4NgrapstL99CW1GY5evmsExHgfZ9hqYvdNvjFG4M` |
| Sweep sisa token → SOL | `None` |
| Tutup ATA (rent) | `None` |
| Ledger attempt | id 15 — outcome opened, unwind none, cost None lamports |

## Postmortem engine

Price fell 18.03% in 4 hours, breaching the -8% stop-loss before the 2.23 USD in fees could offset the loss, proving that a wide bin range cannot protect against a fast directional dump.

## Cek ulang (read-only)

```bash
node ~/.hermes/scripts/diag/fm_balance_check.mjs
node ~/.hermes/scripts/fm_chain_sweep.mjs
FM_FLOW_LIMIT=12 node ~/.hermes/scripts/diag/fm_wallet_flow.mjs
```
