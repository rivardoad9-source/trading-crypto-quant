# Work order #3 — skala universe window lama + kelengkapan biaya exit (14 Sep 2026)

Branch: `work/window-universe-scale-and-exit-cost-completeness` (dari `main` @ `7b340bf`).
Tidak ada deploy, restart pm2, perubahan `.env`, atau transaksi on-chain.

## Ringkasan

| Bagian | Status | Commit |
|---|---|---|
| A. universe window lama (P0) | implement + test sintetis + 2 run terbatas lokal | `245d343`, `05e9302` |
| B. biaya exit: semua tx close + harga landing (P1) | implement + test | `942f8ed` |
| C. suite hijau di Windows (P2) | beres, assertion tidak diubah | `689b122` |

- `npm run typecheck`: hijau (dua project).
- `npm test` di Windows: **970 test / 970 pass / 0 fail** (baseline 954 + 16 test baru; 2 EPERM hilang).

## A. Universe window lama

### Yang berubah

| Item | Sebelum | Sesudah |
|---|---|---|
| `--candidates` default (jalur per-window) | `n*3` = 96 | **200** |
| pages survivor / dead cohort | hardcode 12 / 40 | `--survivor-pages` / `--cohort-pages` (default 12 / 40) |
| window end | selalu `now` → nama cache geser tiap hari | `--end=YYYY-MM-DD` opsional untuk pin tanggal |
| param ingest | tidak disimpan | disimpan di partial + dataset (`selection.ingest`) |
| cache dengan jangkauan lebih sempit dari yang diminta | kena "hit" diam-diam | **extended**: universe dibangun ulang, kandidat baru DITAMBAH, kandidat lama + file bar-nya dipakai ulang |
| reuse file bar | by COUNT (`requestedBars >= barsWanted`) | by WAKTU jangkauan fetch (`fetchedAt − requestedBars·1h ≤ start window tertua`) |
| funnel | 4 angka tolak | kandidat / dipakai / lahir sesudah / <24 bar / band TVL (bawah/atas) / di luar top N / **fetch gagal** / coverage / k, direkonsiliasi, dicetak SEBELUM analisis (juga di `--ingest-only`) |
| profil akun | hardcode $300 / 63% / 1 → header `NOT THE LIVE PROFILE` | `readProfileOverrides(flags)` + `resolveBacktestProfile()`; dicek di awal supaya `BacktestProfileError` muncul SEBELUM ingest berjam-jam |
| paruh IS/OOS | `IS/OOS trd` saja | tanggal split + `N pool / M trd` per paruh; 0 pool = `sampel kosong (0 pool)` |
| jawaban varian | satu jawaban gabungan | **per window** {YA / TIDAK / BELUM BISA DIVERIFIKASI} + gabungan; kalimat eksplisit kalau semua belum bisa diverifikasi |

Jalur lama (flag OFF) tidak disentuh; test kunci "leaves main's published path untouched" tetap lulus
tanpa diubah. Syarat bar tidak diubah (≥8 trade/paruh, payoff > 1, expectancy > 0). Konstanta
`exitCost.ts` tidak diubah. Window tidak dirata-rata.

**Kenapa reuse-by-waktu penting untuk ingest server:** start window tertua tetap, tapi "jam dari
sekarang ke start itu" nambah 24 per hari. Aturan lama bikin semua file bar kebaca terlalu dangkal
sehari setelah run → ingest 2–3 jam mulai dari nol. Terbukti di run lokal di bawah: 39 dari 40 pool
diambil dari file bar kemarin.

### Bukti run terbatas (lokal, Windows)

**Run 1 — cache lama 96 kandidat, dibaca ulang tanpa network:**
`--per-window-universe --windows=3 --candidates=96 --end=2026-09-13 --ingest-only`

| Window | Periode | Cache | Kandidat | Dipakai | Lahir sesudah | <24 bar | Band TVL | Di luar top N | Fetch gagal | Coverage | k |
|---|---|---|---|---|---|---|---|---|---|---|---|
| W1 | 2026-06-14 → 2026-09-13 | hit | 96 | 32 | 0 | 6 | 47 | 11 | 0 | 31/32 | 0.195 |
| W2 | 2026-03-15 → 2026-06-14 | hit | 96 | 13 | 0 | 4 | **79** | 0 | 0 | 13/32 | 0.195 |
| W3 | 2025-12-14 → 2026-03-15 | hit | 96 | 11 | 0 | 14 | **71** | 0 | 0 | 11/32 | 0.195 |

Angka WO2 ter-reproduksi dan funnel rekonsiliasi (W1: 32+6+47+11 = 96). File lama tidak punya
split bawah/atas band TVL (kolom itu baru). W3 dapat catatan otomatis: mulai sebelum kedalaman data
gratis ~208 hari, jadi sebagian "<24 bar" di sana batas plan, bukan fakta pool.
Coverage W1 31/32 (bukan 32/32) karena `--end` jam 00:00 UTC sedangkan cache dipotong jam ~03:10
di hari yang sama; satu pool kehilangan bar di pinggir window.

**Run 2 — ingest baru, 1 window, cap 40:**
`--per-window-universe --windows=1 --candidates=40 --ingest-only` (end = hari ini)

| Window | Periode | Cache | Kandidat | Dipakai | Lahir sesudah | <24 bar | Band TVL (bawah/atas) | Di luar top N | Fetch gagal | Coverage | k |
|---|---|---|---|---|---|---|---|---|---|---|---|
| W1 | 2026-06-15 → 2026-09-14 | fresh | 40 | 17 | 0 | 0 | 23 (**22/1**) | 0 | 0 | 17/32 | 0.131 |

Fetched 1, cached 39, ±0.2 menit untuk loop bar (di luar walk listing Meteora).

### TEMUAN (sampel, bukan hasil strategi)

1. **Rem yang mengikat di ketiga window adalah band TVL modelled**, bukan cap kandidat: 47 / 79 / 71
   dari 96. Di run 2, **22 dari 23** tolakan band itu karena TVL modelled DI BAWAH `MIN_TVL_USD`
   ($50k), bukan di atas. Artinya menaikkan cap ke 200 menambah kandidat, tapi kalau kandidat
   tambahan dari walk dead-cohort juga kecil, W2/W3 bisa tetap di bawah 32. Split bawah/atas
   sekarang kecetak per window, jadi run penuh di server langsung menunjukkan ini.
2. **k hari ini 0.131, bukan 0.195** (run 2 dipilih dari kandidat berbeda hari ini). k dipakai
   langsung di band (TVL = k × median volume harian), jadi pergeseran k ikut menggeser berapa pool yang
   masuk band. Run penuh harus melaporkan k-nya sendiri; angka 0.195 tidak bisa dibawa.
3. Window yang tipis tetap dicetak `TEMUAN — universe X/32, kurang Y, rem pengikat …`, dan tidak pernah
   dicetak sebagai "tidak ada trade karena strategi".

### Cara jalanin ingest penuh (untuk Hermes)

```bash
# pakai ulang daftar 96 kandidat + file bar yang sudah ada; daftar di-EXTEND ke cap 200
npm run backtest:integrity -- --per-window-universe --windows=3 --days=91 --end=2026-09-13 --ingest-only
# kalau masih kurang dari 32 dan rem-nya band TVL bawah: walk dead-cohort lebih dalam
npm run backtest:integrity -- --per-window-universe --windows=3 --days=91 --end=2026-09-13 --cohort-pages=120 --candidates=320 --ingest-only
# analisis (profil LIVE dari .env server)
npm run backtest:integrity -- --per-window-universe --windows=3 --days=91 --end=2026-09-13
```

Tanpa `--end`, nama window ikut tanggal hari ini: daftar kandidat lama TIDAK dipakai (dibangun baru),
tapi file bar tetap dipakai ulang lewat aturan waktu. Ingest tetap resume-able (interrupt → jalankan
perintah yang sama). Kalau `.env` tidak punya profil live yang lengkap, `BacktestProfileError` muncul
di awal run analisis — itu disengaja.

## B. Biaya exit

| Item | Perubahan |
|---|---|
| B1 | `settleLiveCloses` meneruskan `signatures` dari `closeLivePosition`. Kolom baru `close_signatures` (JSON array). `exit_fee_lamports` = fee semua tx close + sweep + ata_close; signature final tidak dihitung dua kali; satu tx tidak terbaca → fee NULL + catatan. `close_signature` tetap = tx final. |
| B2 | Pembacaan pool yang sudah ada di recorder (jalan SESUDAH close + sweep) sekarang juga ambil `currentPrice` → `pool_price_after_sweep`. Kolom baru `sweep_concession_after_sweep_bps`, `exit_cost_after_sweep_bps`. `exit_cost_bps` / `sweep_concession_bps` tidak berubah (ada test nilai identik). Pool tidak terbaca / harga ≤ 0 → NULL + catatan, bukan 0. `report:exitcosts` punya tabel konsesi @keputusan vs @landing. |
| B3 | Rute `dlmm-pool`: catatan eksplisit bahwa `sweep_slippage_bps_used` adalah CAP ladder, bukan rung yang menjual. |
| B4 | Row `backfill` tidak disentuh; `close_signatures` & harga landing NULL + catatan. Insert-if-absent tetap. |
| Migrasi | 4× `addColumnIfMissing("exit_economics", …)` sesudah `CREATE TABLE IF NOT EXISTS`; row lama tetap NULL di kolom baru. |

Test B5: (a) jumlah fee semua signature + dedup final, (b) migrasi pada tabel bentuk lama berisi 7 row
(proses anak, `initDatabase`), (c) landing price NULL + catatan, (d) report dua konsesi, (e) backfill
idempoten, (f) test source-shape "recorder sesudah row ditutup, di luar mutex" tidak dilemahkan +
recorder tidak pernah throw.

## C. Windows

`exitSlippage.test.ts` dan `postSwapReadRetry.test.ts`: hook `after` sekarang `closeDatabase()` dulu,
baru `rmSync`. Tidak ada assertion yang berubah. 18/18 pass di Windows (sebelumnya 2 EPERM).

## Yang gw nggak bisa klaim

- **Pertanyaan TP/gate belum terjawab.** Gw tidak menjalankan ingest penuh maupun analisis; tidak ada
  angka trade/net baru di laporan ini. `backtest_window_universe_summary.json` / `_report.txt` yang ada
  di repo masih hasil WO2.
- **Belum terbukti W2/W3 bisa mencapai 32 pool** dengan cap 200. Temuan di atas (band TVL bawah yang
  mengikat) justru mengarah ke kemungkinan belum cukup.
- Split bawah/atas band TVL untuk W2/W3 belum ada angkanya — file cache lama tidak menyimpannya; baru
  muncul setelah server re-select.
- File bar yang dipakai ulang dari fetch kemarin tidak berisi bar sejak fetch itu (≈1 hari terakhir W1).
  Untuk window yang berakhir hari ini itu memotong ekor window; `--end` ke tanggal fetch menghindarinya.
- `close_signatures` dan `pool_price_after_sweep` belum pernah ditulis oleh close sungguhan (belum
  deploy). "Harga landing" adalah harga dari API Meteora saat recorder jalan, bukan harga on-chain di
  slot sweep; bisa lag.
- Tidak ada row lama yang bisa direkonstruksi (signature close sebelumnya tidak pernah disimpan).
- Test suite dijalankan di Windows (970/970), bukan di server Linux.
