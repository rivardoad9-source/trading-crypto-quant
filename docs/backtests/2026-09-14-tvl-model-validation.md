# Validasi model k/TVL + menutup loop wait-and-see (14 Sep 2026)

Branch: `work/tvl-model-validation-and-measurement-loop` (dari `main` @ `268eb6f`).
Tidak ada deploy, restart, perubahan `.env`, atau transaksi. Semua pembacaan chain read-only.

| # | Pekerjaan | Commit |
|---|---|---|
| 1 | Validasi model k/TVL vs TVL on-chain (`npm run validate:tvl`) | `95c896e` |
| 2 | `report:live`: seksi LLM vs rule + konsentrasi harian | `8b52372` |
| 3 | Rehearsal jalur tulis `exit_economics` (`npm run rehearse:exit-economics`) | `533858a` |
| — | **Bug ditemukan & diperbaiki:** test konsentrasi menulis baris palsu ke DB asli | `e898c63` |

`npm run typecheck` hijau. `npm test` (Windows) **1016/1016**; hash
`data/flowmetrix.db` identik sebelum/sesudah suite.

---

## 1. Model k/TVL — hasil

### Cara ukur TVL "nyata" di masa lalu

Tidak ada API yang menyimpan TVL historis per pool DLMM (GeckoTerminal hanya `reserve_in_usd` saat ini,
DefiLlama tidak meng-cover Meteora DLMM, datapi Meteora hanya punya OHLCV + volume historis). Tapi TVL pool
DLMM = dua reserve token account × harga, dan saldo reserve pada waktu T = post-balance transaksi terakhir
yang menyentuh reserve itu sebelum T. Helius `getTransactionsForAddress` mendukung filter `blockTime <= T`,
jadi satu panggilan per reserve per titik waktu.

- TVL nyata(T) = reserve_x(T) × rasio pool(T) + reserve_y(T), dikonversi lewat sisi SOL (SOL/USD bar) atau stable.
- TVL modelled(T) = k × volume 24 jam trailing dari bar GeckoTerminal yang dipakai engine backtest.

**Validasi metode sebelum dipakai:**

| Cek | Hasil |
|---|---|
| TVL rekonstruksi SEKARANG vs field `tvl` API Meteora (8 pool) | median rasio **1,001**, min 1,000, max 1,098 |
| Volume 24h GeckoTerminal vs volume datapi Meteora (12 obs/window) | median rasio **0,99 / 1,01 / 1,01** (W1/W2/W3) |

Jadi baik sisi "nyata" maupun sisi volume model bukan artefak.

### Sampel

40 kandidat pertama (urut alamat) dari daftar 96 kandidat tiap window **termasuk yang ditolak band TVL**
(supaya model tidak divalidasi pada output-nya sendiri), yang punya ≥48 bar di window, × 3 titik waktu.

| Window | Periode | Pool | Observasi | Dikecualikan |
|---|---|---|---|---|
| W1 | 2026-06-14 → 2026-09-13 | 40 | 120 | 13 kandidat <48 bar |
| W2 | 2026-03-15 → 2026-06-14 | 33 | 99 | 21 obs pair tanpa sisi SOL/stable, 5 kandidat <48 bar |
| W3 | 2025-12-14 → 2026-03-15 | 33 | 95 | 25 obs pair tanpa sisi SOL/stable, 14 kandidat <48 bar |
| Total | | 74 unik | 314 | |

### k yang diimplikasikan chain (TVL nyata / volume 24h)

| Window | p25 | median | p75 |
|---|---|---|---|
| W1 | 0,085 | **0,210** | 0,717 |
| W2 | 0,472 | **1,563** | 4,601 |
| W3 | 1,071 | **2,373** | 11,134 |
| Semua | 0,260 | 1,048 | 3,259 |

k = 0,195 yang dipakai WO2/WO3 cocok dengan median **W1 saja**. Di W2/W3 median k nyata 8–12× lebih besar.

### Error model per varian k (semua window, 314 obs)

`log2(model/nyata)`: 0 = tepat, −1 = model separuh nyata, +1 = model 2× nyata.

| k | log2 p10 / med / p90 | dalam 2× | band salah (terima / tolak) | Spearman TVL | Spearman fee/TVL | top-10 fee/TVL sama | gate fee/TVL setuju |
|---|---|---|---|---|---|---|---|
| 0,131 | −6,47 / −3,00 / +0,62 | 18% | 15 / **157** | 0,53 | 0,52 | 10% | 179/314 |
| 0,195 | −5,90 / −2,43 / +1,19 | 19% | 21 / **141** | 0,53 | 0,52 | 0% | 180/314 |
| 0,491 | −4,57 / −1,09 / +2,53 | 24% | 20 / **124** | 0,53 | 0,52 | 0% | 238/314 |
| per-pool k hari ini (284 obs) | −2,61 / +0,48 / +3,51 | 35% | 19 / 106 | 0,65 | 0,66 | 30% | 231/284 |

Per window (k = 0,195):

| Window | log2 median | dalam 2× | band in-in / out-out / salah-terima / salah-tolak | Spearman TVL / fee-TVL | gate fee/TVL lolos model / nyata |
|---|---|---|---|---|---|
| W1 | −0,11 | 31% | 40 / 42 / 15 / 23 | 0,62 / 0,34 | 87 / 79 |
| W2 | −3,00 | 15% | 17 / 25 / 5 / **52** | 0,71 / 0,54 | **57 / 10** |
| W3 | −3,61 | 7% | 9 / 19 / 1 / **66** | 0,63 / 0,50 | **59 / 6** |

### Waktu vs komposisi

| Window | k nyata, pool quote SOL/lain | k nyata, pool quote USD |
|---|---|---|
| W1 | 0,281 (n 90) | 0,077 (n 30) |
| W2 | 1,000 (n 39) | 2,852 (n 60) |
| W3 | 1,545 (n 35) | 3,545 (n 60) |

| Pool yang SAMA di dua window | pool | median log2(k lama / k baru) |
|---|---|---|
| W1 → W2 | 9 | −0,35 |
| W2 → W3 | 23 | −0,44 |
| W1 → W3 | 5 | −0,89 |

Pool yang sama **tidak** menunjukkan k lebih besar di masa lalu (malah sedikit lebih kecil). Yang berubah
antar window adalah isinya: sampel W2/W3 didominasi pool quote USD dan pool yang berputar lambat (TVL besar
relatif volume). k per pool membentang dari <0,1 sampai >2000.

### Kesimpulan jujur

1. **k global bukan konstanta pasar, tapi statistik komposisi sampel.** Itu sebabnya k pindah 0,195 → 0,491
   hanya karena daftar kandidat berubah. Tidak ada satu k yang benar untuk semua pool; memilih k = memilih
   universe.
2. **Model TVL tidak cukup akurat untuk dipakai sebagai gate.** Di k terbaik mana pun, hanya 18–24% observasi
   dalam 2× TVL nyata. Per-pool k hari ini sedikit lebih baik (35%) dan tidak tersedia untuk pool mati.
3. **Rem "band TVL" di WO3 sebagian besar artefak model.** Di W2/W3 dengan k = 0,195, 52 dan 66 observasi
   ditolak model padahal TVL nyatanya di dalam band. Universe window lama tipis karena model, bukan karena pasar.
4. **Gate fee/TVL dengan k global = gate fee-rate.** Di W2/W3 model meloloskan 57–59 observasi, chain hanya
   10 dan 6. Model mengira window lama jauh lebih menguntungkan daripada kenyataannya.
5. **Urutan pool berubah.** Urutan TVL masih searah (Spearman 0,53–0,71, sebagian besar karena volume),
   tapi urutan fee/TVL lemah (0,33–0,56) dan top-10 fee/TVL hampir tidak sama (0–50%).
6. Konsekuensinya: **semua hasil backtest yang memakai modelled TVL (jumlah trade, net, varian TP/gate,
   termasuk "0 trade di k = 0,491") tidak bisa dipakai sebagai bukti ke arah mana pun.** Status yang benar
   tetap "belum bisa diverifikasi".

### Usulan (belum dikerjakan)

Ganti modelled TVL di backtest dengan **TVL on-chain yang direkonstruksi** per pool per hari (atau per 4–6 jam)
memakai metode yang sama, di-cache per pool. Estimasi kasar: 96 kandidat × 91 hari × 2 reserve ≈ 17 ribu
panggilan per window untuk sampel harian. Biaya kredit Helius untuk `getTransactionsForAddress` belum dicek.
Pair tanpa sisi SOL/stable perlu sumber harga tambahan (sekarang dikecualikan).

### Yang tidak bisa diklaim

- 3 titik waktu per pool berkorelasi; sampel efektif lebih dekat ke jumlah pool (40/33/33) daripada 314.
- Sampel = 40 kandidat pertama urut alamat, bukan acak berstrata; tidak mewakili universe live.
- TVL on-chain mencakup seluruh likuiditas di reserve (termasuk bin jauh dari harga aktif), sama dengan
  definisi `tvl` Meteora yang dipakai screener live; itu bukan "likuiditas yang bisa dipakai trade".
- Rasio harga dari bar 1h Meteora (close jam sebelum T), bukan harga di slot tepat T.
- Satu self-check pool (baton-SOL) selisih 6–10% dari API, kemungkinan API lag; tidak diinvestigasi.

---

## 2. `report:live` — LLM vs rule + konsentrasi harian (`8b52372`)

- **Seksi 8, LLM vs rule** dari `scan_funnel_cycles`: keputusan, LLM menolak, SAMA, BEDA, % kesepakatan,
  median shortlist, 10 siklus BEDA terakhir, dan hasil trade untuk pilihan LLM yang benar-benar dieksekusi
  (join: pool sama, ≤2 jam sesudah siklus; lebih dari satu kecocokan ditandai AMBIGU).
- Hasil kontrafaktual pilihan rule dinyatakan eksplisit **tidak terukur dari DB**.
- Di bawah 20 keputusan: "sampel belum cukup untuk menilai LLM"; tidak pernah ada vonis.
- **Seksi 9, konsentrasi harian (UTC)**: open live, token berbeda, token teratas, total `concentration_flagged`
  dan `exec_token_concentration_rejected` per hari; mode report/enforce disebut tidak tercatat di DB.
- Test `liveReport.test.ts` 16/16.

## 3. Rehearsal `exit_economics` (`533858a`)

`npm run rehearse:exit-economics`: DB scratch di temp dir (menolak path lain sebelum modul `src/` dimuat),
recorder asli + dependensi asli (Helius, Meteora), signature asli dari `exports/trades.csv`. Hanya membaca chain.

| Kasus | Hasil |
|---|---|
| migrasi dari tabel lama berisi row | PASS — 4 kolom baru, row lama utuh |
| close 1 tx: fee = close+sweep+ata (13000×3) | PASS — 39000 |
| close multi-tx (**konstruksi**: open tx + close tx posisi #6) | PASS — 113398 = 74000+13398+13000+13000; final tidak dihitung dua kali |
| signature sampah → fee NULL (dicek via SQL `IS NULL`) | PASS |
| pool gagal dibaca → 5 kolom NULL, bukan 0 | PASS |
| `residual_sweep=operator` → 6 kolom sweep NULL | PASS |
| insert-if-absent | PASS |
| insert throw → recorder return null | PASS |

Tidak ada bug. Catatan: di rehearsal harga "landing" dibaca berhari-hari setelah sweep (konsesi 2574,9 bps
vs 394,9 bps @keputusan) — itu menunjukkan betapa sensitifnya angka landing terhadap waktu baca; di close
nyata pembacaan terjadi detik setelah sweep. Kasus multi-tx membuktikan aritmetika, bukan close multi-tx nyata.

## Bug: test menulis ke DB asli (`e898c63`)

`tokenConcentration.test.ts` (dari sesi wait-and-see) meng-set `DATABASE_PATH` setelah `env.ts` sudah
ter-load, sehingga setiap `npm test` menambah 1 baris funnel palsu (`llm_pick_pool='P1'`,
`rule_pick_pool='P2'`, `shortlist_size=4`, `concentration_flagged=1`, `duration_ms=1`) ke DB yang dipakai.
**Kalau `npm test` pernah dijalankan di server setelah `6654680` masuk, DB live berisi baris palsu itu**,
tepat di kolom yang dibaca seksi LLM vs rule. Cek dan bersihkan:

```sql
SELECT id, cycle_at FROM scan_funnel_cycles WHERE llm_pick_pool = 'P1' AND rule_pick_pool = 'P2' AND duration_ms = 1;
DELETE FROM scan_funnel_cycles WHERE llm_pick_pool = 'P1' AND rule_pick_pool = 'P2' AND duration_ms = 1;
```

Diperbaiki: path di-set sebelum import apa pun yang bisa memuat `env.ts`, dan test menolak menulis kalau
path tidak di temp dir. Diverifikasi dengan hash `data/flowmetrix.db` yang sama sebelum/sesudah full suite.
3 baris palsu di DB lokal gw sudah dihapus.
