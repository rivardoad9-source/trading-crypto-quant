# 13 Sep 2026 — Backtest integrity: V1.1 dengan biaya & universe yang live benar-benar hadapi

Branch `work/backtest-integrity-2026-09-13`. Work order:
`docs/prompts/claude-work-order-2026-09-13-backtest-integrity-and-exit-path.txt`.
Output mentah: `backtest_integrity_report.txt`, `backtest_integrity_summary.json`
(`npm run backtest:integrity -- --dataset=.cache/historical_data_integrity.json --days=91 --windows=2`).

Tidak ada deploy, restart pm2, perubahan `.env`, atau transaksi on-chain. Default `env.ts` dan
test baseline V1.1 tidak disentuh.

**Test:** `npm run typecheck` hijau. `npm test` (lokal, Windows): **928 test, 926 pass, 2 gagal** —
`exitSlippage` dan `postSwapReadRetry`, sudah gagal SEBELUM perubahan apa pun (baseline lokal
882/884): `EPERM` saat `rmSync` di hook `after` karena file SQLite masih terbuka di Windows.
Tidak ditambal.

## Jawaban P0

**Naikin TP (6/8/10%) atau ngubah gate (2.0x/1.5x) menaikkan NET arm live-eligible di KEDUA
window?** → **Belum bisa diverifikasi, jadi TIDAK.** Tidak ada varian yang lolos bar OOS bahkan di
W1 saja, dan W2 kosong.

| W1 (14 Jun–13 Sep), biaya exit fit / envelope | trade | net live-eligible | Δ vs V1.1 | OOS |
|---|---|---|---|---|
| V1.1 (TP 5, cov 2.5) | 59 | $268.72 / $217.33 | — | gagal |
| TP 6% | 48 | $213.14 / $180.49 | −$55.57 / −$36.83 | gagal |
| TP 8% | 42 | $362.92 / $337.35 | +$94.20 / +$120.03 | gagal |
| TP 10% | 42 | $331.65 / $310.53 | +$62.93 / +$93.20 | gagal |
| cov 2.0x | 61 | $269.97 / $211.58 | +$1.25 / −$5.74 | gagal |
| cov 1.5x | 73 | $362.01 / $287.53 | +$93.29 / +$70.21 | gagal |

"Gagal" = tidak memenuhi payoff > 1 **dan** expectancy > 0 di kedua paruh window (split tengah W1,
IS 12–15 trade). TP 8/10% naik di W1, tapi OOS gagal dan hanya satu window → bukan temuan.

### Baseline lama vs baru (W1, $300 / 63% / 1 posisi / gas 0.004 SOL)

| akuntansi | live-eligible | full | selisih |
|---|---|---|---|
| LAMA (swap gratis, exit flat 2% hanya exit paksa) | 61 trd, $312.28 | 72 trd, $566.99 | +$254.71 |
| + swap 0.25%/kaki | 59 trd, $207.28 | 59 trd, $207.28 | $0 |
| + swap, exit flat 2% SEMUA exit | $198.42 | $198.42 | $0 |
| + swap, exit bin_step (fit) | $268.72 | $268.72 | $0 |
| + swap, exit bin_step (envelope) | $217.33 | $217.33 | $0 |

- **Turun karena biaya** (full, lama → baru): −$298.27 (fit) / −$349.66 (envelope).
- **Hilang karena universe:** $254.71 di akuntansi lama. Begitu swap diberi biaya, pool tanpa wSOL
  (4 kaki swap) berhenti lolos gate, jadi selisihnya jadi $0.
- Universe: 23 / 32 pool live-eligible — 8 `noWsol`, 1 token screen (KNOTS-SOL, transfer fee 3%).

### Kalibrasi biaya exit (per kaki, bersih dari transfer fee)

| obs | bin_step | notional/TVL | observed | fit | envelope |
|---|---|---|---|---|---|
| MANLET-SOL | 80 | 0.206% | 0.60% | 0.71% | 1.58% |
| EMBER-SOL | 200 | 0.097% | 3.95% | 1.36% | 3.95% |
| NEARKAT-SOL | 400 | 0.180% | 1.43% | 2.70% | 7.90% |

fit = 0.631%/bin-step% + 1.015%/TVL% · envelope = 1.975%/bin-step%.

### Net saat TP +5% setelah biaya (notional $189, TVL $100k)

| bin_step | net fit | net envelope |
|---|---|---|
| 50 | 4.20% | 3.96% |
| 100 | 4.04% | 3.46% |
| 200 | 3.72% | 2.46% |
| 300 | 3.40% | 1.44% |
| 400 | 3.08% | **0.42%** |

Semua bin_step sampai 400 masih positif. bin_step 200 envelope +2.46% cocok dengan EMBER di chain
(+2.65%). TP yang lompat melewati +5% antar bar menaikkan angka ini.

## Temuan yang harus diketahui

1. **Bug lama di engine: slippage exit paksa dihitung dua kali.** Nilai posisi diambil dari harga yang
   sudah dipotong slippage, lalu potongan yang sama dikurangkan lagi sebagai `slippageCostUsd`. Angka
   lama pesimis di exit paksa, persis sebesar `totalSlippageCostUsd`. Sengaja dibiarkan di jalur legacy
   supaya run lama reproducible (benchmark 8 Sep bit-identik: 42 trade, +$351.77715333489346); jalur
   model menghitung sekali; kedua perilaku dikunci test. Ini sebabnya "exit fit" bisa lebih tinggi dari
   "+swap".
2. **W2 (15 Mar–14 Jun) hanya 7 pool dan 0 trade.** Universe dipilih dari pool yang aktif di sekitar
   window terbaru, dan kebanyakan belum lahir di W2. Batasnya bukan kedalaman data 208 hari, tapi cara
   universe dipilih. Window kedua yang sah butuh universe yang dibangun ulang per window (~1 jam ingest).
   Belum dikerjakan.

## Yang dibangun

- **P0.1** `src/backtest/liveEligibility.ts` — ekstensi mint via `readTokenExtensions` +
  `assessTokenFeeScreen` (tanpa decoder/kebijakan kedua), fail-closed, disimpan per pool saat ingest,
  3 baris (live-eligible / full / selisih) di setiap runner.
- **P0.2** `src/backtest/exitCost.ts` — kalibrasi + band fit/envelope; `exitCostModel` (akuntansi) dan
  `gateUsesExitCostModel` (gate) switch terpisah, default mati.
- **P0.3/P0.5** `npm run backtest:integrity` — 2 window non-overlap, lama vs baru, varian + status OOS.
- **P0.4** `sweep:entry` / `sweep:exits`: `--days --capital --sizepct --concurrent --gas`
  (+ `--swapslip --swapgas --exitcost`); tanpa flag config identik (ada test).
- **P1.1** Semua rung Jupiter gagal → jual langsung ke pool DLMM posisi itu. Quote pool ditolak sebelum
  signing bila di bawah estimasi Jupiter dikurangi cap exit; floor tetap. Gagal juga → page berisi mint,
  amount, estimasi SOL, error Jupiter, error pool.
- **P1.2** `closeLivePosition` baca akun posisi dulu: sudah hilang → tidak kirim close kedua, catat
  signature asli dari chain (atau error kalau tak terbaca). Executor cek hal sama sebelum rebuild tx close
  (`closeRebuildDecision`). Posisi benar-benar kosong → close rent-only.
- **P1.3** `src/tests/exitPathHardening.test.ts` lewat bridge; allowlist executor tidak berubah.

## Yang gw nggak bisa klaim

- **Kedalaman data / window:** verifikasi 2 window gagal, W2 kosong.
- **Sampel tipis:** OOS W1 hanya 12–15 trade di paruh pertama; universe 32 pool.
- **Biaya exit:** 3 observasi tercampur faktor lain (momentum EMBER, routing Jupiter NEARKAT, TVL hari
  ini untuk MANLET/NEARKAT). Fit vs envelope beda sampai ~3x.
- **TVL:** model k × volume (k median 0.129, IQR 0.078–0.181) dari live hari ini, bukan TVL historis.
  Sensitivitas k tidak dijalankan di runner ini.
- **Gas:** 0.004 SOL/tx asumsi, bukan seri historis.
- **Profil akun:** $300 / 63% dari work order, bukan `LIVE_CAPITAL_SOL` di `.env` lokal (header runner
  menandainya "NOT THE LIVE PROFILE").
- **P1 belum pernah jalan dengan uang sungguhan** — baru unit test dan pembacaan source SDK 1.9.14.
- **P2 (dashboard) tidak dikerjakan.**
