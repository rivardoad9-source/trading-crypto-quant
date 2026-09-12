# TRADE #1 — EMBER-SOL, 12 Sep 2026: putaran penuh pertama yang dikerjakan engine sendiri

**Status:** ✅ sukses — entry → monitor → take-profit → close → **jual sisa token → ambil rent ATA**,
semuanya otomatis, tanpa satu pun transaksi manual operator.

Ini baris pertama dalam sejarah engine di mana langkah terakhir (konversi sisa token jadi SOL)
**tidak** dikerjakan manusia. Pembanding: trade 11 Sep (MANLET-SOL, TP +5.29%) menutup posisi
dengan benar tapi menyisakan ~0.84 SOL dalam bentuk token MANLET yang baru terjual **37 menit
kemudian oleh operator** — lihat `docs/audits/2026-09-11-exit-path-audit.md`.

## 1. Ringkasan

| | Buku engine | Chain (yang beneran masuk wallet) |
|---|---|---|
| Hasil | **+$9.66** (+5.2636%) | **+0.047701 SOL** (+2.65% dari notional 1.8 SOL) ≈ $4.87 |
| Notional | 1.8 SOL (0.9 SOL + 0.9 SOL ditukar ke token) | — |
| Durasi | buka 15:00:45 UTC → tutup 15:15:03 UTC | 14 menit 18 detik |
| Exit | `Take-profit hit (5.26% >= 5%)` | TP +5% V1.1, tanpa perubahan parameter |

Wallet: `FaVHg7bThap7wcF9G7kjSjrDsMbVrgUkpG6twzi1yQKi`
`2 946 203 635 → 2 993 904 860` lamports. Dibaca ulang independen setelah semua tx landed:
**2.993904861 SOL** (selisih 1 lamport dari catatan DB = pembulatan, bukan uang hilang).
**0 token** tersisa di wallet (dicek `fm_chain_sweep.mjs` + `diag/fm_balance_check.mjs`, keduanya bersih).

## 2. Kelima transaksi (delta SOL wallet per tx, dari `fm_wallet_flow.mjs`)

| Waktu (UTC) | Tx | Δ SOL | Fungsi |
|---|---|---|---|
| 15:00 | `3V74RQRhD4rTMoF29TaE…` | **−0.901496** | balancing swap 0.9 SOL → token |
| 15:00 | `4H44SELtakBaCdF9cHDp…` | **−0.941918** | open posisi (leg wSOL 0.9 + leg token + rent) |
| 15:15 | `CSghumWJgVKovraDtJbP…` | **+1.102657** | close: remove liquidity + claim + close account |
| 15:15 | `3SiT78RBbiy9UAdvax9H…` | **+0.786983** | **sweep sisa token → SOL (gate terakhir)** |
| 15:15 | `5h8b5RqhpD6j3jvEN9Nb…` | **+0.001475** | tutup ATA kosong, rent kembali |
| | **total** | **+0.047701** | = `cost_lamports −47 701 225` (negatif: trade ini MENAMBAH SOL) |

Ledger engine: `live_execution_attempts.id 3` → `outcome='opened'`, `unwind='clean'`,
`cost_lamports = -47701225`.

## 3. Detail posisi

- Pool `HdyjL5pE2zJqCLXFPuBthft1mGnRAPER2AjzC8Tufgom` (EMBER-SOL), jalur **narrow, 40 bin**
- Posisi `Ai1MCg5YKxSJRWUQ7q6JvEAV9tW5yQTqHHj118VTd2no`
- Entry `0.000164962173322913`, range `[0.0000907292, 0.000189706]`, exit `0.000182131568819979`
- Confidence 72.0 · safety PASS (mint+freeze authority revoked, top-10 22.65%)
- Fee 24h ratio 8.17× (gate butuh ≥2.5×) · est. fee 24h $36.68
- `unclaimed_fee_usd` $0.3457 · IL −$0.2247 · `position_value_change_usd` $9.3163
- Postmortem engine: *"Price rose 10.41% in just 0.2h and exited the upper bin, so the 5.26%
  take-profit closed the position before fees could compound."*

## 4. Yang membuktikan jalur exit jalan (log mesin, urutannya penting)

```
[live] EMBER-SOL: position Ai1MCg5Y… opened (4H44SELt…)
[live] EMBER-SOL: position Ai1MCg5Y… closed (1 tx, final CSghumWJ…)
[live] EMBER-SOL: swept 4498666263 base units of 5dvXTZ5q… back to SOL (~0.788421 SOL, 3SiT78RB…)
[live] EMBER-SOL: closed the empty 5dvXTZ5q… account AikF54no…, rent returned (5h8b5Rqh…)
[dlmm] closed EMBER-SOL — CLOSED_PROFIT — net $9.66 (5.26%) — CSghumWJ…
[fast-monitor] checked 1, closed 1, stale 0
```

Baris `swept` dan `closed the empty … account` itu **baru** — dua baris itulah yang tidak pernah ada
di trade 11 Sep. Kolom DB yang mengonfirmasi: `residual_sweep='swept'`, `sweep_signature=3SiT78RB…`,
`ata_close_signature=5h8b5Rqh…`.

## 5. Biaya gate terakhir — temuan penting (bukan bug)

Angka buku (+5.26%) **hampir dua kali** angka chain (+2.65%). Selisih ~2.6 pp ≈ 0.047 SOL ≈ $4.8.
Rinciannya:

- Sweep menjual `4 498 666 263` base unit token dan menerima **0.786983 SOL**.
- Harga pool saat exit `0.000182132` → nilai "seharusnya" 0.81929 SOL.
- Jadi penjualan tereksekusi **~3.95% di bawah harga pool yang dilaporkan**. Quote Jupiter-nya sendiri
  sudah 0.788421 SOL (jadi eksekusi hanya 0.18% di bawah quote — Jupiter bekerja benar).
- Penyebab: **bin step pool 2%** (spread bid/ask lebar) + impact di pool TVL $82.8k untuk jualan ~0.79 SOL.
- Sisa selisih: slippage/fee swap masuk (−0.0015 SOL), priority fee, dan sell/claim dua arah.

**Konsekuensi yang harus diingat:** di pool bin-step 2%, TP +5% ≈ **+2.6% bersih** yang sampai ke
wallet. `realized_pnl_usd` di buku adalah angka pool, bukan angka wallet — selalu sebut dua angka
(lihat skill flowmetrix-ops). Kandidat perbaikan (BELUM dikerjakan, nunggu keputusan operator):
preferensi bin-step lebih kecil untuk pool yang keluar, atau TP lebih tinggi, atau keluar dengan
limit/route lain.

## 6. Cara mengecek ulang (semua read-only)

```bash
node ~/.hermes/scripts/diag/fm_balance_check.mjs              # SOL + token wallet
node ~/.hermes/scripts/fm_chain_sweep.mjs                     # posisi/token nyangkut (diam = bersih)
FM_FLOW_LIMIT=8 node ~/.hermes/scripts/diag/fm_wallet_flow.mjs # delta SOL per tx
```

DB: `simulated_positions.id 5` + `live_execution_attempts.id 3` (buka read-only).

## 7. Tindak lanjut

1. ✅ Sweep residual + reclaim rent ATA — terbukti live (dokumen ini).
2. ✅ Retry otomatis kalau sweep gagal — `scripts/retryResidualSweep.ts` + cron Hermes
   `fm_residual_selfheal.py` (10 menit, 0 token).
3. ⬜ SL −8% **belum pernah kena** di live (kode + test ada; jalur eksekusinya sama persis dengan TP
   yang barusan jalan — `dlmmTraderAgent.ts:487` → `closeLivePosition` yang sama).
4. ⬜ Biaya konversi exit di pool bin-step lebar (§5) — keputusan operator.
