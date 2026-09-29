# Walk-forward + Monte Carlo di engine FlowMetrix — 29 Sep 2026

Runner baru: `src/scripts/wfoMonteCarlo.ts` (`npm run wfo:mc`). Dataset baru:
`.cache/historical_data_micro_273d_stitched.json` (dibikin offline dari tiga ingest 91 hari).
Output: `docs/backtests/runs/wfo273_k{median,p25,p75}.json`.

## 0. Kenapa runner ini ada

Semua backtest yang sudah dipublikasikan di repo ini adalah **satu angka di satu window**, dan
dokumen 120 hari sudah membuktikan bahwa **tanda** angka itu ditentukan asumsi TVL k, bukan window:
harness yang sama memberi +158% di cache 22-pool dan −3,5% di dataset stitched. Satu window tidak
bisa memisahkan artefak fitting dari edge, karena parameter yang dipakai dipilih (atau diwarisi)
dengan melihat window itu sendiri.

Yang ditambahkan runner ini, dan hanya ini:

1. **Walk-forward.** Fold bergulir 45 hari train / 15 hari test, mundur dari bar terakhir. Di dalam
   tiap fold, config terbaik dipilih **hanya dari slice train**, lalu diukur di slice test yang tidak
   pernah dilihat saat memilih. Gabungan trade test = satu-satunya angka tanpa hindsight. Angka
   optimum in-sample di seluruh span dicetak di sebelahnya: selisihnya adalah besar optimisme.
2. **Monte Carlo.** Trade out-of-sample itu sebuah *sample*, bukan populasi. Resample (bootstrap),
   acak-ulang urutan (path), resample blok fold (rezim), dan resample **cluster per pool** (karena
   trade di satu pool berbagi satu seri harga) memberikan interval yang layak untuk titik estimasinya.

Aturan gaya yang dipegang: tidak ada angka di sini yang disebut "signifikan"; setiap arm dilaporkan
walaupun rugi; counter konsentrasi (jumlah pool, sebaran tanggal entry) dicetak supaya run yang
sebenarnya cuma satu pool tidak bisa lolos sebagai "strategi".

## 1. Dataset & keterbatasan yang diwarisi (bukan ditambahkan runner)

| hal | nilai |
|---|---|
| sumber | stitch offline 3 ingest: 14 Des 2025–15 Mar, 15 Mar–14 Jun, 14 Jun–13 Sep 2026 |
| pool | 57 (46 survivor, 11 dead/dormant) |
| span bar yang benar-benar ada | **30 Jan → 12 Sep 2026 (225 hari)**, solUsdBars 4.970 |
| bar/pool | min 32 · median 973 · max 4.970 · **pool dengan 273 hari penuh: 0** |
| universe | dipilih oleh ingest 13–14 Sep 2026 → **survivor bias melekat** |
| model TVL | `k` dikalibrasi dari `tvlTodayUsd` (TVL HARI INI) → **look-ahead melekat** |

Dua baris terakhir bukan cacat runner ini, tapi cacat cache yang diwarisi: daftar pool dipilih
setelah tahu pool mana yang masih hidup, dan k-nya dihitung dari TVL hari ini. Selama keduanya belum
diganti dengan ingest point-in-time, **setiap angka di bawah adalah batas atas**.

## 2. Setup

```
npm run wfo:mc -- --train=45 --test=15 --folds=10 --mc=10000 --k=median
account   : $300 · 70%/posisi (=$210) · 1 concurrent · gas 0.004 SOL/tx   (sama seperti live profile)
arm grid  : 12 config = {SL −8/TP +5 (live V1.1), SL −6/TP +18, SL −10/TP +10}
                        x {gate minFeeCostCoverage 1.0x, 2.5x}
                        x {downsideCoverPct 25, 45}
k         : median 0.788 · p25 0.405 · p75 1.788 (dijalankan ketiganya)
```

## 3. (A) Angka in-sample di seluruh span = plafon optimis

Optimum dengan hindsight: **SL −10 / TP +10 · gate 1x · downside 45%** →
24 trade · WR 75% · net **+$167,62** · PF **5,25** · maxDD 3,6% · expectancy **$6,98/trade**.

Angka inilah yang biasanya berhenti di laporan backtest. Yang penting: **24 trade dalam 225 hari**,
jadi seluruh plafon itu berdiri di atas ~24 kejadian.

## 4. (B) Walk-forward — pilih di train, ukur di test

| fold | train | test | config dipilih | train (expectancy) | TEST |
|---|---|---|---|---|---|
| F1 | 14 Jul→28 Agu | 28 Agu→12 Sep | live · 1x · ds25 | 48 trade, −$0,19 | **35 trade · +$205,21 · WR 68,6% · maxDD 23,0%** |
| F2 | 29 Jun→13 Agu | 13 Agu→28 Agu | live · 1x · ds25 | 25 trade, +$6,17 | 37 trade · +$16,68 |
| F3 | 14 Jun→29 Jul | 29 Jul→13 Agu | sempit · 1x · ds25 | 21 trade, +$3,13 | 9 trade · **−$14,14** |
| F4 | 30 Mei→14 Jul | 14 Jul→29 Jul | sempit · 1x · ds45 | 13 trade, +$4,53 | **0 trade** |
| F5 | 15 Mei→29 Jun | 29 Jun→14 Jul | sempit · 1x · ds45 | 22 trade, +$6,41 | 10 trade · +$27,22 |
| F6 | 30 Apr→14 Jun | 14 Jun→29 Jun | sempit · 1x · ds45 | 24 trade, +$6,99 | 11 trade · +$43,40 |
| F7 | 15 Apr→30 Mei | 30 Mei→14 Jun | live · 1x · ds25 | 11 trade, +$4,73 | 19 trade · +$55,43 |
| F8/F9/F10 | Mar–Mei | Apr–Mei | **tidak ada config dengan ≥4 trade** | — | — |

Dua hal yang langsung kelihatan dan lebih penting dari angka akhirnya:

- **7 dari 10 fold jalan, 3 fold nol.** Di Mar–Mei gate menolak segalanya (12 config dicoba, tidak ada
  yang mencapai 4 trade). Jadi "edge" ini punya **musim**: ada periode di mana engine memilih diam,
  dan itu tidak salah — tapi artinya hasil tahunan bergantung pada berapa bulan dia mau trade.
- **F1 mendominasi.** Expectancy train F1 **negatif** (−$0,19) tapi test-nya +$205,21. Itu bukan
  kehebatan seleksi, itu **rezim**: 28 Agu–12 Sep memang bulan yang baik untuk semua config. Kalau
  F1 dibuang, sisa OOS = 86 trade.

## 5. (C) Gabungan out-of-sample — satu-satunya angka tanpa hindsight

| k | trade | WR | net | PF | expectancy/trade | equity $300 → | maxDD (path) |
|---|---|---|---|---|---|---|---|
| **median 0.788** | 121 | 66,9% (81W/40L) | **+$333,79** | 1,43 | **$2,76** | **$751,66 (+150,6%)** | 30,1% |
| p25 (optimis) 0.405 | 133 | 63,2% | +$457,13 | 1,46 | $3,44 | $732,34 (+144,1%) | 48,5% |
| p75 (pesimis) 1.788 | 106 | 64,2% | +$244,47 | 1,38 | $2,31 | $611,65 (+103,9%) | 31,3% |

Exit mix (median): OUT_OF_RANGE 37 · TIMEOUT 34 · TAKE_PROFIT 30 · STOP_LOSS 15 · END_OF_DATA 5 ·
**RUGGED 0**. Perhatikan: **28% exit adalah TIMEOUT** — posisi yang tidak melakukan apa-apa selama
`maxDurationHours` — bukan take-profit, bukan stop.

**Gap optimisme: expectancy $6,98 → $2,76 per trade (−60%).** Angka in-sample bukan cuma "agak
terlalu bagus"; hampir dua pertiganya hilang saat parameter dipilih tanpa bisa melihat masa depan.

Kabar penting: kali ini **tanda tidak berubah** antar k (p25/p75 dua-duanya positif), beda dengan
temuan dokumen 120 hari. Penyebabnya bukan k-nya jadi tidak penting, tapi karena dataset & periodenya
berbeda: di sini OOS tersebar di 15 pool selama 104 hari, bukan 35 trade dari satu pool selama 5
minggu.

## 6. (D) Monte Carlo 10.000 run per metode

| metode | equity p5 | p50 | p95 | P(profit) | maxDD p5/p50/p95 |
|---|---|---|---|---|---|
| 1. bootstrap trade (i.i.d., n=121) | $317 | $827 | $2.130 | 96,2% | 20,9% / 34,1% / **54,5%** |
| 2. acak-ulang urutan trade | — | — | — | — | 25,1% / 35,5% / 50,3% |
| 3. bootstrap blok FOLD (6 fold) | $392 | $737 | $1.676 | 99,6% | 13,7% / 30,1% / 36,1% |
| 4. **bootstrap CLUSTER per POOL (15 pool)** | **$280** | $741 | $1.781 | **93,9%** | 13,3% / **46,1%** / **64,8%** |

Cara membacanya: metode 1 adalah yang paling optimis (menganggap tiap trade independen, padahal
tidak). Yang paling jujur untuk sample 121 trade dari 15 pool adalah **metode 4**: kalau universe-nya
menarik pool yang berbeda, p5 = $280 (≈ impas, sedikit di bawah modal) dan maxDD p95 = **64,8%** —
artinya dengan modal $300 pada 70%/posisi, drawdown dua pertiga akun adalah skenario yang masuk akal,
bukan ekor yang bisa diabaikan. Di k=p25 maxDD p95 = 78%.

## 7. (E) Stabilitas & (F) konsentrasi

Config yang menang in-sample per fold (median): `live·1x·ds25` 3x, `sempit·1x·ds45` 3x,
`sempit·1x·ds25` 1x → **tidak ada pemenang yang stabil**. Gate `minFeeCostCoverage` **1.0x menang di
7/7 fold yang jalan**; 2.5x tidak pernah terpilih sekali pun — konsisten dengan temuan repo bahwa
menaikkan gate ini memperburuk hasil.

15 pool menyumbang 121 trade OOS. Teratas: **CARDS-USDC 27 trade +$97,88** · STONK-SOL 21 +$73,27 ·
BTC-SOL 2 +$51,82 · OPENAI-USDC 8 +$48,83 · USELESS-USDC 7 +$39,57.

**Leave-one-pool-out (median k):**

| skenario | equity akhir | vs $300 |
|---|---|---|
| apa adanya (121 trade) | $751,66 | +150,6% |
| tanpa pool #1 (CARDS-USDC, 94 trade) | $562,74 | +87,6% |
| tanpa 3 pool teratas (71 trade) | **$368,11** | **+22,7%** |

Cohort: `survivor` 102 trade net +$288,69 · `dead-or-dormant` 19 trade net +$45,10. Karena universe
memang didominasi survivor, kontribusi cohort mati yang kecil bukan bukti kuat — hanya catatan bahwa
45% net datang dari pool yang belakangan mati **tidak** terjadi di sini.

## 8. Kesimpulan yang boleh dan tidak boleh diambil

**Boleh:** dengan mesin yang ada sekarang, hipotesis terbaiknya adalah **expectancy ~+$2,3–3,4 per
trade** di akun $300/70%, PF ~1,4, WR ~65%, dengan **drawdown 30–65%** sebagai rentang normal, dan
hasil yang **bermusim** (3 dari 10 periode 15 hari tidak trade sama sekali). Underdog-nya bukan
"berapa persen setahun" tapi "apakah masih positif setelah universe tidak lagi dipilih dengan
hindsight".

**Tidak boleh:** mengutip +150% sebagai ekspektasi. Angka itu (a) memakai k yang dikalibrasi dari TVL
hari ini, (b) memakai universe yang dipilih karena masih hidup pada September 2026, (c) 60% lebih
besar dari expectancy yang benar-benar bisa dipilih tanpa melihat masa depan, dan (d) berubah jadi
+23% begitu tiga pool teratas dibuang.

**Langkah berikutnya yang menaikkan mutu bukti, berurutan:**
1. **Ingest point-in-time**: universe dibangun per tanggal (bukan daftar pool yang sudah tahu
   pemenangnya). Ini menghapus survivor bias dan mengubah angka di atas dari batas atas menjadi
   estimasi.
2. **Fit k dari trade live** (`entry_economics`/`exit_economics` + TVL on-chain saat entry), lalu
   jalankan seluruh WFO sebagai fungsi k — bukan tiga titik.
3. Naikkan `--folds` begitu ingest point-in-time ada: sample 121 trade terlalu kecil untuk
   memutuskan apa pun, dan MC di atas mengukur ketidakpastian itu, bukan menghapusnya.

---

## Re-presentasi pakai modal asli ($280 / $700 / $1.400)

Tiga ukuran akun lewat pipeline yang sama (`--capital=… --sizepct=70`, median k):

| modal | trade OOS | WR | PF | net (Σ P&L) | % modal | expectancy/trade | maxDD path | MC p5 (cluster) | P(profit) |
|---|---|---|---|---|---|---|---|---|---|
| $280 (cap LP) | 106 | 67,0% | 1,51 | +$308,53 | +110,2% | $2,91 | 33,1% | $291 | 95,7% |
| $700 | 123 | 66,7% | 1,52 | +$980,28 | +140,0% | $7,97 | 28,3% | $745 | 95,7% |
| $1.400 | 123 | 66,7% | 1,55 | +$2.062,51 | +147,3% | $16,77 | 27,6% | $1.577 | 96,3% |

Compounded penuh: $280 → $701,88 · $700 → $2.219,40 · $1.400 → $4.691,71 (realita ada di antara Σ dan compounded).

**Temuan kunci: hasilnya BUKAN fungsi linear modal — dan bukan karena compounding.** Gate
breakeven menuntut `fee/TVL ≥ coverage × (gasRoundTrip/notional + forcedExitSlippage)`, sementara
gas itu biaya **absolut**:

| modal | notional 70% | gas r/t (SOL ~$100) | % notional | lantai fee/TVL |
|---|---|---|---|---|
| $100 | $70 | $0,70 | 1,004% | 1,304% |
| $280 | $196 | $0,70 | 0,359% | 0,659% |
| $700 | $490 | $0,70 | 0,143% | 0,443% |
| $1.400 | $980 | $0,70 | 0,072% | 0,372% |
| $3.000 | $2.100 | $0,70 | 0,033% | 0,333% |

Akun $280 hanya boleh masuk pool dengan fee/TVL ≥ 0,66% (106 trade); akun $1.400 cukup ≥ 0,37%
(123 trade). Manfaatnya mentok di sekitar $1.400–3.000 (0,372% → 0,333%).

Band k pada $1.400: p25 +$2.245,85 (+160%, maxDD 59,2%, P(profit) cluster 85,1%) ·
median +$2.062,51 (+147%) · p75 +$1.298,82 (+92,8%).
Leave-one-pool-out $1.400: tanpa pool #1 → $3.442,62 (+146%) · tanpa 3 pool teratas → $2.036,28 (+45%).

Grafik: vault `attachments/wfo-4-modal-nyata.png` · generator `~/.hermes/scripts/diag/make_cap_chart.py`.
