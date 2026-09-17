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
