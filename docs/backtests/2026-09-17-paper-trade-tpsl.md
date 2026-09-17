# Paper trade counterfactual dengan TP/SL — 2026-09-17

**Tujuan:** kumpulin sampel yang jauh lebih cepat daripada menunggu live entry.
Live cuma entry saat gate 2,5x lolos; sejak 15 Sep nol entry. Paper trade ini
mensimulasikan **persis posisi yang live tolak**, supaya pertanyaan "kalau bar
gate kita pakai biaya terukur, hasilnya lebih bagus atau enggak?" bisa dijawab
dengan data, bukan asumsi.

**Zona nol risiko:** nol notional, nol order, nol perubahan config live. Semua
angka di dokumen ini dari simulasi bar historis, BUKAN hasil live.

## Alur

1. `gate_counterfactual.py` (cron 15 mnt) baca baris `[friction] rejected <pair>`
   dari log engine, hitung ulang pakai model biaya terukur, tulis ke
   `~/.hermes/data/gate_counterfactual.db` (`observations`).
2. `paper_trade_scorer.py` (cron 30 mnt) ambil event yang **lolos bar terukur**
   (dan ditolak live), bikin posisi paper: 1 posisi per pool per 24 jam.
3. Pool address di-resolve dari listing Meteora (`pair name -> address`, TVL
   terbesar kalau nama kembar).
4. Setelah 25 jam, posisi di-skor pakai bar hourly GeckoTerminal dengan aturan
   exit **sama seperti live**: TP +5% / SL -8% / max umur 24 jam.

Aturan simulasi:
- Harga entry = **close bar hourly terakhir yang sudah selesai** sebelum waktu event
  (jadi bisa sampai 1 jam basi).
- Jalan bar demi bar setelah entry. Kalau satu bar menyentuh TP **dan** SL, exit
  diasumsikan di **SL** (urutan intra-bar tidak diketahui → ambil yang lebih buruk).
- Exit di harga trigger persis (TP +5,00% / SL -8,00%), bukan harga market setelahnya.
- PnL bersih dihitung dua kali: model **LAMA** (gas 0,4444% + slippage 2,0% =
  2,4444%) dan model **TERUKUR** (gas 0,4444% + leg entry 0,41% + leg exit 0,91% =
  1,7644%). Beda per trade = 0,68 pts.

## Validasi: 7 trade live nyata dijalanin ulang lewat simulator ini

Ground truth = 7 posisi live yang sudah tutup (entry/exit nyata dari DB engine).
Simulator dijalankan dengan waktu & pool yang sama, lalu hasilnya dibandingkan.

```
pair          paper      actual       paper%  actual%   galat
MANLET-SOL    take-profit Take-profit    5.00%    5.29%  -0.29
EMBER-SOL     take-profit Take-profit    5.00%    5.26%  -0.26
EMBER-SOL     take-profit Take-profit    5.00%    5.52%  -0.52
EMBER-SOL     stop-loss   Take-profit   -8.00%    5.68% -13.68   <-- flip
EMBER-SOL     take-profit Take-profit    5.00%    5.31%  -0.31
EMBER-SOL     take-profit Stop-loss     5.00%   -8.41% +13.41   <-- flip
DOGE-1-SOL    take-profit Take-profit    5.00%    5.14%  -0.14

verdict cocok 5/7 · galat abs median 0,31 pts · maks 13,68 pts
```

Yang perlu dibaca dari tabel ini:

- **5 dari 7 trade: verdict sama** (TP di paper, TP di nyata). Galat median cuma
  **0,31 pts** — searah dan sistematis: simulator keluar persis di trigger
  (+5,00%), live keluar sedikit lewat trigger (+5,14%..+5,68%) karena exit di harga
  market. Artinya paper **sedikit meremehkan** kemenangan.
- **2 dari 7 trade: verdict kebalik** (satu harusnya TP tapi paper bilang SL, satu
  sebaliknya). Simulator pakai bar hourly, engine live polling harga tiap cycle —
  jadi ekstrem harga yang dilihat beda. Arah flip-nya berlawanan, jadi di sampel
  besar kira-kira saling meniadakan, tapi **per trade verdict paper punya risiko
  flip ~30% di sampel kecil ini**.
- Kesimpulan jujur: **paper ledger ini indikatif, bukan oracle.** Ambang batas
  pengambilan keputusan: **n >= 30 trade** sebelum menyimpulkan apa pun. Jangan pakai
  satu-dua trade paper sebagai bukti.

## State ledger

- 6 posisi paper `pending` (event seed dari backfill log, semuanya ditolak live tapi
  lolos bar terukur): OTC-SOL 3,44x · LEVERCAT-SOL 3,43x · EMBER-SOL 2,97x ·
  fone-SOL 2,59x · CATE-SOL 2,56x · ZCAT-SOL 2,53x. Notional per event diambil dari
  angka biaya engine sendiri (≈$180–188 ≈ 1,8 SOL).
- Skor pertama masuk mulai **2026-09-18 ± 21:13 WIB** (event 25 jam sebelumnya).
- 7 baris `validate_real` = tabel validasi di atas.

## Keterbatasan (semua diketahui, bukan temuan belakangan)

1. **`event_time` batch seed = waktu log di-backfill**, bukan waktu penolakan asli —
   baris log pm2 tidak punya timestamp. Event dari sweep ke depan sudah pakai waktu
   nyata.
2. **`pair -> pool address` heuristik** (TVL terbesar). 3 dari 5 pool di batch ini
   punya simbol kembar (fone-SOL, CATE-USDC, STONK-SOL) → mungkin bukan pool persis
   yang dipilih engine.
3. **`fone-USDC` tidak ada di listing Meteora** → ditandai `unscoreable`, tidak
   dipaksa ditebak.
4. GeckoTerminal rate-limit (engine live pakai kuota yang sama): hasil di-cache ke
   `~/.hermes/data/gt_cache/`, 3 pool per run, mundur 20–100 detik kalau kena 429.
5. Simulasi tidak memodelkan fee DLMM yang diterima per bar, MEV, atau gagal burn
   posisi — biaya cuma dari model koncesi terukur.
6. Notional tidak selalu 1,8 SOL: sebagian pool di-cap lebih kecil oleh engine
   (lihat `notional_usd` per baris).

## Perintah

```bash
python3 ~/.hermes/scripts/paper_trade_scorer.py            # bikin + skor (cron 30 mnt)
python3 ~/.hermes/scripts/paper_trade_scorer.py --summary  # ringkasan ledger
python3 ~/.hermes/scripts/paper_trade_scorer.py --validate # replay 7 trade live nyata
python3 ~/.hermes/scripts/gate_counterfactual.py --summary 24
```

DB: `~/.hermes/data/gate_counterfactual.db` (tabel `observations`, `paper_trades`).
Timestamp UTC; WIB = +7.

## Cross-check menyeluruh — 2026-09-17 20:50 WIB

Uji ulang rantai dari engine sampai paper trade, cari bug. Bukti mentah:
`docs/backtests/runs/paper_trade/audit_paper_chain.txt` dan `test_paper_e2e.txt`
(keduanya keluar 0 = konsisten / semua uji lolos).

### Bug yang ketemu & diperbaiki di pass ini (5, semuanya nyata)

| # | Bug | Dampak kalau tidak ketahuan | Fix |
|---|---|---|---|
| 1 | `simulate()` balikin **harga TP** waktu tidak ada bar setelah entry | SL/exit kosong ditulis sebagai **menang +5,00% palsu** | balikin `None` → status `unscoreable` |
| 2 | tidak ada batas percobaan saat data GT kosong | baris `pending` dihajar tiap run 30 menit selamanya (kuota GT dipakai engine) | kolom `attempts`, menyerah setelah 5x |
| 3 | `gate_counterfactual.py` nulis waktu **WIB**, query lain pakai **UTC** | skor molor 7 jam & jendela bar bisa kelewat | tulis UTC; 2.274 baris lama dinormalkan |
| 4 | `ratio_live` disimpan dari teks log yang dibulatkan ("2.50x" padahal 2,4978) | 1 baris kelihatan lolos gate live padahal engine menolaknya | hitung ulang dari `fee/cost`; DB di-backfill |
| 5 | tidak ada kunci proses | cron 30 menit bisa tumpang tindih saat GT balas 429 → panggilan API dobel | `flock` (`/tmp/paper_trade_scorer.lock`) |

### Yang diverifikasi (semua pakai output nyata)

- **Engine:** pm2 `online`, `/api/health` OK (RPC 71 ms, bukan dry-run), **0 posisi terbuka**,
  `.env` utuh (`LIVE_CAPITAL_SOL=2.85`, `LIVE_MAX_POSITION_SOL=1.8`,
  `MIN_FEE_COST_COVERAGE=2.5`, `FORCED_EXIT_SLIPPAGE_PCT=2.0`, `MAX_FEE_TVL_RATIO=0.25`).
  `dist/` (09-15) lebih tua dari `src/` (09-17) → **kode baru memang inert di live**.
- **Cadence:** tick 5 menit, cadence dasar 30 menit (`DLMM_BASE_CADENCE_MIN`) → jeda log
  22 menit itu normal, engine tidak menggantung (dibuktikan dari `CRON.DLMM_TICK` + `screenerCadence.ts`).
- **Gate live tidak berubah:** cycle terakhir `cost-rejected 3`, `opened no (2.5x ...)` — semua
  kandidat ditolak di gate biaya, persis seperti desain formula lama.
- **Aritmetika counterfactual:** 2.274 baris dihitung ulang dari angka mentah →
  0 ketidakcocokan pada `ratio_live`, `ratio_measured`, `pass_live`, `pass_measured`, `cost_ratio`.
  Ambang dipangku benar: `2,4444% x 2,5 = 6,111%` (live) dan `1,7644% x 2,5 = 4,411%` (bar terukur).
- **Alamat pool:** 6/6 cocok nama di sumber independen (GeckoTerminal). Semua kandidat
  ber-nama sama ternyata **mint token yang sama** (harga antar-pool cuma beda ~0,3–4%),
  jadi risiko salah pool turun jadi "pool lain, token sama" — bukan token lain.
- **Uji end-to-end di salinan DB** (`/tmp/paper_test.db`): baris siap-skor → `scored` dengan
  matematika benar (gross −8,00% → net LAMA −10,444% / TERUKUR −9,764%), pool palsu →
  gagal rapi (`attempts=1`, tidak crash), baris <25 jam → dilewati, run kedua → **idempoten**,
  dan uji dua proses bareng → yang kedua keluar sendiri (`flock`).
- **Akurasi simulator vs 7 trade live:** 5/7 verdict cocok, galat abs median 0,31 pt,
  2 verdict kebalik (arahnya berlawanan) → ledger indikatif, butuh n ≥ 30.

### Yang tetap jadi keterbatasan (bukan bug, tapi jangan dilupakan)

- **Alarm drift engine masih hidup:** `/api/reconciliation` → model $43,12 vs chain $22,74
  (−$20,38; −47,3% dari model), plus alert wallet-vs-book 0,4168 SOL. Sudah lama diketahui
  (koncesi entry tak dimodelkan + burn gagal), tidak ada auto-koreksi, halaman alert ditahan.
- Per-trade verdict bisa kebalik (2/7) karena bar hourly vs polling live.
- Harga entry = close bar hourly terakhir (basi sampai 1 jam), exit diasumsikan pas di trigger.
- Batch seed: `event_time` = waktu backfill (log pm2 tidak punya timestamp per baris).
- Resolusi pool = TVL terbesar di antara nama yang sama (token sama, pool bisa beda).
- Notional tidak selalu 1,8 SOL (sebagian pool di-cap lebih kecil).

