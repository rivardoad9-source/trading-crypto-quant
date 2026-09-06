# Laporan Analisis Dry-Run Hermes — Jendela ~72 Jam

**Engine**: FlowMetrix DLMM AI Agent V1.1 · **Profil**: live micro-capital ARMED (0,50 SOL × 1)
**Host**: Hermes VPS, PM2 proses `flowmetrix-engine`
**Mode**: `DRY_RUN=true` — nol kapital nyata, nol transaksi ditandatangani.

## 0. Sumber data & batas jendela

| Item | Nilai |
|---|---|
| Jendela observasi | `2026-09-03T07:38:32Z` → `2026-09-06T02:44:41Z` |
| Durasi sebenarnya | **67,10 jam** (`/api/health` → `uptimeSeconds: 241568`) |
| Restart selama jendela | **0** |
| Siklus screener teramati | **135** (cron `*/30`) |
| Sumber | DB live `data/flowmetrix.db` + `~/.pm2/logs/flowmetrix-engine-{out,error}.log` |
| Silang-periksa | `exports/trades.csv` + `exports/summary.json` di origin/main (commit `8cad655`) |

**Koreksi terhadap premis "72 jam".** Proses berjalan **67,1 jam**, bukan 72. Konfigurasi 0,50 SOL
mulai berlaku pada boot pukul `07:36Z` tanggal 3 Sep; satu siklus berjalan di boot itu (dan membuka
trade #1) sebelum SIGINT + restart pukul `07:38:32Z` yang memulai proses saat ini. Total era 0,50 SOL
≈ 67,2 jam. Semua angka di bawah dihitung atas jendela tersebut, bukan diekstrapolasi ke 72 jam.

**Yang TIDAK bisa dijawab dari run ini.** `screenPools()` menghitung ember penolakan kuantitatif
(`lowTvl`, `highTvl`, `tooYoung`, `lowFeeRatio`, `ageUnknown`, …) dan `seekNewEntry` menyimpan
`summary.scanned` — tetapi **tidak satu pun dicetak ke log atau dipersistensi**. Jadi penyempitan dari
600 pool per siklus menjadi ~20 kandidat tidak dapat dirinci dari data yang ada. Angka "Total Pool
Scanned" di bawah adalah throughput nominal yang terverifikasi, bukan hitungan dari log.

---

## 1. Metrics Utama Scanning (67,1 jam / 135 siklus)

### 1.1 Total Pool Scanned

| Ukuran | Nilai | Cara verifikasi |
|---|---|---|
| Universe Meteora DLMM | **124.371 pool** | `GET dlmm.datapi.meteora.ag/pools` → `total`, diambil dari Hermes |
| Kedalaman scan per siklus | **600 pool** (3 halaman × 200, urut `volume_24h:desc`) | halaman 1–4 masing-masing mengembalikan tepat 200 baris |
| Siklus screener | **135** | dihitung dari baris `[dlmm] cycle done` |
| **Pool-observation total** | **81.000** | 600 × 135 |

81.000 adalah *observasi*, bukan pool unik: setiap siklus memindai ulang irisan top-volume yang sebagian
besar sama. Jumlah pool unik tidak terekam.

### 1.2 Funnel penolakan lengkap

| Tahap | Lolos | Ditolak | Catatan |
|---|---|---|---|
| Fetch upstream | 81.000 obs | — | 600/siklus |
| Filter kuantitatif (`screenPools`) | **2.733 obs** (median 23/siklus, min 0, maks 30) | ~78.267 obs | rincian sebab **tidak terekam** |
| Anti-churn cooldown / lockout | — | **24** | DOGE-1-SOL 16, fone-SOL 8 |
| Anti-rug (`screenTokenSafety`, shortlist ≤6/siklus) | **353** | **343** | ANSEM-SOL 110, OPENAI-USDC 58, ANTHROPIC-USDC 58, TROLL-SOL 28, ANSEM-USDC 27, ANTHROPIC-SOL 26, GPRO-SOL 18, SKR-SOL 15, ETH-SOL 2, MADE-SOL 1 |
| Volatility gate (shortlist ≤3/siklus) | — | **54** | fone-SOL 35, STONK-SOL 12, SOLCAT-SOL 3, MANLET-SOL 2, DOGE-1-SOL 1, SOL-USDC 1 |
| **Breakeven 2,5× (`MIN_FEE_COST_COVERAGE`)** | — | **189** | fone-SOL 137, STONK-SOL 28, SOL-USDC 24 |
| **Micro-Capital Friction Gate (floor $1,50)** | — | **52** | fone-SOL 51, STONK-SOL 1 |
| Sampai ke DeepSeek | **34 siklus** | — | 32 ditolak model, **2 dibuka** |

Rekonsiliasi jendela log stderr diverifikasi tepat: 662 baris gate terakhir memecah persis menjadi
24 cooldown / 343 antirug / 54 volatility / 189 friction / 52 friction-micro — sama persis dengan
penjumlahan 135 baris `cycle done`. Tidak ada baris yang salah tempat.

**Alasan terminal per siklus** (135 siklus):

| Alasan siklus berakhir | Siklus | % |
|---|---:|---:|
| Gagal gate breakeven 2,5× | 41 | 30,4 % |
| Gagal floor $1,50 (micro gate) | 33 | 24,4 % |
| Model DeepSeek menolak ENTER | 32 | 23,7 % |
| Sudah at-capacity (1/1 posisi terbuka) | 19 | 14,1 % |
| Semua kandidat gagal volatility gate | 8 | 5,9 % |
| **Posisi dibuka** | **2** | **1,5 %** |

### 1.3 Rincian Micro-Capital Friction Gate (yang diminta)

52 penolakan tersebar di 33 siklus. Setiap baris mencetak aritmetikanya, jadi bar sebenarnya dapat
dihitung, bukan diasumsikan:

| Ukuran | Nilai teramati (n=52) |
|---|---|
| Friction (gas floor + slippage) | $1,8148 – $1,8785, median **$1,8427** |
| Proyeksi fee 24 j yang ditolak | $2,5549 – $3,3276, median $2,9113 |
| Net PnL proyeksi yang ditolak | $0,72 – $1,50, median ≈ $1,05 |
| **Fee yang dibutuhkan** = $1,50 + friction | ≈ **$3,343** |
| **⇒ bar fee/TVL efektif @ ~$50,6 notional** | **≈ 6,6 %** |

Untuk gate 2,5× coverage, log mencetak biaya round-trip-nya sendiri:

| Ukuran | Nilai teramati (n=189) |
|---|---|
| Biaya round-trip | $1,0082 – $1,0553, median **$1,0361** |
| Coverage ratio yang ditolak | min 0,42 · p25 1,33 · median 1,76 · p75 2,00 · maks 2,46 |
| **Fee yang dibutuhkan** = 2,5 × biaya | ≈ **$2,590** |
| **⇒ bar fee/TVL efektif** | **≈ 5,1 %** |

### 1.4 Qualified Candidates — TIDAK 100 % rejection

**Tiga posisi lolos clearance penuh** (cooldown → anti-rug → volatility → 2,5× coverage → floor $1,50
→ DeepSeek ENTER), semuanya pada 0,50 SOL:

| # | Pool | Dibuka (UTC) | Ditutup | fee/TVL 24 j saat entry | Coverage | Est. fee 24 j | Conf | Hasil |
|---|---|---|---|---:|---:|---:|---:|---|
| 1 | DOGE-1-SOL | 09-03 07:38:14 | 09-03 11:27 (3,81 j) | **10,34 %** | 5,16× | $5,21 | 68 | **+$2,53 (+5,01 %)** take-profit |
| 2 | DOGE-1-SOL | 09-03 15:30:38 | 09-03 17:01 (1,51 j) | **11,35 %** | 5,67× | $5,92 | 80 | **−$4,21 (−8,08 %)** stop-loss |
| 3 | fone-SOL | 09-04 18:01:43 | 09-04 22:03 (4,02 j) | **7,87 %** | 3,93× | $3,98 | 60 | **+$2,72 (+5,38 %)** take-profit |

`fee/TVL` diturunkan dari `expected_fee_24h_usd ÷ (0,5 SOL × entry_sol_price_usd)`. Ketiganya lulus
anti-rug `PASS`, mint & freeze authority revoked, top-10 holder 11,9 – 14,2 %.

**Catatan wajib soal "estimasi yield".** `expected_fee_24h_usd` adalah model fee level-pool yang
konservatif — tanpa pengali konsentrasi, nol saat di luar range. Itu **bukan** proyeksi yield, dan
realisasinya jauh lebih kecil: fee aktual yang terkumpul hanya **$1,92 total** dari 9,34 jam waktu
in-range, melawan estimasi 24-jam $15,11 gabungan.

### 1.5 Hasil PnL jendela ini

| Ukuran | Nilai |
|---|---|
| Trade ditutup | 3 (2 menang / 1 kalah, win rate 66,7 %) |
| **Net realized PnL** | **+$1,0358** |
| — komponen fee | **+$1,9163** |
| — komponen LP value change | **−$0,8804** |
| Equity paper | $115,69 → **$116,73** |
| Profit factor | 1,246 |
| Max drawdown | $4,2129 (3,56 %) |
| Waktu ter-deploy | 9,34 j dari 67,10 j = **13,9 %** |
| Laju entry | 1 entry per **22,4 jam** |

Ketiga exit dipicu harga (2 take-profit, 1 stop-loss); tidak ada exit yang berasal dari akumulasi fee.
Namun secara agregat komponen arah **negatif** (−$0,88) dan seluruh laba bersih berasal dari fee
capture (+$1,92). n=3 — ini observasi, bukan hasil.

### 1.6 Kesehatan operasional

Di dalam jendela hanya ada **4 peringatan non-gate**: 3 × `[researcher] missing inputs` (DXY, US 10Y,
S&P 500, ETF flows — kontrak "UNAVAILABLE, jangan mengarang" bekerja sesuai desain) dan 1 ×
`[deepseek] structured output attempt 1 failed: reasoning_tokens=16000` yang di-retry mulus (cap 16 k
V1.1 melakukan graceful skip persis seperti spesifikasi). **Nol** cycle failure, **nol** kegagalan HTTP
upstream, **nol** crash. RPC Helius `getSlot` 64 ms. Wallet 1,147850 SOL (floor 0,2 SOL) — OK.

---

## 2. Evaluasi Gate Realism & Next Step

### 2.1 Apakah threshold 9 % Fee/TVL menangkap kandidat?

**Threshold 9 % tidak pernah menjadi bar yang benar-benar ditegakkan.** Bar riil-nya ≈ **6,6 %**, dan
bar itu **berhasil menangkap 3 kandidat** dalam 67,1 jam. Rejection rate bukan 100 %.

Penyebab selisihnya adalah ketidakcocokan nyata antara baris boot dan runtime:

```
[preflight] gates   : $1.50 floor needs 6.58% fee/TVL, 2.5x coverage needs 9.00%
[preflight] implies : a pool must show >= 9.00% fee/TVL  (binding gate: coverage ratio)
```

`requiredFeeTvlRatioForCoverage()` (`src/config/liveConfig.ts:481`) sengaja membebankan **gas floor**
0,008 SOL (≈ $0,81) agar kedua gate "sebanding". Tetapi call-site runtime di
`src/agents/dlmmTraderAgent.ts:1253` memberi `assessBreakeven` nilai `priorityFee.totalUsd × 2`
(≈ $0,003 pada Hermes — `est_gas_cost_usd` tercatat $0,0010 – $0,0014). Basis biayanya karena itu
$1,036, bukan $1,816, dan syarat coverage runtuh dari 9,00 % ke **5,1 %**.

Konsekuensinya bar yang mengikat berbalik: **floor $1,50 (6,6 %) yang mengikat**, bukan coverage.
Buktinya langsung terbaca di log — **52 pool lolos gate coverage lalu gagal di floor $1,50**, yang
mustahil terjadi bila coverage benar-benar mengikat pada 9 %.

Ini kebalikan dari kegagalan yang diperingatkan `CLAUDE.md`: baris boot mengiklankan bar **lebih
tinggi** (9,00 %) daripada yang ditegakkan (6,6 %) — faktor ~1,36×. Operator yang membaca 9 % akan
menyimpulkan gate lebih ketat dari kenyataannya, dan salah menilai berapa banyak pasar yang tersaring.

### 2.2 Rekomendasi teknis

**Jangan longgarkan gate.** Gate sudah menghasilkan aliran entry (1 per 22,4 j) dan tidak sedang
kelaparan kandidat. `CLAUDE.md` melarang `MIN_FEE_COST_COVERAGE` / `LIVE_MIN_NET_PNL_USD` sebagai tuas;
tuas yang disahkan adalah ukuran posisi, dan itu belum perlu ditarik.

**Prioritas 1 — perbaiki ketidakcocokan 9,00 % vs 5,1 % lebih dulu.** Ini angka yang dipakai operator
untuk menyetir, dan sekarang salah. Dua opsi, pilih satu secara sadar:

- **(a)** bebankan gas floor yang sama ke `assessBreakeven` di call-site runtime — gate mengeras ke 9 %
  seperti yang diiklankan, konsisten dengan aturan "biaya tak diketahui bukan biaya nol"; atau
- **(b)** laporkan basis biaya runtime di `describeLiveEnvelope` — baris boot jadi jujur pada 6,6 %.

Opsi (a) lebih selaras dengan disiplin fail-closed di repo ini. Apa pun pilihannya,
`v11Baseline.test.ts` dan `liveConfig.test.ts` harus ikut diperbarui di commit yang sama.

**Prioritas 2 — instrumentasi funnel scan.** Cetak/persistensi `summary.scanned` dan
`ScreenResult.rejected` agar laporan berikutnya bisa menjawab "Total Pool Scanned" dari data, bukan
aritmetika nominal, dan agar penyempitan 600 → ~20 dapat diaudit.

**Prioritas 3 — DLMM executor (`openPosition` / `claimFees` / `closePosition`): BANGUN, JANGAN ARM.**

Alasan membangun sekarang: gate bukan penghambat, Stage 1 (`onchainExecutor.ts`) sudah ditinjau dan
terisolasi oleh tiga kunci (tipe `ExecutionAuthorization`, `ONCHAIN_EXECUTION_ARMED`, uji import-graph),
dan Stage 2 adalah pekerjaan integrasi panjang terhadap tipe `@meteora-ag/dlmm` yang nyata. Membangunnya
tidak menggerakkan satu lamport pun selama ketiga kunci itu tetap utuh — `dlmmExecutor` yang melempar
`NotImplementedError` adalah kontrak yang benar sampai instruksinya nyata.

Alasan **belum** mengarmnya: n=3. Tiga trade tidak dapat membedakan strategi dari koin lempar. Payoff
struktural masih 0,63 (TP +5 % lawan SL −8 %), fee aktual $1,92 hanya 20 % dari magnitudo PnL kotor
$9,46, dan aktivitas terkonsentrasi ekstrem — hanya **16 pool unik** yang pernah mencapai gate
pasca-screener dalam 67 jam, dengan DOGE-1-SOL dan fone-SOL menyumbang hampir seluruhnya.

Syarat arming yang diusulkan, dalam urutan:

1. Perbaikan Prioritas 1 sudah masuk dan gate yang ditegakkan terdokumentasi benar.
2. ≥ 30 trade V1.1 micro-capital tertutup — pada 1 entry / 22,4 j ≈ **28 hari** dry-run lagi.
3. Bukti bahwa fee capture, bukan arah harga, yang menggerakkan PnL pada sampel itu.
4. `npm run test:swap -- --execute` sukses satu kali secara manual (Stage 1, mainnet, nominal mikro).
5. Baru kemudian Stage 2 di-arm — dan `onchainExecutor.test.ts` yang gagal adalah gerbang review, bukan
   rintangan untuk dilewati.

---

## Lampiran — rincian harian

| Segmen (WIB) | Siklus | Kandidat | Cooldown | Anti-rug lolos/tolak | Vol | Coverage | Micro | At-cap | Model tolak | Dibuka |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 03 Sep 14:38 → 04 Sep 07:00 | 33 | 402 | 16 | 74 / 58 | 9 | 51 | 0 | 11 | 5 | 1 |
| 04 Sep 07:00 → 05 Sep 07:00 | 48 | 1.026 | 3 | 122 / 118 | 9 | 62 | 27 | 8 | 18 | 1 |
| 05 Sep 07:00 → 06 Sep 07:00 | 48 | 1.150 | 5 | 135 / 153 | 25 | 69 | 25 | 0 | 9 | 0 |
| 06 Sep 07:00 → 09:30 | 6 | 155 | 0 | 22 / 14 | 11 | 7 | 0 | 0 | 0 | 0 |
| **Total** | **135** | **2.733** | **24** | **353 / 343** | **54** | **189** | **52** | **19** | **32** | **2** |

Batas segmen berjangkar pada baris `[researcher] starting run for <tanggal>` (cron `0 7 * * *` WIB),
satu-satunya penanda waktu absolut yang tersisa di log — prefiks timestamp PM2 tidak aktif pada run ini.

---

*Dibuat 2026-09-06 dari DB live + log PM2 Hermes, disilangkan dengan `exports/` di origin/main `8cad655`.
Semua angka dry-run: tidak ada kapital nyata yang dikerahkan dan build ini tidak menandatangani
transaksi apa pun.*
