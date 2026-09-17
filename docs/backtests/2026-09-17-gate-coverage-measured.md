# Koncesi eksekusi TERUKUR + gate dengan biaya terukur (lanjutan sweet-spot sweep)

Tanggal: 2026-09-17 · Branch `main` · **nol perubahan ke engine live** (config, formula, wallet, posisi)

Lanjutan dari `2026-09-17-gate-sweet-spot-sweep.md`. Dua pekerjaan:

1. **Nambah sampel koncesi eksekusi** — jangan cuma 5 baris `exit_economics`, ukur sendiri dari chain.
2. **Backtest ulang gate pakai biaya TERUKUR** (ganti asumsi 2%) — lihat efeknya ke hasil.

## 1. Pengukuran on-chain (read-only)

`~/.hermes/scripts/diag/measure_swap_concession.py` — `getTransaction` saja, tidak menandatangani,
tidak mengirim, tidak menulis DB. Sumber signature: `live_execution_attempts.swap_signature` (leg
entry) dan `simulated_positions.sweep_signature` (leg exit yang benar-benar terjual). Harga ideal =
harga pool yang dicatat engine saat keputusan (`entry_price` / `pool_price_at_exit`).

```
leg ENTRY (SOL -> token, n=7 dari 8 attempt yang membuka posisi)   koncesi = (hargaDapat - hargaIdeal)/hargaIdeal
  attempt#1 MANLET-SOL   0,9019 SOL -> 76.370,29 token   2,42%
  attempt#3 EMBER-SOL    0,9015 SOL ->  5.330,44 token   2,52%
  attempt#4 EMBER-SOL    0,9015 SOL ->  4.446,09 token   0,83%
  attempt#6 EMBER-SOL    0,9015 SOL ->  2.609,05 token   0,67%
  attempt#7 EMBER-SOL    0,9015 SOL ->  2.402,84 token   0,47%
  attempt#8 EMBER-SOL    0,9145 SOL ->  2.283,96 token  -0,43%   (dapat harga LEBIH BAIK dari harga catatan)
  attempt#9 DOGE-1-SOL   0,9015 SOL -> 478.142,73 token  1,40%
  median 0,83% dari nilai swap  (mean 1,13%)  ->  median 0,42% dari NOTIONAL 1,8 SOL  (mean 0,56%)

leg EXIT (token -> SOL, n=5)   koncesi = (hargaIdeal - hargaDapat)/hargaIdeal
  EMBER 3f4a51cd  in 4.498,67 token -> 0,78700 SOL   vs ideal 0,81935  = 3,95%  = 179,7 bps notional
  EMBER 24eb5c2e  in 4.155,69 token -> 0,88821 SOL   vs ideal 0,90454  = 1,81%  =  90,7 bps
  EMBER 4a3f6381  in 2.137,99 token -> 0,78715 SOL   vs ideal 0,79432  = 0,90%  =  39,9 bps
  EMBER 3a85fa8f  in 3.070,65 token -> 0,99755 SOL   vs ideal 1,01303  = 1,53%  =  86,0 bps
  NEARKAT attempt#5 (unwind gagal-open, dari DB)                         1,43%  = 143,1 bps
  median 0,91% dari NOTIONAL  (mean 1,08%, terburuk 1,80%)
```

**Dua ukuran yang beda dan jangan dicampur** (ini yang bikin angka 0,90% vs 1,5% kelihatan
bertentangan): leg exit itu menjual ~0,8–1,0 SOL token, bukan 1,8 SOL. Jadi koncesi 3,95% *dari
nilai swap* cuma 1,80% *dari notional*. Model gate membandingkan biaya dengan **notional**, jadi
angka yang benar untuk dibandingkan dengan `FORCED_EXIT_SLIPPAGE_PCT` adalah **% notional**
(median 0,91%). Sampel exit tidak bisa ditambah tanpa close baru: dari 7 close, 5 terukur,
2 tidak (MANLET dijual tangan oleh operator — tidak tercatat; 1 EMBER residunya debu, tidak ada sweep).

**Yang baru dan penting: leg ENTRY tidak ada di model sama sekali.** Kedua model (live gate dan
backtest) cuma menghitung `gas round-trip + slipped 2%` di sisi exit. Kenyataannya masuk juga kena
koncesi (median 0,42% notional). Total friksi terukur per trade:

```
gas round-trip    0,44% notional   (2 x 0,004 SOL / 1,8 SOL)
koncesi entry     0,42% notional   (median terukur)          <- TIDAK ADA di model
koncesi exit      0,91% notional   (median terukur)
TOTAL terukur     1,77% notional   (mean 2,08%)
MODEL sekarang    2,44% notional   (gas 0,44% + slipped 2% exit, tanpa leg entry)
```

Implikasi bar gate (bar = 2,5 x biaya per notional):

```
asumsi saat ini 6,11% fee/TVL  ->  2,5 x (0,44% + 2,00%)
median terukur  4,43% fee/TVL  ->  2,5 x (0,44% + 0,42% + 0,91%)
mean terukur    5,20% fee/TVL
terburuk        8,75% fee/TVL  ->  2,5 x (0,44% + 1,26% + 1,80%)
```

**Koreksi klaim sebelumnya:** dengan leg entry ikut dihitung, bar turun dari 6,11% cuma ke ~4,43%,
dan kandidat terbaik hari ini (fone-SOL 3,91%, ZCAT-SOL 3,91%, EMBER-SOL 3,13%) **masih tidak lolos**.
Klaim "fone 3,91% bakal lolos" di pesan sebelumnya salah — itu mengabaikan leg entry.

## 2. Backtest dengan koncesi terukur

`scripts/agent_gate_sweep_measured.sh` (6 run, dataset sama, akun live, gas 0,004, nol fetch).
Kolom "net-koreksi" = hasil JSON dipotong koncesi entry terukur 0,42% x notional x jumlah trade
(biaya yang model backtest memang tidak hitung).

```
skenario         hari  notion$  trade   net $   net- koreksi   PF  maxDD% | elig  elig net$  elig-koreksi
91d_slip0.86      91      124      32  +291,73     +275,13   3,55    9,6  |  20   +155,86     +145,48
91d_slip1.08      91      124      32  +284,12     +267,52   3,46    9,9  |  20   +152,41     +142,03
91d_slip1.8       91      124      32  +259,91     +243,31   3,19   10,7  |  20   +141,31     +130,93
91d_slip2.0 ★     91      124      31  +247,17     +231,09   3,07   10,9  |  20   +138,27     +127,89
120d_slip0.86    120      161      27  +173,33     +155,11  11,58    3,3  |  74   +239,92     +189,97
120d_slip1.08    120      161      22  +119,66     +104,81  30,22    1,2  |  37    +18,75       -6,22
120d_slip1.8     120      161      42   -23,67      -52,01   0,91   33,3  |  37    -16,45      -41,42
120d_slip2.0 ★   120      161      32   -96,32     -117,92   0,60   37,9  |  29    -95,27     -114,84
★ = asumsi live sekarang
```

Bacaannya:

- **Dataset fee tebal (91d):** geser asumsi 2% -> 0,86% cuma nambah ~$18 di arm live-eligible
  (+138,27 -> +155,86; setelah koreksi entry +127,89 -> +145,48). Bar turun tapi 20 trade-nya sama.
  Jadi di sini asumsi slippage **bukan** penentu.
- **Dataset fee tipis (120d):** geser yang sama mengubah tanda: −$95,27 -> +$239,92 (74 trade),
  dan tetap positif setelah koreksi entry (+189,97). Tapi ini **knife-edge**: di 1,08% tinggal
  +$18,75 (setelah koreksi −$6,22), di 1,80% sudah −$16,45. Median terukur 0,91% duduk tepat di
  zona transisi itu.
- Pola lama bertahan: 91d dan 120d tetap **tidak sepakat** soal konfigurasi terbaik. Yang berubah
  cuma: di 120d, bar yang lebih rendah (3,26%) akhirnya mengizinkan trade yang sebelumnya diblok.

## 3. Kaitan ke gap rekonsiliasi 0,2001 SOL

Koncesi entry yang tidak dimodelkan = 7 trade x 1,8 SOL x (0,42%..0,56%) = **0,053–0,071 SOL**,
yaitu **26–35%** dari gap 0,2001 SOL. Sisanya belum dijelaskan (kandidat: konversi harga saat
deposit/withdraw DLMM, rent ATA yang tidak diklaim, dan penjualan tangan MANLET oleh operator yang
tidak tercatat di buku). Belum diukur, jangan diklaim.

## 4. Kesimpulan & rekomendasi

1. Angka 2,5 **tetap bukan masalah utama**, tapi modelnya kurang satu leg: entry. Kalau biaya diukur
   (bukan diasumsikan), total friksi 1,77% notional (median) -> bar 4,43% fee/TVL.
2. Dengan bar 4,43%, **pasar hari ini masih tidak lolos** (kandidat 2,74–3,91%). Jadi mengubah
   asumsi biaya saja tidak otomatis menghidupkan entry — perlu fee/TVL pasar yang lebih tinggi.
3. Sampel masih kecil: 7 entry, 5 exit, 1 wallet, dan koncesi exit terukur masih mencampur
   slippage + gerak harga antara keputusan dan landing (`note` di `exit_economics`). **Belum cukup
   untuk mengubah live.** Tidak ada perubahan yang diterapkan.
4. Kandidat pekerjaan berikut (analisis dulu, bukan ubah formula): (a) catat koncesi **entry** secara
   sistematis seperti exit (kolom baru), supaya sampel nambah tiap entry tanpa perlu close;
   (b) ukur ulang setelah 10–15 sampel baru sebelum menyentuh konstanta apa pun.
5. Biaya yang harus dibayar buat dapat sampel: entry baru hanya datang kalau gate lolos — jadi
   sampel nambah pelan. Itu alasan tambahan untuk tidak buru-buru mengubah konstanta.

## Reproduksi

```bash
python3 ~/.hermes/scripts/diag/measure_swap_concession.py          # pengukuran on-chain (read-only)
bash scripts/agent_gate_sweep_measured.sh                          # 6 run backtest koncesi terukur
python3 scripts/agent_diag/compile_gate_sweep.py                   # tabel 31 skenario (TABLE.txt/SUMMARY.json)
```

Artefak: `docs/backtests/runs/gate_sweep/{TABLE.txt,SUMMARY.json,<tag>.json.gz,<tag>.log.gz}`,
`~/.hermes/scripts/diag/out/swap_concession.json`.

## Tindak lanjut: `entry_economics` — koncesi leg ENTRY dicatat sistematis (17 Sep 2026)

Sampel exit tidak bisa nambah tanpa close baru, tapi sampel ENTRY bisa: tiap entry live sudah
menyimpan signature swap-nya. Maka jalur pengukurannya dipindah dari skrip sekali-pakai ke
mesin, simetris dengan `exit_economics`.

Yang ditambahkan (semua di luar jalur trade — nol perubahan ke engine live):

| Berkas | Isi |
|---|---|
| `src/database/db.ts` | tabel `entry_economics` (DDL, + `migrate` aman kalau DB lama) |
| `src/services/entryEconomics.ts` | derivasi: `lamportsSpentByPayer`, `tokenReceivedByOwner`, `tokensAtPoolPrice`, `measureEntryEconomics` |
| `src/services/entryEconomicsBackfill.ts` | `runEntryEconomicsBackfill` (idempoten, `insert-if-absent`, `--dry-run`) |
| `src/scripts/backfillEntryCosts.ts` | CLI `npm run entrycosts:backfill [-- --dry-run]` |
| `src/database/repositories.ts` | `insertEntryEconomicsIfAbsent`, `listEntryEconomics` |
| `src/tests/entryEconomics.test.ts` | 16 tes (matematika + aturan "tak terukur = NULL, bukan 0") |
| `~/.hermes/scripts/entrycosts_sweep.sh` + cron `*/15` | sapuan tiap 15 menit, DIAM kalau tidak ada entry baru |

Aturan yang dipegang sama seperti sisi exit: angka yang tidak terukur ditulis NULL + alasan,
bukan 0. Harga "landing" (setelah swap mendarat) cuma dipakai kalau sapuan jalan dalam 20 menit
setelah entry — kalau lebih lambat, ditolak dan alasannya ditulis; `bin_step` tetap diambil
karena tidak menua.

**Hasil terukur di DB live (10 baris, 17 Sep 2026):**

```
entry (posisi)   n=7   koncesi median  82,4 bps (0,82%)  mean 110,4 bps  range −43,4..+245,9
                       biaya/notional median 41,3 bps (0,41%)
failed open      n=3   biaya/notional 82,3 · 665,2 · 877,2 bps (leg tidak dipisah)
```

Angka ini mengonfirmasi dua hal: (a) koncesi leg entry nyata dan skalanya sama dengan leg exit
(bukan nol seperti di model), (b) model gate memang belum punya leg ini sama sekali. Median
koncesi versi tool kanonik (82,4 bps) cocok dengan pengukuran skrip Python sekali-pakai
(83,1 bps) — beda ~1 bps karena sumber desimal yang dipakai.

**Perbaikan bug yang ketemu karena pengukuran ini:** `solIsQuoteFromPairName` dulu belah nama
pair sekali (`split("-")` → `[base, quote]`), jadi `DOGE-1-SOL` terbaca `quote = "1"` dan
koncesinya ditulis "tidak bisa ditentukan sisi SOL-nya". Sekarang quote = segmen TERAKHIR.
Dampak: cuma kolom pengukuran (bukan jalur trade), dan cuma menambah angka yang tadinya NULL.

**Batasan yang masih berdiri:** 1 wallet, 10 entry (mayoritas satu pool EMBER-SOL), dan koncesi
masih campuran slippage + gerak harga antara keputusan dan mendarat. Ini masih terlalu tipis
untuk mengubah konstanta gate; sampelnya sekarang bertambah otomatis tiap entry, tanpa nunggu
close.

Berkas dist/engine TIDAK dibangun ulang: engine live tetap menjalankan dist yang lama dan tidak
tahu-menahu soal tabel baru — nol risiko ke jalur trade.

## Counterfactual gate: sampel tiap CYCLE, bukan tiap trade (17 Sep 2026)

Masalahnya: kalau sampel cuma dari trade yang jalan, kita butuh berminggu-minggu. Tapi engine
sudah mencatat SETIAP kandidat yang ditolak gate, lengkap dengan angka miliknya sendiri
(`[friction] rejected <pair>: 24h fee $X covers round-trip cost $Y only Rx (need 2.5x)` di log
error). Dari situ kita bisa hitung: pool mana yang BAKAL lolos kalau bar-nya pakai biaya terukur.

Model: `cost_terukur / cost_lama = (0,4444% + 1,32%) / (0,4444% + 2,00%) = 0,72183`
(gas 0,008 SOL & notional 1,8 SOL → rasionya tetap walau harga SOL berubah). Jadi fee yang
dibutuhkan = `2,5 x cost_lama x 0,72183 = 1,80458 x cost_lama`.

`scripts/agent_diag/gate_counterfactual.py` (cron 15 menit, read-only, nol notional) mencatat
tiap penolakan ke `~/.hermes/data/gate_counterfactual.db` dan **diam** kalau tidak ada yang baru.

**Backfill seluruh log (2272 penolakan, 16 pool):**

```
observasi 2272 · pool unik 16 · lolos model LAMA 0 · lolos model TERUKUR 587 (11 pool)

pool             observasi  lolos terukur  rasio terbaik
fone-SOL               377            162         3,46x
MANLET-SOL             276             98         2,87x
EMBER-SOL              114             81         3,43x
fone-USDC              119             75         3,45x
STONK-SOL               86             61         3,32x
Pistacio-SOL           102             55         3,38x
LEVERCAT-SOL            46             26         3,43x
ZCAT-SOL                54             23         2,97x
CATE-SOL               642              3         3,10x
```

**Cara baca yang jujur — ini BUKAN bukti profitabilitas:**

1. `lolos terukur` = throughput gate, bukan hasil trade. 587 dari 2272 itu **event**, bukan 587
   peluang independen: pool yang sama muncul ratusan kali dalam ratusan cycle.
2. Log pm2 tidak punya timestamp per baris, jadi baris backfill semuanya bertanggal waktu
   backfill — deret waktu baru bisa dibangun dari sweep ke depan, bukan dari data lama.
3. Kolom `pass_live = 0` itu by construction (baris ini memang hasil penolakan), jadi bukan temuan;
   yang berguna cuma kolom `pass_measured`.
4. Rasio terbaik mayoritas 2,9–3,5x — artinya di model terukur mereka cuma lewat tipis di atas
   2,5x, bukan lewat jauh.
5. Untuk bisa dipakai memutuskan, tiap event harus diSkor hasilnya (TP +5% / SL −8% / max age 24h)
   pakai harga setelahnya — belum dikerjakan; butuh resolusi pair → pool address + OHLCV.

Jalan pintas kalau nanti mau skor: `python3 ~/.hermes/scripts/gate_counterfactual.py --summary [jam]`.

