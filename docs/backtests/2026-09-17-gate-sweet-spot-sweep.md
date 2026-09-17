# Sweet spot gate entry — sweep skenario backtest (coverage · slippage · band fee/TVL)

Tanggal: 2026-09-17 · Branch `main` · Runner `backtest:micro` · **nol perubahan ke engine live**

Pertanyaan: apakah `MIN_FEE_COST_COVERAGE=2.5` sudah paling optimal, dan berapa angka
sweet spot-nya kalau dilonggarkan?

## 0. Cara sweep

Semua gate di backtest dibaca dari `env` (lihat `liveV11Config()` di
`backtest/runMicroCapital.ts`), jadi sweep cukup lewat environment variable — **tanpa ubah kode
dan tanpa ubah `.env` live** (variable di-set per-proses saja).

| hal | nilai |
|---|---|
| akun | **profil live** (tanpa `--capital`/`--sizepct`): 2,85 SOL × harga window-start, 1 posisi, 63,16% |
| gas | 0,004 SOL/tx (tanpa `--gas`) → pakai `--gas=0.004` |
| dataset | (a) 22 pool / 91 hari (k TVL 0,114) · (b) 51 pool / 120 hari stitched offline (k 0,788) |
| data | dari `.cache` saja; cache di-pin ulang **sebelum tiap run**, direstore di akhir (verifikasi: 22 pool) |
| level lain | TP +5% · SL −8% · 24h · cooldown 4h · lockout 2/24h · slippage exit 2% (kecuali di-sweep) |

25 run, 0 gagal. Skrip: `scripts/agent_gate_sweep.sh` · tabel: `scripts/agent_diag/compile_gate_sweep.py`
· artefak mentah: `docs/backtests/runs/gate_sweep/*.{json,log}`.

## 1. Sweep A — multiplier coverage (dataset 91 hari, k 0,114)

```
cov   trade  WR%    net $    net%    PF  maxDD%  frik/fee | elig trade  elig net $  elig maxDD
0.5     134  59.0    27.88    14.3  1.05    36.2      0.61 |         86        15.17        41.2
1.0      51  64.7    74.25    38.0  1.31    18.1      0.35 |         25       -13.67        22.3
1.5      32  84.4   253.37   129.5  3.13    10.9      0.20 |         20       138.27        11.0
2.0      32  84.4   253.37   129.5  3.13    10.9      0.20 |         20       138.27        11.0
2.5*     31  83.9   247.17   126.4  3.07    10.9      0.20 |         20       138.27        11.0   ← live sekarang
3.0      20  85.0   138.27    70.7  3.20    11.0      0.19 |         20       138.27        11.0
4.0      20  85.0   138.27    70.7  3.20    11.0      0.19 |         20       138.27        11.0
6.0      20  85.0   138.27    70.7  3.20    11.0      0.19 |         20       138.27        11.0
```

Baca cepat: arm live-eligible **datar 1,5 → 6,0** (20 trade, +$138,27). Di 2,5 vs 2,0 bedanya
**1 trade ($6,20)**. Turun ke 1,0 arm eligible jadi **negatif** (−$13,67: 5 trade tambahan yang
rugi); turun ke 0,5 → 86 trade, PF 1,05, **maxDD 41,2%** (churn). Naik ke 3,0 → full universe
kehilangan 11 trade pool tanpa kaki SOL (+$109 hilang), arm eligible tidak berubah.

## 2. Sweep A2 — multiplier coverage (dataset 120 hari, k 0,788 — fee lebih tipis)

```
cov   trade  WR%    net $   net%    PF  maxDD%  frik/fee | elig trade  elig net $  elig maxDD
1.0      26  84.6   156.33   61.4 14.94     3.3      0.10 |         91        13.68        36.7
1.5      22  81.8    78.73   30.9  3.57     7.4      0.12 |         37       -25.49        34.3
2.0      48  52.1  -105.16  -41.3  0.68    41.3      1.22 |         37       -25.49        34.3
2.5*     32  50.0   -96.32  -37.9  0.60    37.9      1.06 |         29       -95.27        37.4
3.0       3  33.3    -0.23   -0.1  0.63     0.2      0.18 |          0         0.00         0.0
4.0       3  33.3    -0.23   -0.1  0.63     0.2      0.18 |          0         0.00         0.0
```

Di dataset ini **peringkatnya terbalik**: yang paling longgar (1,0) paling tidak buruk, dan 2,5
paling buruk (−$95,27). Di ≥3,0 engine praktis mati (0 trade eligible). Ini bukan bukti "1,0 lebih
baik" — ini bukti urutan hasilnya dikendalikan model fee (k), bukan gate-nya.

## 3. Sweep C — asumsi slippage exit (dataset 91 hari, cov 2,5)

```
slip%  trade  net $    net%    PF  maxDD%  | elig trade  elig net $  elig maxDD
1.0      32  286.88   146.7  3.49     9.8  |         20       153.66        10.0
1.5      32  269.88   138.0  3.30    10.3  |         20       145.90        10.5
2.0*     31  247.17   126.4  3.07    10.9  |         20       138.27        11.0   ← live sekarang
3.0      20  123.38    63.1  2.86    12.1  |         20       123.38        12.1
5.0      20   95.06    48.6  2.30    14.3  |         20        95.06        14.3
```
Di dataset 120 hari, cov 2,5: slip 2% → elig **−$95,27**; slip 1% → elig **+$22,94** (37 trade).
**Swing $118 = seluruh tandanya cuma dari satu asumsi.**

## 4. Sweep D — band fee/TVL (dataset 91 hari, cov 2,5)

```
skenario            trade  net $    net%   PF  maxDD% | elig trade  elig net $
MIN_FEE_TVL 0.002     31  247.17   126.4 3.07   10.9 |         20       138.27
MIN_FEE_TVL 0.02      31  247.17   126.4 3.07   10.9 |         20       138.27
baseline (0.008)      31  247.17   126.4 3.07   10.9 |         20       138.27
MAX_FEE_TVL 0.50      45  530.45   271.2 3.45   14.0 |         33       341.26
MAX_FEE_TVL 1.00      45  530.45   271.2 3.45   14.0 |         33       341.26   (ceiling praktis off)
+ cov 1,5             45  530.45   271.2 3.45   14.0 |         33       341.26
```
Lantai (`MIN_FEE_TVL_RATIO`) **tidak binding** sama sekali — 0,2% atau 2% hasilnya identik, karena
gate coverage sudah menangkap kasus yang sama. Yang punya daya ungkit justru **plafon**
(`MAX_FEE_TVL_RATIO=0,25`): dinaikkan ke 0,5/1,0 → +$530 vs +$247 (+114%), arm eligible +$341 vs
+$138, maxDD 14,0% vs 10,9%. Tapi di dataset 120 hari plafon ini **tidak menolong sama sekali**
(−$95,27 tetap). Dan ingat: plafon 25% itu filter spike — pool yang lolos plafon longgar adalah
pool yang fee-nya sedang meledak lalu mati (kasus EMBER: entry di coverage 8,17x, exit −8,41%
dalam 4,3 jam).

## 5. Yang mengukur, bukan diasumsikan: concession exit nyata

`exit_economics` (backfill 6 close live) menyimpan concession sweep yang benar-benar terjadi:

| pool | concession |
|---|---|
| EMBER-SOL | 0,40% |
| EMBER-SOL | 0,86% |
| EMBER-SOL | 0,91% |
| NEARKAT-SOL | 1,43% |
| EMBER-SOL | 1,80% |

median **0,90%** · rata-rata **1,08%** — sementara gate & akuntansi backtest memakai **2,0%**.
Artinya bar 2,5x yang sekarang setara fee/TVL 6,11% **mungkin sebenarnya ~3,4–4,0%** kalau dihitung
dari angka terukur (2,5 × (0,44% gas + 0,9–1,8% slippage)). Catatan kejujuran: n=5, semua dari satu
wallet, dan kolom `notes` menandai cakupannya tidak lengkap (fee hanya dari tx close terakhir yang
tersimpan; sebagian sweep tidak terukur). Jadi ini **arah**, bukan angka untuk di-hard-code.

## 6. Kesimpulan

1. **2,5 bukan "optimal", tapi juga bukan masalahnya.** Pada dataset fee-tebal, arm live-eligible
   datar dari 1,5 sampai 6,0 — mau 2,0 / 2,5 / 3,0 hasilnya sama (20 trade, +$138,27). Jadi
   melonggarkan gate di rentang itu **tidak membeli apa-apa**.
2. **Batasnya jelas:** di bawah 1,5 mulai churn (1,0 → eligible negatif; 0,5 → 86 trade, maxDD 41%).
   Di atas 3,0 engine praktis idle (120 hari: 0 trade) dan kehilangan pool non-SOL (91 hari: −$109).
3. **Tidak ada sweet spot yang stabil.** Di dataset k=0,114 optimum di 1,5–2,5; di dataset k=0,788
   optimum di 1,0 dan 2,5 justru terburuk. Urutan hasil ditentukan model fee/TVL (k), sama seperti
   temuan 120 hari sebelumnya. Sweep gate di atas satu dataset = overfitting.
4. **Tiga tuas yang benar-benar menggerakkan hasil**, semuanya di luar multiplier:
   - asumsi slippage exit (2%, padahal terukur ~0,9%): swing $118 di dataset 120 hari;
   - plafon `MAX_FEE_TVL_RATIO` 25%: +114% di dataset fee-tebal, 0% di dataset fee-tipis;
   - model TVL k: mengubah tanda hasil.
5. **Rekomendasi (belum diterapkan apa pun):** pertahankan 2,5 dan ganti basis angkanya dari
   "2% slippage" ke **concession terukur per pool/route** (engine sudah merekamnya di
   `exit_economics`). Itu menurunkan bar ke ~3,4–4,0% fee/TVL **tanpa** melemahkan prinsipnya
   (fee tetap harus menutup biaya 2,5x). Jangan turun ke ≤1,5 dan jangan naik >3,0.

## 7. Reproduksi

```bash
cd ~/flowmetrix-ai-agent
bash scripts/agent_gate_sweep.sh                       # 21 run (fase A, C, D, B)
python3 scripts/agent_diag/compare_window_runs.py      # (opsional) perbandingan window
python3 scripts/agent_diag/compile_gate_sweep.py       # tabel di dokumen ini
```

Nol perubahan ke `.env`, `LIVE_CAPITAL_SOL`, `LIVE_MAX_POSITION_SOL`, atau kode engine.
