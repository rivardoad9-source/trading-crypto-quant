# Trade #4 — MANLET-SOL (TAKE PROFIT)

Ditulis otomatis oleh `~/.hermes/scripts/fm_trade_doc.py` — 2026-09-12 15:23 UTC.
Sumber angka: `data/flowmetrix.db` (buku engine) + `wallet_lamports_before/after` (chain).

| | Buku engine | Chain (masuk wallet) |
|---|---|---|
| Hasil | **$9.48894569054618** (5.289090493376018%) | **0.080026005 SOL** (~$+7.98 @ 99.67) |
| Status | `CLOSED_PROFIT` | — |
| Exit | Take-profit hit (5.29% >= 5%). | — |

- Pair / pool: `MANLET-SOL` — `68C62WPYiiNZxprbuaMj2ULXpiTDKcs5xsX7kBGnyajR`
- Posisi: `EDUquTp5ypXH7bY5BSMmNWsWmW1hFtMXJDcwcfw8uLhr`
- Buka: `2026-09-11 05:03:00` UTC (2026-09-11 05:03) · Tutup: `2026-09-11 08:21:01` UTC
- Harga: entry `1.1529770950844e-05` → exit `1.2191142410608e-05`
- Confidence 58.0 · coverage fee 7.06369042527367x
- Fee belum diklaim $4.415142875049922 · IL $-0.06974602791944202
- Sisa token: 🖐 dijual manual oleh operator

## Signature

| Langkah | Signature |
|---|---|
| Swap balancing (masuk) | `4DrUkT63GoxL5oFbqJc7MU8rGkJ81faYxxdPpgqSeXMChGB5Qc7Bc3Gbp1hAmzfea1XqVnVjJDnnqy4KGqSeRDEy` |
| Close posisi | `5jh9u2ZsGyxwf5sFp2rsrMVvzVoSVWCYut2p3LH6CdGAzrE6xZFRapBTy5jLR4DpTzec66mynoAnqYksizYxRLTb` |
| Sweep sisa token → SOL | `None` |
| Tutup ATA (rent) | `None` |
| Ledger attempt | id 1 — outcome opened, unwind clean, cost -80026005 lamports |

## Postmortem engine

Price ran 5.74% to the upper bin in 3.3h, hitting the 5% take-profit before fees of $4.42 could compound, so the lesson is that a wide 50/20 range on a live volume spike captures the move but caps upside at the target rather than the trend.

## Cek ulang (read-only)

```bash
node ~/.hermes/scripts/diag/fm_balance_check.mjs
node ~/.hermes/scripts/fm_chain_sweep.mjs
FM_FLOW_LIMIT=12 node ~/.hermes/scripts/diag/fm_wallet_flow.mjs
```
