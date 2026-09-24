# RENCANA: FlowMetrix versi SIGNAL-ONLY (tanpa eksekusi otomatis)

Status: **rencana + proof-of-concept jalan** (22 Sep 2026)
Konteks: engine LIVE di-pause 22 Sep 2026, operator pindah ke Kryskal
(`docs/HANDOFF-2026-09-22-PAUSE-dan-pelajaran.md`)
PoC: `src/scripts/runSignalScan.ts` — sudah jalan, sudah diverifikasi 2×, nol jejak ke wallet.

---

## 1. Kenapa arah ini masuk akal

Yang mahal dan rapuh di versi otomatis bukan **pilihannya**, tapi **eksekusinya**:

| Kelas masalah | Bukti dari sesi 22 Sep |
|---|---|
| Eksekusi on-chain multi-transaksi | exit butuh 1–3 tx (zap vs legacy close→jual residu→tutup ATA), tiap tx bisa gagal separuh jalan |
| RPC Helius 522 | 2 dari 3 request gagal (19,5 s timeout), bikin anti-rug jadi `UNKNOWN` → gate sering salah vonis |
| Alarm palsu | ~40 alert semalam: 17× "wallet anomaly", 2× cadence, 3× drawdown "TIDAK TERUKUR" — semua bukan masalah nyata |
| Margin tipis | gate biaya 2,5× hampir tidak pernah lolos pada notional kecil |

Kesimpulan: **keputusan**-nya (pool mana, range berapa, kenapa) sebenarnya sudah jalan tiap 20 menit.
Yang belum pernah bisa diandalkan adalah mesin yang menandatangani sendiri. Jadi langkah pertama
yang benar adalah memisahkan keduanya: keluarkan sinyalnya, buang tangannya.

---

## 2. Apa itu "signal-only" di repo ini (secara teknis, bukan slogan)

Tiga switch, dan hanya kombinasi ini yang aman:

```
DRY_RUN=true                  # engine: sizing + friksi saja, tidak menandatangani
ONCHAIN_EXECUTION_ARMED=false # pintu signing tetap terkunci
LIVE_MICRO_CAPITAL=false      # sizing pakai jalur kertas (VIRTUAL_SOL_PER_POSITION)
```

Diverifikasi di kode, bukan asumsi:

- `isLiveTradingEnabled = !DRY_RUN && ARMED` (`src/config/env.ts`) — dan `env.ts` **menolak boot**
  kalau `DRY_RUN=false` tanpa arming. Jadi dua switch itu harus bohong bersamaan; tidak bisa tidak sengaja.
- `isLiveExecutionActive() = isLiveTradingEnabled && liveMicroCapital.enabled`
  (`src/config/liveConfig.ts:374`). Ini yang benar-benar menjaga pintu.
- `openLivePosition(...)` hanya dipanggil di dalam `if (isLiveExecutionActive())`
  (`dlmmTraderAgent.ts:2400`) → di mode sinyal, `liveOutcome` selamanya `null` dan barisnya PAPER.
- Gate `engine_control.json` dan news-blackout pun **inert di mode paper** (keduanya dibaca di balik
  `isLiveExecutionActive()`) — artinya scan jalan terus walau pause menyala, dan pause tetap utuh
  untuk mode live. Dua hal itu tidak saling ganggu.
- `LIVE_MICRO_CAPITAL=false` penting: jalur live menskalakan ukuran posisi dari saldo wallet, dan
  guard-nya menolak semua entry saat wallet kosong (`LIVE_CAPITAL_SOL − 0,15 > SOL wallet`).
  Kalau sinyal ikut jalur itu, wallet kosong = tidak ada sinyal selamanya. Jalur kertas memakai
  `VIRTUAL_SOL_PER_POSITION` dan tidak peduli saldo.

**Aturan yang dipegang:** tidak ada satu baris pun di jalur sinyal yang menyentuh
`onchainExecutor` / `liveExecution` / `zapClose`. Kalau nanti ada yang mau menambah, tambahannya
harus di modul lain, bukan di sini.

---

## 3. Yang dipakai ulang vs yang dibuang

Reuse (jangan difork — ini yang bikin versi sinyal dan versi live tidak saling menyimpang):

- `fetchLivePools()` — ambil 600 pool dari Meteora API (bukan RPC, jadi tetap jalan saat Helius 522)
- `screenPools()` + filter lokal (held / cooldown / batas eksekusi) — funnel yang sama
- `applyAntiRugScreen()` — cek mint authority, freeze authority, konsentrasi top-10
- gate GMGN (holder structure), gate volatilitas (jangan beli yang sudah pump)
- gate biaya `assessBreakeven` — **rasio**, dan ini pertanyaan intinya
- `buildCandidatePrompt()` + `structuredCompletion()` — prompt & model DeepSeek yang sama
  (termasuk blok RECENT LOSSES biar range-nya belajar dari kerugian sendiri)
- `computeBinRange()`, `shadowRulePick()` — perbandingan LLM vs aturan bodoh, gratis

Dibuang seluruhnya:

- `onchainExecutor` (signing, priority fee, send/confirm)
- `liveExecution` (buka/tutup posisi nyata), `zapClose` (exit 1 tx), `attemptResidualHeal` (jual residu)
- `reconciliation` buku↔chain, `inFlight` (pemulihan tx nyangkut), keeper LP manual
- automasi exit (TP/SL/umur) sebagai **tindakan** — tapi logikanya tetap dipakai untuk **menilai**
  sinyal lama (bagian 6)

---

## 4. Arsitektur v1 yang gw rekomendasi: cron tanpa daemon, tanpa buku

```
setiap 20 menit  →  runSignalScan.ts (sekali jalan, lalu mati)
                      ├─ scan 600 pool → gate → LLM
                      ├─ kalau ENTER  → kirim kartu sinyal ke Telegram
                      ├─ kalau SKIP   → SENYAP (atau 1 baris digest harian)
                      └─ selalu       → 1 baris JSONL ke data/signal-ledger.jsonl

harian 21:00     →  scorecard: nilai semua sinyal ENTER ≥24 jam lalu
                      → "3 sinyal, 2 hipotetis profit, median +1,4% setelah biaya"
```

Kenapa tanpa daemon: seluruh rasa capek dari versi lama datang dari proses yang hidup terus
(pm2 + 18 cron + watchdog + guard + reconciler). Versi sinyal tidak butuh state hidup sama sekali —
tiap scan berdiri sendiri. Kalau satu run gagal, run berikutnya 20 menit lagi tidak terpengaruh.
Tidak ada state keuangan berarti tidak ada state yang bisa rusak.

Biaya: 1 panggilan LLM per scan yang sampai ke tahap keputusan (bukan per pool), plus ~60 request
HTTP ke Meteora API. Tidak ada RPC kecuali anti-rug (dan itu pun tahan 522: hasil `UNKNOWN` dicatat,
bukan bikin proses mabur).

---

## 5. PoC yang sudah jalan (bukan mock)

`src/scripts/runSignalScan.ts` — 1 perubahan pendukung di engine: `seekNewEntry()` di-export
(sebelumnya private) supaya jalur sinyal memakai funnel yang sama, bukan salinan.

Bukti run PoC pertama (22 Sep 2026, 10:54 WIB — format kartu awal, bahasa Inggris; versi finalnya di §5b):

```
🔎 SINYAL (mode kertas) — 22/9/2026, 10.54.01 WIB

Aksi     : SKIP — tidak ada sinyal yang layak masuk
Alasan   : no candidate clears the breakeven gate (2.5x round-trip cost over 24h of fees)

Hampir lolos tapi biaya nggak ketutup:
  • SOL-USDC: fee 24h $1.68 vs round-trip $2.34 → 0.72x (butuh 2.5x)
  • EMBER-USDC: fee 24h $5.5 vs round-trip $2.34 → 2.35x (butuh 2.5x)

Funnel   : 600 pool discan → 58 lolos screener kuantitatif → 58 lolos filter lokal
           (cooldown/eksekusi) → 2 lolos anti-rug → 0 lolos gate biaya
Dibuang  : anti-rug 4 · biaya 2

NO EXECUTION — nggak ada yang ditandatangani, nggak ada wallet yang disentuh.
```

Yang diverifikasi pada run itu:

- exit code 0, `npx tsc -p tsconfig.json --noEmit` bersih
- **DB engine tidak tersentuh**: mtime & ukuran `data/flowmetrix.db` identik sebelum/sesudah
  (script pakai `DATABASE_PATH=./data/signals.db` sendiri + ledger `data/signal-ledger.jsonl`)
- proses menolak jalan sendiri kalau `isLiveExecutionActive()` ternyata true (guard exit 2)

Temuan penting dari PoC: **gate biaya inilah pembunuhnya, dan ini ketemu lebih cepat di mode sinyal
daripada di mode live.** Round-trip $2,34 pada notional 1 SOL ≈ 0,0165 SOL ≈ 1,65% — masih wajar.
Dengan sizing live (0,2 SOL), biaya yang sama = ~8% dari notional → secara struktur mustahil lolos
2,5×. Itu penjelasan lengkap "31 siklus nol entry": bukan screener-nya rusak, ukurannya yang kekecilan
relatif terhadap biaya nyata. Versi sinyal harus melaporkan rasio ini apa adanya (pada 2–3 ukuran
referensi) dan biarkan operator memutuskan, bukan menyembunyikannya di balik SKIP.

---

## 5b. Kartu versi final: bahasa Indonesia, rapi, tanpa jargon (22 Sep 2026, 18:35 WIB)

Arahan operator: *"signalnya dibikin versi bahasa indonesia dan jauh lebih rapih, pastikan tidak
terlalu berantakan dengan istilah2 teknical"*. Yang berubah di renderer:

- Seluruh kartu bahasa Indonesia dengan label manusiawi (Rentang aman, Gaya posisi, Modal uji,
  Keyakinan model), angka format Indonesia via `id-ID` (`57.652`, `0,094266`). Istilah yang dibuang
  dari permukaan: TVL, binStep, round-trip, coverage, notional, funnel.
- Tesis model — yang ditulis dalam bahasa Inggris oleh prompt engine — diterjemahkan dan diringkas
  oleh **satu panggilan LLM tambahan** (`structuredCompletion`, model chat, `maxTokens 500`,
  hanya saat ENTER, jadi maks 3×/hari). Kalau panggilan itu gagal, kartu tetap keluar dengan kalimat
  pengganti bahasa Indonesia: sinyal tidak pernah ditahan karena penerjemahnya error.
- Angka pendukung diambil dari **baris buku kertas yang barusan ditulis funnel** (perkiraan untung
  sehari, biaya buka+tutup, rasio, kepemilikan 10 wallet terbesar, status izin token) — angka yang
  sama dengan yang dipakai gate biaya, bukan estimasi kedua yang bisa berbeda.
- Catatan penting soal biaya: `est_gas_cost_usd` di baris kertas **bukan** biaya pulang-pergi yang
  dipakai gate — kolom itu hanya biaya jaringan (pecahan sen), sedangkan gate menghitung gas + 2 leg
  swap + kerja ATA. Kartu menampilkan biaya hasil hitung ulang `fee sehari ÷ rasio cakupan`
  (6,21 ÷ 2,65 = $2,34). Versi pertama memakai kolom itu dan hasilnya "biaya $0,00" di sebelah untung
  positif — plus angka "untung bersih sehari" jadi salah (terbaca seperti seluruh fee, bukan fee
  dikurangi biaya).

Bukti run nyata (22 Sep 2026, 18:39 WIB, ENTER — potongan dari `Harga masuk` ke bawah, verbatim;
baris di atasnya adalah `🎯 SINYAL — CATE-USDC` + `22/9/2026, 18.39… WIB · mode uji, uang sungguhan nol`,
terpotong oleh `tail` di log terminal):

```
Harga masuk    : 0,095022
Rentang aman   : turun maks 45% · naik maks 15%
Gaya posisi    : tumpuk beli di bawah, jual di atas
Modal uji      : 1,0000 SOL — virtual, bukan saldo lu
Keyakinan model: 70 dari 100

Kenapa: Pasangan CATE-USDC menghasilkan biaya harian yang besar, sekitar 5,31% dari nilai
likuiditas, dengan volume 24 jam mencapai 26 kali nilai likuiditas. Aktivitas perdagangan tetap
ramai sehingga biaya transaksi tetap tertutup.
Risiko: Belum ada riwayat kerugian, jadi batas aman dipasang di 45% turun dan 15% naik untuk
membatasi kerugian akibat fluktuasi harga.

Kondisi pool saat ini:
• Umur 51 hari · likuiditas $57,7 rb · transaksi 24 jam $1,53 Jt
• Kesibukan sekarang 0,18× rata-rata harian — mulai sepi
• Pergerakan harga: 1 jam −0,4% · 24 jam −16,5%
• Untung sehari $6,22 vs biaya buka+tutup $2,35 — 2,65× lipat dari biaya
• 10 pemegang terbesar 16,1% · pemilik token tidak bisa mencetak token baru atau membekukan saldo

Rencana standby:
• Balik modal biaya ± 9,0 jam kalau aktivitasnya bertahan
• Kalau seramai ini sehari penuh: untung bersih ± $3,88
• Cek posisi tiap ± 3 jam
• Keluar kalau harga tembus 0,052262 (bawah) atau 0,109275 (atas)
• Keluar kalau untung harian turun di bawah $2,35

Alur penyaringan: 600 kandidat diperiksa → 58 lolos saringan awal → 3 lolos pemeriksaan keamanan → 1 lolos uji biaya
Gugur karena: keamanan token 3 · biaya 2

Tidak ada yang dieksekusi — ini pemberitahuan, bukan perintah.
```

Catatan: baris "Kesibukan sekarang 0,18× … mulai sepi" adalah temuan yang layak dibaca dua kali —
pool masih lolos gate 24 jam, tapi volume satu jam terakhir sudah jauh di bawah rata-rata, dan itu
masuk kartu justru supaya operator bisa menolak sinyal yang secara statistik masih "bagus".

### 5c. Kanal Telegram engine dimatikan di jalur sinyal (22 Sep 2026, 21:15 WIB)

Gejala: operator **masih** menerima notifikasi yang tidak sesuai template:

```
🟢 PAPER POSITION OPENED (DRY-RUN)

Pair: CATE-USDC
Strategy: SPOT
Size: 1 SOL (virtual)
Entry: 0.091482
Range: 0.050315 — 0.109779
Confidence: 62/100
...
```

Sumbernya bukan gerbang kartu, tapi **kanal Telegram milik engine sendiri**
(`src/services/telegram.ts` → `sendPositionOpened()`, teks hard-coded Inggris). Setiap kali funnel
menulis baris kertas — termasuk di jalur sinyal — engine mengirim alert itu pakai
`TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` dari `.env`. Jadi SATU sinyal menghasilkan DUA pesan dengan
template berbeda, dan yang lama itu yang terbaca sebagai "bot masih belum sesuai template".

Perbaikan: `runSignalScan.ts` mengosongkan kedua variabel itu **sebelum** mengimpor modul engine
(`hasTelegram` dihitung sekali saat import, `loadDotEnv()` tidak menimpa `process.env` yang sudah ada).
Jalur sinyal sekarang tidak punya kanal keluar sama sekali — kartu dari gerbang cron adalah
satu-satunya pesan. Ditambah dua pengaman: peringatan di stderr kalau kanal itu ternyata nyala, dan
field `engineTelegramEnabled` di ledger (harus `false`).

Verifikasi dua arah: dengan kredensial `.env` apa adanya `isTelegramEnabled()` = **true** (pembuktian
bahwa alert lama memang bisa terkirim), di jalur sinyal = **false**; ledger baris 21:18 mencatat
`engineTelegramEnabled: false` dan tidak ada baris `[telegram]` di stdout/stderr run.

Kartu saat tidak ada sinyal (run 18:50:48 WIB, verbatim; tidak dikirim ke Telegram, hanya masuk ledger):

```
🔎 SCAN — belum ada sinyal
22/9/2026, 18.50.48 WIB · mode uji, uang sungguhan nol

Kesimpulan: Tidak ada kandidat yang hasilnya cukup untuk menutup biaya masuk dan keluar.

Hampir lolos, tapi biayanya belum tertutup:
• SOL-USDC — untung sehari $0,98, biaya masuk+keluar $2,35: baru 0,42× (minimal 2,5×)

Alur penyaringan: 600 kandidat diperiksa → 58 lolos saringan awal → 4 lolos pemeriksaan keamanan → 0 lolos uji biaya
Gugur karena: keamanan token 2 · sedang naik terlalu tajam 2 · biaya 1

Tidak ada yang dieksekusi — ini pemberitahuan, bukan perintah.
```

### Temuan lapangan: model menolak CATE-USDC karena volume 1 jam

Beberapa menit setelah kartu 18:39, CATE-USDC mulai ditolak — dan bukan oleh screener, tapi oleh
model, yang membaca angka 1 jam:

> *"24h fee/TVL 5.34% and 1949% APR look rich, but 1h volume of $8.9k vs the $63k hourly 24h average
> is an ~86% collapse — the fee spike is already fading, not sustained. CATE is a volatile meme token
> with a 0.2% base fee pricing heavy toxicity, so IL risk on 1 SOL outweighs a decaying pool's fees.
> No loss history exists to justify widening a range. Skipping."* (18:49:52 WIB)

Ini bukti kenapa blok "Kondisi pool saat ini" penting: gate 24 jam masih meloloskan pool itu
(fee/TVL 5,34%), sementara kondisi satu jam terakhir sudah runtuh. Kolom `priceChange1hPct` +
`volume1hUsd` sekarang ada di ledger supaya scorecard bisa menguji hipotesis ini nanti
(apakah sinyal dengan kesibukan <0,5× memang lebih sering rugi).

---

## 5d. Analisa repo `github.com/CryptoGnome/dlmmbot` (22 Sep 2026, 22:15 WIB)

Repo itu bot LP Meteora DLMM yang jauh lebih matang (~25 ribu baris), lisensi **PolyForm Shield**
(nggak boleh dipakai buat bikin bot saingan). Yang kita ambil **matematika dan bentuk aturannya**,
kodenya ditulis sendiri di repo kita.

**Yang dipakai (sudah jalan, ada tesnya):**

1. **Fisika rentang bin** → `src/services/binRange.ts` (+ `src/tests/binRange.test.ts`, 13 tes lulus).
   Tahunya dari mana: `src/ranges/planner.ts` di repo itu.
   - `binsDownPct(p, step) = ceil(ln(1/(1−p/100)) / ln(1+step/10000))` — resiprokal, bukan `ln(1+p)`.
     Salah tanda di sini bikin −45% dilaporkan 186 bin padahal 300.
   - `binsUpPct(p, step) = ceil(ln(1+p/100) / ln(1+step/10000))`.
   - `depthForBins(n, step) = (1 − 1/(1+step/10000)^n) × 100`.
   - Sewa bin: 70 bin per bin-array, 0,075 SOL per array (titipan, balik utuh saat tutup).
   - Dicek silang ke angka yang repo itu sendiri terbitkan di komentarnya: −40% = 52 bin di step 100,
     256 di step 20, 512 di step 10. Punya kita harus menghasilkan angka yang persis sama.
   - Dipakai kartu: baris "Rentang … butuh N bin (batas M) — muat/TIDAK muat" + "Sewa bin: …",
     dan kalau nggak muat, judul kartu nggak lagi menjanjikan −45% (ditulis kedalaman nyatanya).
   - Catatan: batas bin kita 1400 per posisi (`DLMM_MAX_BINS_PER_POSITION`, operator bisa turunin lewat
     `LIVE_MAX_POSITION_BINS`), sedangkan repo itu 69 per posisi. Angkanya **dihitung dari konstanta
     kita**, bukan disalin.

2. **Bentuk aturan keluar** dari `config.toml` repo itu (angkanya punya mereka, hasil replay mereka):
   - Give-back stop: setelah posisi pernah naik, keluar kalau untung tinggal 75% dari puncak
     (`give_back_keep_frac = 0.75`). Mereka ukur +2,657 SOL atas 120 penutupan.
   - Stop harus **bertahan**, bukan wick: di bawah range butuh 4 poll (~60 detik)
     (`stop_loss_sustain_polls`). Kasus nyata mereka: posisi ditolak −54% dua menit lalu +58% sejam
     kemudian — stop sekali-tick itu yang jadi kerugian terbesar di buku mereka.
   - Fee yang belum diklaim **tidak** dihitung sebagai untung (`stop_loss_count_claimed_fees = false`):
     6 dari 7 stop mereka kepicu karena mark sudah termasuk fee yang sebenarnya sudah dibayar ke kita.
   - Ini masuk kartu sebagai baris standby, bentuknya saja; angkanya belum kita kalibrasi sendiri.

**Yang TIDAK dipakai (dengan alasan):**
- Kelly sizing (`src/risk/limits.ts`) — butuh riwayat trade kita; belum ada (target: 100 sinyal dulu).
- Fib anchor sebagai dasar kedalaman (`fibLevel` di planner mereka) — bagus, tapi nunggu scorecard.
- Ambang rotasi mereka (fee harian <5%, volume 30 menit <$5 rb) — dikalibrasi ke sleeve mereka
  (meme vs majors beda), jangan import angka mentah. Bentuknya yang dipakai: keluar kalau aktivitas
  pool turun, dan itu sudah ada di kartu lewat baris "kesibukan sekarang".

**Lubang anti-rug yang sudah ditutup (22 Sep 2026, 22:1x WIB):**

Jalur sinyal sebelumnya cuma cek mint authority, freeze authority, dan konsentrasi top-10
(`screenTokenSafety`). Sekarang, khusus untuk sinyal ENTER, ada blok "Pemeriksaan token, sumber luar"
yang isinya dari dua endpoint gratis tanpa API key:

- `src/services/tokenForensics.ts` — Jupiter lite-api (`/tokens/v2/search`) + RugCheck
  (`/v1/tokens/<mint>/report`), digabung jadi satu penilaian + daftar `flags`:
  `mostly-inorganic-volume`, `inorganic-volume`, `lp-not-locked`, `lp-lock-unknown`, `rugged`,
  `serial-launcher`, `insider-networks`, `holders-concentrated`, `mint-authority-live`,
  `freeze-authority-live`, `no-data`.
- **`organicShare24h`** — ini yang paling penting. Jupiter memisahkan volume organik dari total;
  CATE-USDC: **11,4%** organik ($1,3 Jt dari $11,5 Jt). Artinya estimasi fee $6,22/hari itu
  sebagian besar dagang bot → kartu sekarang menulis angka "untung dari volume asli saja ± $0,71".
  Ambang: <25% = bendera, <10% = dianggap wash.
- Kunci LP (RugCheck `markets[].lp.lpLockedPct`), jumlah pemegang, dan konsentrasi top-10 (Jupiter
  `audit.topHoldersPercentage` — sudah di luar pool), riwayat dompet pembuat (`devMints`/
  `devMigrations` dari Jupiter) → penanda "pabrik token".
- Cache 6 jam (`~/.hermes/data/fm_forensics_cache.json`) supaya scan 20 menit tidak menghajar
  endpoint gratis; kalau jaringan gagal, cache lama tetap dipakai (lebih baik dari kartu tanpa
  bagian risiko).
- Tes: `src/tests/tokenForensics.test.ts` (12 tes) memakai **payload asli** yang disimpan di
  `src/tests/fixtures/` — angka di tes itu adalah angka yang benar-benar dikembalikan kedua layanan.
**GMGN masuk (22 Sep 2026, 23:0x WIB) — ini yang menjawab "bisa dijual atau nggak":**

`GMGN_API_KEY` di `.env` ternyata hidup. Endpoint yang jalan: `openapi.gmgn.ai/v1/token/security`
(header `X-APIKEY`), satu panggilan per mint, hanya saat ada sinyal ENTER.

- Yang dibaca: `honeypot`, `can_not_sell`, `buy_tax`/`sell_tax`, `burn_status`/`burn_ratio`
  (LP dibakar), `renounced_mint`/`renounced_freeze_account`, `top_10_holder_rate`, `flags`.
- Angkanya datang sebagai **string** ("0.1505") dan bendera sebagai 0/1 → semua diparse, bukan
  dipercaya; yang tak terbaca jadi `null`, bukan default aman.
- LP dibakar dihitung sebagai **100% terkunci** (bentuk terkunci paling kuat); kalau bukan burn,
  ambil `lock_detail[].percent` terbesar, lalu `left_lock_percent`.
- Bendera baru: `honeypot`, `sell-tax` (>5%), `high-tax` (>10% total), `sellable`,
  `gmgn-unavailable`.
- **Batas gratis GMGN itu galak**: percobaan uji cepat bikin IP kena ban ~1 menit
  (`RATE_LIMIT_BANNED` + `reset_at`). Sekarang panggilan diberi jarak 4 detik, `reset_at` dihormati,
  dan selama ban **tidak ada panggilan sama sekali**. Kalau GMGN tidak terhubung, kartu menulis
  "Jual-beli: belum diperiksa" — bukan diam-diam kelihatan bersih.
- Cache jadi dua tingkat: lengkap (dengan GMGN) 6 jam, tanpa GMGN cuma 20 menit supaya cepat dicoba
  lagi. Entri cache diberi versi (`CACHE_VERSION`) supaya bentuk lama tidak tersaji sebagai data baru.
- Bukti: `src/tests/tokenForensics.test.ts` — 18 tes, termasuk payload GMGN asli CATE
  (`fixtures/gmgn-security-cate.json`: honeypot 0, pajak jual 0%, LP dibakar, top10 15,05%) dan
  satu payload buruk sintetis yang harus memunculkan `honeypot`, `sell-tax`, `mint-authority-live`,
  `holders-concentrated`. Termasuk tes jalur 429 (fetch di-stub): panggilan kedua dalam masa ban
  tidak menyentuh jaringan.
- Belum dipakai: extension Token-2022, dan riwayat rug dompet dev (GMGN `/token/security` tidak
  menyediakannya; Jupiter cuma kasih jumlah mint/migrasi).

## 6. Ledger & scorecard (bagian yang bikin ini layak dipercaya)

Tiap scan menulis satu baris JSONL: waktu, aksi, pool, harga masuk, TVL, binStep, strategi, range,
confidence, tesis, notional referensi, plus angka funnel. Sejak 18:40 WIB juga: harga bin bawah/atas,
biaya pulang-pergi & rasio cakupan, `breakEvenHours`, pergerakan harga 1 jam/24 jam, umur pool, dan
volume 1 jam. Ini yang membuat klaim "sinyalnya bagus" bisa diuji alih-alih dipercaya.

Sejak 22:14 WIB ledger juga menyimpan: `engineTelegramEnabled` (harus `false` — lihat §5b),
`binRange` (fisika rentang, §5d), `forensics` (volume organik, LP terkunci, riwayat dev — §5d),
dan **`nearMisses`** — pool yang cuma gagal di uji biaya, lengkap dengan alamat pool dan harganya.

**Scorecard-nya sudah jalan** (`~/.hermes/scripts/fm_signal_scorecard.py`, cron harian 07:00 WIB):

- Episode = satu pool per jendela 6 jam (rumus `EPISODE_BUCKET_S` dari repo dlmmbot), jadi 11 kartu
  CATE dalam 20 menit dihitung **satu** episode, bukan sebelas.
- Harga ke depan diambil dari GeckoTerminal OHLCV menit (gratis, tanpa API key), patokan = harga
  bar pertama setelah sinyal. Yang dihitung: puncak, terendah, harga sekarang, berapa bar di bawah
  harga sinyal.
- Dua sisi yang diukur sekaligus: sinyal ENTER (kartu yang kita kirim) **dan** `nearMisses`
  (kartu yang kita tahan) — jadi pertanyaan "gate-nya kelewat ketat?" ada angkanya.
- Hasil mentah disimpan di `~/.hermes/data/fm_signal_outcomes.jsonl`; yang <24 jam ditandai
  "masih bisa berubah".
- Kartunya selalu menulis pengingat: puncak/terendah itu **gerakan harga, bukan untung LP** —
  posisi LP nggak ikut naik penuh (IL), jadi angka ini buat menilai *gate*, bukan menagih PnL.

Belum ada: pembanding LLM vs `shadowRulePick` per episode (field-nya sudah ada di ledger,
tinggal disambung ke scorecard), dan PnL LP hipotetis yang memperhitungkan IL + fee.

Metrik yang akan dipakai untuk memutuskan apa pun selanjutnya (dikunci sekarang, biar tidak
diakal-akal nanti): jumlah sinyal, hit rate, median PnL hipotetis setelah biaya, dan rasio
LLM vs aturan bodoh.

---

## 7. Guardrail anti-spam (wajib, pelajaran dari 40 alert palsu)

- Kartu hanya dikirim kalau **ada** sinyal ENTER. SKIP = senyap.
- Maksimum **3 kartu per hari**. Sinyal ke-4 dan seterusnya masuk digest, bukan notifikasi.
- Dedupe per pool: pool yang muncul lagi dalam 4 jam tidak dikirim ulang kecuali sinyalnya berubah
  arah (ENTER→SKIP) atau range baru lebih lebar.
- Kalau RPC error rate tinggi (>50% dalam 20 menit), tulis di ledger dan jangan kirim apa pun —
  sinyal dari alat ukur yang rusak lebih buruk daripada tidak ada sinyal.
- Satu kejadian, satu pesan. Script tidak boleh `echo` ke stdout **dan** kirim sendiri.

---

## 8. Perubahan kode untuk v1 (status per 22 Sep 2026, 18:40 WIB)

1. ~~`seekNewEntry({ persist: false })`~~ → **diganti pendekatan yang lebih kecil**: script sinyal
   memakai DB sendiri (`data/signals.db`) dan **menghapus baris kertasnya sendiri setiap kali scan**
   (stateless). Funnel tetap apa adanya, tidak ada perubahan tanda tangan fungsi di engine — selain
   satu baris `export` di `seekNewEntry()`. Ada guard: kalau `FM_SIGNAL_DB` diarahkan ke file yang
   bukan `signals*.db`, script menolak menyentuh bukunya.
2. Renderer kartu → **jadi** (`src/scripts/runSignalScan.ts`, mode `--json` dengan marker).
3. Cron Hermes 20 menit → **jadi**: job `18bf6e51c430`, `no_agent`, script
   `~/.hermes/scripts/fm_signal_gate.py`, kirim ke chat ini. Senyap saat SKIP.
4. Gate anti-spam → **jadi**: `fm_signal_gate.py` (cap 3 kartu/hari WIB, dedupe pool 4 jam,
   senyap saat SKIP, 3× gagal berturut → **satu** peringatan lalu senyap sampai pulih,
   semua jalur exit 0 supaya cron tidak jadi alarm). Harness: 11/11 lulus (`/tmp/test_signal_gate.py`).
5. Scorecard harian → **belum** (langkah berikutnya; ledger `data/signal-ledger.jsonl` sudah
   mengumpulkan datanya sejak sekarang).
6. `.env` profil sinyal → **tidak perlu diubah**: script memaksa `DRY_RUN=true`,
   `ONCHAIN_EXECUTION_ARMED=false`, `LIVE_MICRO_CAPITAL=false` di dalam prosesnya sendiri, jadi
   `.env` engine boleh tetap profil live — dan tetap tidak bisa mengeksekusi dari jalur ini.

Tidak ada yang menyentuh uang. Tidak ada yang perlu pm2. Tidak ada yang perlu wallet terisi.

---

## 9. Kalau nanti mau balik ke eksekusi otomatis

Syarat minimum, bertahap, tanpa lompat:

1. ≥100 sinyal tercatat, hit rate >50%, median PnL hipotetis **positif setelah** biaya round-trip nyata.
2. Notional yang dipakai ≥5× biaya round-trip (biar gate 2,5× bukan pertanyaan omong kosong).
3. Uji eksekusi 1 transaksi kecil yang disetujui manual — bukan otomatis.
4. Baru setelah itu pertimbangkan auto-exit, dan hanya dengan fail-safe yang sudah terbukti
   (residual sweep, in-flight recovery).

Sampai poin-poin itu terpenuhi, tidak ada alasan untuk menaruh uang di mesin ini lagi.

---

## 10. Default yang akan gw pakai kalau tidak ada arahan lain

- Mode: sinyal saja, cron 20 menit, senyap saat SKIP, cap 3 kartu/hari.
- Ledger JSONL + scorecard harian, mulai hari pertama.
- Wallet engine tetap kosong. `engine_control.json` tetap `paused: true`. Cron engine lama tetap paused.
- Tidak ada perubahan pada jadwal Threads/news.
