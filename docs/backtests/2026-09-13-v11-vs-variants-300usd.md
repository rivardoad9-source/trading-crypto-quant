# 13 Sep 2026 — V1.1 vs varian: backtest $300 / 91 hari + grid 30 hari (in/out-of-sample)

Semua dijalankan **script-only, tanpa ubah kode**: `npm run backtest:micro`, `npm run sweep:entry`,
`npm run sweep:exits`. Nol panggilan LLM. Output mentah: `~/.hermes/cache/fm_backtest/`.

## Setup (penting buat baca angkanya)

| | micro runner (91 hari, $300) | sweep runner (30 hari) |
|---|---|---|
| akun | $300, 1 posisi, **63%** (live) atau 70% (disamakan dgn benchmark) | default harness: **$100, 50%/posisi, 3 posisi** |
| biaya exit | slippage **2% flat** (`.env FORCED_EXIT_SLIPPAGE_PCT`) | slippage **1% flat** |
| gates/exit | dipin ke `.env` (coverage 2.5x, TP net 5%, SL −8%, age 24h) | exit dipin ke `.env`; gate = yang di-grid |
| window | 14 Jun → 13 Sep (data di-refresh 13 Sep) | 14 Agu → 13 Sep, split 29 Agu |
| universe | 10 survivor + 12 dead | 24 + 24 pool |

Benchmark V1.1 sebelumnya: `backtest_micro_capital.json` @ commit `1a1bd6e` (window 9 Jun → 8 Sep).

## 1. V1.1: benchmark lama vs hari ini

| run | trade | win | net USD | return | PF | maxDD | fee | gas | slippage | exit mix |
|---|---|---|---|---|---|---|---|---|---|---|
| **8 Sep** (70%, gas .004) | 42 | 90.5% | **+351.78** | +117.3% | 2.09 | **40.1%** | 544.63 | 27.91 | 21.52 | TP 31 / OOR 4 / TO 3 / SL 2 / **RUG 1** |
| **13 Sep** (70%, gas .004) | 32 | 84.4% | **+474.62** | +158.2% | 3.18 | 11.8% | 412.09 | 20.93 | 43.10 | TP 18 / OOR 7 / TO 2 / SL 4 |
| **13 Sep** (63%, gas .0035, profil live) | 32 | 84.4% | **+407.47** | +135.8% | 3.22 | 10.6% | 350.90 | 18.32 | 36.58 | TP 18 / OOR 7 / TO 2 / SL 4 |

⚠️ **DD 40.1% di benchmark itu SATU trade rug** (`ruggedLossUsd = −$212.46` = seluruh maxDrawdown-nya).
Window baru: 0 rug. Jadi selisih lama→baru **didominasi window & keberadaan rug**, bukan parameter.
Selisih 70% vs 63% (baris 2 vs 3) = efek ukuran posisi saja: +$67 net di data ini.

## 2. Guard anti-churn: nyala vs mati, DATASET SAMA

| dataset | arm | trade | net | return | PF | DD | SL |
|---|---|---|---|---|---|---|---|
| 8 Sep | V1.1 (guard nyala) | 42 | +351.78 | +117.3% | 2.09 | 40.1% | 2 |
| 8 Sep | no-churn (guard mati) | 55 | **+536.81** | +178.9% | **2.33** | 38.3% | 4 |
| 13 Sep | V1.1 (guard nyala) | 32 | +474.62 | +158.2% | **3.18** | **11.8%** | 4 |
| 13 Sep | no-churn (guard mati) | 53 | +481.72 | +160.6% | 1.98 | 15.3% | 11 |

**Ini temuan yang paling jujur dan nggak enak:** di window LAMA, mematikan guard justru **lebih untung
+$185** dengan PF lebih tinggi juga. Di window BARU, mematikan guard cuma nambah **+$7 (0.5%)** tapi PF
jatuh (1.98 vs 3.18), DD naik, dan SL 11 vs 4. Jadi jawabannya **tergantung window** — dan itu yang bikin
uji split-window jadi penentu, bukan angka 91 hari.

## 3. Grid GATE (30 hari, 48 kombinasi, in/out-of-sample)

- **Nggak ada satu kombinasi pun yang lolos bar** (≥8 trade di DUA paruh, payoff >1 di dua paruh, expectancy >0 di dua paruh).
- `2.5x` (setting live): in-sample 99 trade, PF 1.27, expectancy **+$3.57/trade** — tapi paruh out-of-sample **< 8 trade** → nggak bisa diverifikasi.
- `1.5x`: in-sample 100 trade PF 1.25, OOS juga kurang sampel.
- **Melonggarkan** (`1x`, `0.5x`): OOS PF **0.63–0.87**, expectancy **NEGATIF** (−$0.31 s/d −$0.96/trade), DD in-sample 75–90%.
- Penutup skripnya: tidak ada kombinasi yang lolos; yang "least-bad" OOS pun masih negatif (−$0.31/trade).

→ **Jawaban B: nggak ada bukti buat melonggarkan gate.** Yang longgar justru kelihatan rugi di data yang belum dilihat.

## 4. Grid TP/SL (30 hari, in/out-of-sample)

- **Nggak ada pairing yang lolos bar.** Hasil OOS terbaik = break-even: `TP +5% / SL −12%…−100%` → PF 1.00, expectancy $0.00.
- Menaikkan TP: `+8/+10/+12/+15%` → OOS PF **0.85–0.87**, expectancy **−$0.34 s/d −$0.38/trade**, DD in-sample 57–58%.
- Penutup skripnya: *"the exit thresholds are not where the edge is, and no TP/SL pairing rescues the entry rule."*

→ **Jawaban C: naikin TP nggak didukung data di window 30 hari ini** (di window ini malah lebih jelek OOS).

## 5. Yang BELUM bisa diukur dengan runner yang ada

Hipotesis S1/S2/S3 (biaya putaran sadar bin_step, gate dalam dollar, TP per-pool) **hardcoded tidak ada**
di harness: `sweep:entry`/`sweep:exits` mengunci window 30 hari + akun default ($100/50%/3 posisi),
dan `backtest:micro` cuma bisa ganti capital/sizepct/concurrent/gas/solusd — bukan THRESHOLD gate/TP.
Jadi grid "91 hari / $300 / gate × TP" butuh flag/kode baru → masuk brief
`docs/prompts/backtest-tp-and-friction-300usd-3mo-2026-09-13.txt` untuk Claude lokal.

## Verdict (jujur, tanpa dibungkus)

1. **V1.1 sehat di 91 hari** (PF 3.18–3.22, +135–158% di $300). Tapi itu **satu window** dan
   selisihnya vs benchmark lama sebagian besar karena **window baru nggak kena rug** (lama kena 1, −$212).
2. **Uji split-window (yg lebih keras) belum mendukung pelonggaran**: gate longgar → expectancy negatif OOS;
   TP tinggi → lebih negatif lagi. Yang strict nggak terbukti salah, cuma kurang sampel di paruh kedua.
3. **Yang layak dikejar bukan "longgarin", tapi "lebih tepat sasaran"**: biaya keluar nyata itu fungsi
   bin_step (bin_step 2% → exit −3.95%; bin_step 4% → bolak-balik 8.8%), sementara harness mengasumsikan
   slippage flat 1–2% untuk semua pool. Kalau S1 benar, gate-nya berhenti menolak pool murah dan berhenti
   meloloskan pool mahal — tanpa menurunkan bar.
4. **Jangan ubah apa pun di live** sebelum ada varian yang lolos OOS di ≥2 window non-overlap
   (batas data gratis: 208 hari → maksimal 2 window 91 hari).

## Caveats yang wajib ikut kalau angka ini dikutip

1. **TVL itu MODEL** (`k × volume24h`, k fitted; medianK ≈ 0.099, p75K ≈ 0.107) — ini asumsi paling berat. Semua filter TVL/fee-TVL berjalan di atas estimasi.
2. Fee dihitung pro-rata dari volume pool (`feeRate × vol × posValue/TVL`), **tanpa** multiplier konsentrasi DLMM → fee = **batas bawah**.
3. Universe = SAMPEL (~10–24 pool per arm dari ~123k), sengaja termasuk pool mati; sampling lebih dalam akan memunculkan lebih banyak kegagalan → bias sisa masih **optimistis**.
4. Exit di hourly close; posisi yang likuiditasnya hilang di-mark ke harga terburuk (bukan harga exit yang tak tersedia).
