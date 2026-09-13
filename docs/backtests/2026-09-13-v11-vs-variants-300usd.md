# 13 Sep 2026 — V1.1 vs varian: backtest $300 / 91 hari + grid 30 hari (in/out-of-sample)

> ## ⚠️ KOREKSI 13 Sep (setelah audit universe — lihat §0 di bawah)
> Angka headline "V1.1 = +117% / PF 2.09" (benchmark) **TIDAK boleh dipakai sebagai ukuran
> strategi yang bisa dijalankan live**. Audit menunjukkan:
> - **9 dari 42 trade (21%) benchmark ada di `OPENAI-USDC` — mint Token-2022 dengan transfer
>   fee 50 bps DAN transfer HOOK** → gate live sekarang MENOLAK pool ini, dan 9 trade itu
>   menyumbang **+$167.86 = 47.7% dari seluruh net benchmark**.
> - **35 dari 42 trade (83%) benchmark ada di pool TANPA sisi wSOL** (`USWR-USDC`, `XST-USDC`,
>   `OPENAI-USDC`) → engine live **tidak bisa mendanai** pool begini (funnel: `noWsol`).
>   Subset yang benar-benar bisa dieksekusi live cuma **7 trade, dan net-nya −$20.64**.
> - Run baru (13 Sep, 70%): **0 trade** ditolak gate token-fee (bersih di sumbu itu), tapi
>   **13 dari 32 trade (41%) masih pool USDC** yang nggak bisa didanai live. Subset SOL-side:
>   **19 trade, net +$331.92** (70% dari headline).

## §E. Biaya swap diprice: `npm run backtest:quote` (91 hari, $300, 63%, 1 posisi, aturan V1.1)

Runner `backtest:quote` = satu-satunya yang **menghitung biaya balancing swap** (2 kaki untuk
pool SOL, 4 kaki untuk USDC) dan menyapu bandnya. Per-leg: gas 0.004 SOL + concession 0–0.5%.

| arm | trade | win | net | return | PF | max DD | friction total | of which swap |
|---|---|---|---|---|---|---|---|---|
| **SOL-quoted** (yang engine bisa danai) | 59 | 72.9% | **+$166.46** | +55.5% | 1.45 | 24.6% | $158.78 | **$68.13** |
| USDC-quoted (live tolak) | 1 | 0% | −$21.80 | −7.3% | 0.00 | 7.3% | $4.51 | $2.17 |
| BOTH (satu akun, 1 slot) | 60 | 71.7% | +$122.64 | +40.9% | 1.34 | 30.4% | $156.60 | $67.83 |

Sensitivitas band (arm SOL, central 0.25%/kaki, cap on-chain 0.50%):

| per-leg swap | SOL net | trade |
|---|---|---|
| 0.00% (yang dipakai runner lain!) | **+$217.78** | 59 |
| 0.10% | +$196.67 | 59 |
| **0.25%** (separuh cap) | **+$166.46** | 59 |
| 0.50% (cap on-chain `HARD_MAX_SLIPPAGE_BPS`) | **+$119.76** | 59 |

**Tiga hal yang ini buktikan:**
1. **Biaya swap menggeser hasil sebesar ~$98 (0% → 0.5%), ≈44% dari seluruh friction.** Runner
   `backtest:micro` dan dua sweep **tidak** menghitungnya (default `swapSlippagePct=0`), jadi
   headline +$474.62/+135–158% itu **optimistis tanpa batas yang diketahui** — sekarang ada batasnya.
2. **Trade USDC di benchmark lama itu artefak dari swap gratis.** Dengan swap diprice, arm USDC
   menghasilkan **1 trade dalam 91 hari** — pool USDC butuh 4 kaki swap, jadi hampir nggak ada yang
   lolos gate. Artinya 83% trade benchmark di pool USDC itu ada **karena** model tidak membebankan
   biaya swap ke mereka.
3. **Sebagian PnL arm SOL itu beta SOL, bukan alpha**: engine menilai posisi di quote asset, jadi PnL
   pool SOL diam-diam mengasumsikan SOL/USD datar — padahal SOL naik **+48.96%** di window ini.
   Kolom diagnostik `Net PnL (USD)` = **$198.08** (selisih **$31.62** = beta). Ini diagnostik, engine
   tidak diubah.

Caveat: profil di run ini = override `--capital=300 --sizepct=63` (profil live di window-start SOL/USD
$68.34 setara **$194.76**, dan runner-nya sendiri memperingatkan "NOT THE LIVE PROFILE"); TVL dimodel
(k median 0.223); universe 24 pool SOL + 23 USDC. Dan biaya exit nyata di live (EMBER bin_step 2%:
exit **3.95% di bawah** harga pool) masih **lebih buruk** dari 0.25%/kaki yang dimodel di sini — jadi
$166.46 itu tetap batas optimistis sampai S1 (biaya exit per bin_step) dipasang.



## §0. Audit universe: dari trade yang BENAR-BENAR terjadi

Diukur dengan `scripts/auditBacktestTokens.ts` (jalur kode yang sama dengan engine:
`fetchPoolByAddress` + `readTokenExtensions`), plus pemecahan per sisi pair dari JSON.

| run | trade | net headline | trade di pool TANPA wSOL (live tolak) | trade ditolak gate token-fee | net subset SOL-side | net subset live-eligible |
|---|---|---|---|---|---|---|
| **8 Sep** (benchmark) | 42 | +$351.78 | **35 (83%)** | **9 (21%) — OPENAI-USDC, fee 50bps + hook** | **−$20.64** (7 trade) | **−$20.64** |
| **13 Sep** (70%, gas .004) | 32 | +$474.62 | 13 (41%) | 0 (0%) | **+$331.92** (19 trade) | **+$331.92** |

Catatan: `OPENAI-USDC` punya **transfer hook** — di live artinya setiap transfer lewat program
pihak ketiga yang bisa menolak, dan model backtest **tidak** memodelkan itu maupun fee 0.5%-nya.
Jadi +$167.86 dari pool itu adalah uang yang **tidak terdokumentasi apakah bisa diambil**.

Kesimpulan §0: **gate token-fee tidak "membatalkan" data lama secara universal — tapi begitu
kriteria gate dipakai untuk mengaudit, hampir separuh profit benchmark hilang.** Dan masalah
yang lebih tua & lebih besar dari gate itu adalah **universe**: backtest menjalankan pool tanpa
sisi wSOL yang engine live tidak bisa danai, dan di benchmark subset yang bisa dieksekusi justru MERAH.

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
