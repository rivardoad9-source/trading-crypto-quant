# 14 Sep 2026 — Work order #2: exit-cost observability (A) + universe per window (B)

Branch `work/exit-observability-and-window-universe`. Work order:
`docs/prompts/` (work order #2, commit `787fb49`).
Output mentah: `backtest_window_universe_summary.json`, `backtest_window_universe_report.txt`.

Tidak ada deploy, restart pm2, perubahan `.env`, atau transaksi on-chain. Default `env.ts` /
`onchainExecutor.ts` dan test baseline V1.1 tidak disentuh. Tidak ada file baru yang meng-import
`onchainExecutor.ts`.

**Test:** `npm run typecheck` hijau. `npm test` (lokal, Windows): **956 test, 954 pass** — satu-satunya
kegagalan adalah 2 test `EPERM` di hook `after` (`exitSlippage`, `postSwapReadRetry`) yang sudah gagal
di baseline lokal sebelum work order ini (file SQLite masih terbuka saat temp dir dihapus di Windows).

## Ringkasan

| | Status | Angka kunci |
|---|---|---|
| A1 tabel `exit_economics` | selesai | migrasi `db.ts`, `UNIQUE(position_id)` |
| A2 tulis otomatis tiap close live | selesai | di `settleLiveCloses`, sesudah row ditutup, di luar mutex, tidak pernah throw |
| A3 backfill | selesai, jalan di mainnet | 6 row; **4 terukur**, 2 null + alasan |
| A4 report + refit + stabilitas | selesai | slope bin-step 0.68 stabil; **~20 observasi** untuk error relatif ≤25% |
| A5 test | selesai | `exitEconomics.test.ts` 15 test |
| B1–B5 universe per window | selesai | 3 window, universe 32 / 13 / 11 pool |
| Jawaban TP/gate di semua window | **BELUM BISA DIVERIFIKASI** | tidak ada window yang punya ≥8 trade di KEDUA paruh |

## A. Exit-cost observability

### A3 — backfill dari signature yang tersimpan (dibaca dari mainnet, read-only)

`npm run exitcosts:backfill -- --from=csv:exports/trades.csv` (di host live: tanpa flag, baca DB).
Dijalankan dua kali: run 1 menulis 6 row, run 2 menulis 0 (idempoten).

| posisi | bin_step | sweep in | SOL diterima | nilai di harga pool | exit_cost_bps (per notional) | konsesi per kaki | fee tx exit |
|---|---|---|---|---|---|---|---|
| MANLET #4 | 80 | — | — | — | **null** | **null** | 13 430 lamports |
| EMBER #5 | 200 | 4 498 666 263 | 786 995 667 | 819 349 144 | 179.7 | **394.9 bps** | 39 000 |
| EMBER #6 | 200 | 4 155 692 118 | 888 210 240 | 904 544 920 | 90.7 | **180.6 bps** | 39 398 |
| EMBER #7 | 200 | 2 137 989 221 | 787 144 762 | 794 322 607 | 39.9 | **90.4 bps** | 55 000 |
| EMBER #8 | 100 | — | — | — | **null** | **null** | 133 000 |
| NEARKAT (gagal open) | 400 | — | 822 488 514 | 848 291 729 | 143.1 | **143.1 bps** | 24 192 |

- MANLET: `residual_sweep=operator` — sisa token dijual tangan, penjualannya tidak tercatat → null.
- EMBER #8: `residual_sweep=dust`, tanpa signature sweep → null. (Pool EMBER yang berbeda, bin_step 100.)
- **Validasi parser:** EMBER #5 keluar 394.9 bps = persis "3.95% di bawah harga pool" di
  `docs/trades/2026-09-12-ember-sol-first-auto-round-trip.md`; NEARKAT 143.1 bps/kaki = 1.43% observasi lama.
- **Titik baru:** EMBER #6 (180.6 bps) dan #7 (90.4 bps). Konsesi di pool yang SAMA (bin_step 200)
  berkisar **90–395 bps** — bin_step sendirian tidak menjelaskan biaya exit.

### A4 — refit konstanta (`npm run report:exitcosts`, TIDAK mengubah konstanta)

| set | n | a (fit, per bin-step%) | b (fit, per TVL%) | slope bin-step saja | c (envelope) |
|---|---|---|---|---|---|
| SHIPPED (3 titik tangan) | 3 | 0.631 | 1.015 | 0.684 | 1.975 |
| ledger saja | 4 | 0.000 | 31.262 | 0.680 | 1.974 |
| ledger + titik tangan yang belum ada di ledger (MANLET) | 5 | 1.055 | 0.739 | 0.682 | 1.974 |

- Slope bin-step-saja **stabil di 0.68** dengan data baru; envelope tetap **1.974** (EMBER #5 yang menentukan).
- Fit dua-variabel **tidak stabil** (a berayun 0.00 → 1.06, b 0.74 → 31): tiga titik EMBER punya
  bin_step yang sama, jadi regresi tidak bisa memisahkan efek bin_step dari efek ukuran/TVL.
  **Rekomendasi: jangan ganti konstanta sekarang.**

Stabilitas (bootstrap 1000 draw dari 5 titik yang ada, slope bin-step saja):

| n | mean slope | std error | error relatif |
|---|---|---|---|
| 3 | 0.835 | 0.433 | 52% |
| 5 | 0.762 | 0.322 | 42% |
| 8 | 0.724 | 0.235 | 32% |
| 12 | 0.715 | 0.183 | 26% |
| 20 | 0.707 | 0.141 | 20% |
| 30 | 0.694 | 0.109 | 16% |
| 50 | 0.686 | 0.082 | 12% |

**Error relatif ≤25% butuh ~20 observasi; ≤10% butuh ~72 (ekstrapolasi).** Itu batas bawah: bootstrap
hanya me-resample titik yang ada (bin_step 80–400), tidak bisa melihat kondisi pasar yang belum terjadi.
Dengan ~1–2 close live per hari, ~20 titik kira-kira 2–3 minggu trading.

### A2 — tulis otomatis

Setiap close live sekarang menulis row setelah row posisi ditutup, di jalur `settleLiveCloses` yang
sama. Hanya ada satu jalur tulis (test mengunci). Close yang di-inject di test tidak menyentuh jaringan.
Belum pernah terjadi close live sejak kode ini ada — **belum terbukti dengan close sungguhan.**

## B. Universe per window

`npm run backtest:integrity -- --per-window-universe --windows=3 --days=91` (default OFF; jalur lama
tidak berubah — test mengunci satu-satunya early return ber-flag).

### Universe dan coverage

| window | periode | kandidat | universe | coverage | live-eligible | k | ditolak: lahir sesudah / <24 bar / band TVL / di luar top N |
|---|---|---|---|---|---|---|---|
| W1 | 14 Jun → 13 Sep 2026 | 96 | 32 | 32/32 | 14 | 0.195 | 0 / 6 / 47 / 11 |
| W2 | 15 Mar → 14 Jun 2026 | 96 | **13** | **13/32** | 6 | 0.195 | 0 / 4 / 79 / 0 |
| W3 | 14 Des 2025 → 15 Mar 2026 | 96 | **11** | **11/32** | 7 | 0.195 | 0 / 14 / 71 / 0 |

Dibanding run lama: W2 dulu **7 pool / 0 trade** karena universe diambil dari pool yang aktif hari ini.
Sekarang 0 pool yang lahir sesudah window ikut terambil (kolom pertama), tapi **W2/W3 hanya 13 dan 11 pool
yang lolos band TVL** — mayoritas kandidat ditolak band (79 dan 71).

### Baseline V1.1 per window (live-eligible | full | selisih) — TIDAK dirata-rata

| window | akuntansi | elig trade | elig net | full trade | full net | selisih | IS/OOS trade | status bar |
|---|---|---|---|---|---|---|---|---|
| W1 | LAMA | 6 | $95.35 | 23 | −$49.20 | −$144.55 | 0/6 | belum bisa diverifikasi |
| W1 | exit fit | 6 | $93.48 | 22 | −$75.78 | −$169.26 | 0/6 | belum bisa diverifikasi |
| W1 | exit envelope | 6 | $88.50 | 22 | −$74.17 | −$162.68 | 0/6 | belum bisa diverifikasi |
| W2 | semua | 0 | $0 | 0 | $0 | $0 | 0/0 | belum bisa diverifikasi |
| W3 | semua | 0 | $0 | 0 | $0 | $0 | 0/0 | belum bisa diverifikasi |

Catatan: di W1 arm live-eligible (+$93) justru lebih baik dari full universe (−$76) — kebalikan dari
temuan 13 Sep. Dengan 6 trade, itu belum berarti apa-apa.

### Varian TP & gate di W1 (satu-satunya window yang ber-trade), live-eligible

| varian | exit fit: trade / net / Δ vs base | exit envelope: trade / net / Δ vs base |
|---|---|---|
| V1.1 (TP 5, cov 2.5) | 6 / $93.48 / — | 6 / $88.50 / — |
| TP 6% | 4 / −$26.35 / −$119.84 | 4 / −$27.50 / −$116.00 |
| TP 8% | 4 / −$26.35 / −$119.84 | 4 / −$27.50 / −$116.00 |
| TP 10% | 4 / −$26.35 / −$119.84 | 4 / −$27.50 / −$116.00 |
| coverage 2.0x | 6 / $93.48 / +$0.00 | 6 / $88.50 / +$0.00 |
| coverage 1.5x | 33 / $1.13 / −$92.36 | 33 / −$14.83 / −$103.33 |
| gate pakai biaya exit bin_step | 34 / $69.87 / −$23.61 | 6 / $88.50 / +$0.00 |

W2/W3: 0 trade di arm live-eligible untuk semua varian (full universe W2: cov 1.5x 18 trade +$39.55 fit /
+$25.40 envelope; gate bin_step 11 trade +$42.00 fit).

### Jawaban

**Naikin TP (6/8/10%) dan/atau gate 2.0x/1.5x menaikkan NET arm live-eligible di SEMUA window?**
→ **BELUM BISA DIVERIFIKASI** untuk semua 12 kombinasi (2 model biaya × 6 varian). Tidak ada window yang
memenuhi bar (≥8 trade di KEDUA paruh). Satu-satunya bukti yang ada (W1, 4–33 trade) menunjuk ke arah
**sebaliknya**: setiap varian TP dan cov 1.5x menurunkan net live-eligible. Itu bukan temuan — sampelnya
terlalu tipis — tapi juga bukan alasan untuk menaikkan TP.

## Bug yang ketemu dan diperbaiki selama pengerjaan (semua sebelum angka di atas)

1. **Ingest dimatikan sistem karena memori (2×).** Semua bar ditahan di memori + file partial 17 MB
   ditulis ulang tiap pool di mesin RAM 6 GB. Diperbaiki: file bar per pool (`.cache/window_bars/`),
   partial lama dimigrasi tanpa fetch ulang. Proses ingest sendiri hanya ~93 MB setelahnya; shell
   background tetap sempat dimatikan karena memori SISTEM rendah, prosesnya tetap selesai.
2. **0 trade di 3 window — artefak pemilihan kandidat.** Kandidat diurutkan lifetime volume → 95/96 pool
   raksasa (SOL-USDC dkk), k = 1.4–1.8. Diperbaiki: survivor pakai band TVL strategi, cap dibagi per cohort.
3. **k per window bias umur.** Window lama hanya berisi survivor tua → k 2.6 / 4.3 → 0 trade. Diperbaiki:
   satu k (window terbaru, survivor semua umur) untuk semua window, cache diseleksi ulang dari file lokal.
4. Signature NEARKAT di `src/` memicu test anti-secret (base58 86–90 char) — dipindah ke
   `docs/incidents/known-failed-opens.json`, test tidak diubah.

## Yang gw nggak bisa klaim

- **Kalibrasi biaya exit:** 4 titik terukur, 3 di pool + bin_step yang sama; fit dua-variabel tidak stabil.
  Harga pool yang dipakai adalah harga saat KEPUTUSAN exit, bukan saat sweep landing (EMBER bergerak cepat).
  TVL saat exit tidak tercatat untuk trade lama — dipakai TVL entry sebagai proxy. Fee exit hanya tx close
  FINAL yang tersimpan; tx close sebelumnya (close multi-tx) tidak terhitung.
- **Universe per window:** k = rasio TVL/volume HARI INI dipakai untuk window 3–9 bulan lalu. Survivor
  difilter band TVL hari ini (bias ke pool yang masih hidup dan berukuran sedang hari ini). Kandidat dead
  cohort hanya dari walk urut-pembuatan 40 halaman; pool yang mati dan lahir sebelum walk tidak terlihat.
- **W3 melewati batas data gratis ~208 hari** (window mulai ~274 hari lalu); 14 kandidat ditolak karena
  <24 bar di window. Coverage W2/W3 13 dan 11 dari 32 — terlalu kecil untuk kesimpulan.
- **Split IS/OOS W1** jatuh di 30 Jul; paruh pertama hanya 11 pool punya data → IS selalu 0 trade.
- **Gas** 0.004 SOL/tx dan swap 0.25%/kaki adalah asumsi, bukan seri historis.
- **Profil akun** $300 / 63% / 1 posisi dari work order, bukan `LIVE_CAPITAL_SOL` di `.env` lokal
  (header runner menandainya "NOT THE LIVE PROFILE").
- **A2 dan P1 (work order #1)** belum pernah jalan dengan close live sungguhan.

## Yang dibutuhkan supaya jawabannya bisa "ya/tidak"

1. **~20 observasi exit live** (A2 mengumpulkannya otomatis) sebelum konstanta `exitCost.ts` diganti.
2. **Universe window lama yang lebih besar**: naikkan `--candidates` (mis. 200) dan/atau kedalaman walk
   dead cohort, supaya W2/W3 punya ≥32 pool yang lolos band — biaya: ingest ~2–3 jam, memori aman dengan
   file per pool.
3. Data OHLCV >208 hari butuh `COINGECKO_PRO_API_KEY` (jalur itu belum pernah dieksekusi di repo ini).
