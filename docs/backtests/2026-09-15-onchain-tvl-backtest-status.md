# Backtest dengan TVL on-chain — status (15 Sep 2026)

Branch: `work/tvl-model-validation-and-measurement-loop`. **Belum ada angka hasil backtest.** Kodenya selesai dan
teruji; ingest data dihentikan di tengah jalan dengan sengaja (alasan di bawah).

## Yang sudah jadi

| Commit | Isi |
|---|---|
| `701ee0b` | `--tvl=onchain`: engine & pemilihan universe per window memakai TVL on-chain, bukan `k × volume` |
| `57d6bc4` | titik waktu sebelum pool lahir tidak memanggil RPC |
| `1c886de` | dataset window hanya membawa grid sampel window-nya sendiri |
| (commit ini) | limiter kecepatan global `--tvl-rps` (default 3/detik) |

Cara kerja (detail di `src/backtest/onchainTvl.ts`):

- TVL(T) = reserve_x(T) × harga base USD + reserve_y(T) × (SOL/USD atau 1).
- reserve(T) = post-balance transaksi terakhir yang menyentuh reserve itu sebelum/tepat T (Helius
  `getTransactionsForAddress`, 10 kredit/panggilan). Harga = bar GeckoTerminal yang sudah **tutup** sebelum T.
- Pool yang sisi Y-nya bukan wSOL/stable, atau harga base-nya tidak cocok dengan token_x Meteora (>2,5×),
  **ditolak**, tidak ditebak.
- Engine: sampel terakhir ≤ bar, lebih basi dari 1,5× cadence = `tvlUnknown` = entry ditolak. **Tidak ada
  fallback ke model k.** Tanpa `--tvl=onchain`, jalur model byte-identik (seri yang sama dengan model
  menghasilkan summary identik; ada test).
- Cache per pool di `.cache/tvl_series/`, bisa resume; gagal jaringan tidak di-cache.

Test: `onchainTvl.test.ts` 17/17, `windowUniverse` + `backtestIntegrity` + `tvlValidation` hijau, typecheck hijau.

## Kenapa ingest dihentikan

Run pertama (W1, grid 24 jam, concurrency 8 = 16 panggilan paralel) jalan ~15 detik/pool di awal, lalu
melambat ke ~2 menit/pool. Probe langsung: **6 dari 8 panggilan dijawab HTTP 429**. Menjalankan W2/W3 paralel
memperparah (dihentikan lebih dulu).

Risiko yang lebih penting dari lambatnya: ingest memakai `SOLANA_RPC_URL` dari `.env` lokal. **Kalau key Helius
itu sama dengan yang dipakai engine live di server, ingest yang menghabiskan rate limit bisa membuat engine
live gagal membaca chain saat monitor / stop-loss / close.** Semua proses ingest dihentikan; limiter global
ditambahkan sebelum run berikutnya.

## Progres yang sudah ter-cache

| | |
|---|---|
| Pool W1 selesai | 33 dari 89 kandidat eligible |
| Sampel TVL valid | 2.077 |
| Sampel null (sebelum pool lahir / tanpa tx) | 1.412 |
| Pool ditolak (pair tanpa sisi wSOL/stable) | 1 (SOL-HYPE) |
| W2 / W3 | beberapa pool terisi dari run paralel yang dihentikan |

Semua ini dipakai ulang otomatis oleh run berikutnya.

## Sisa pekerjaan & estimasi

Sisa ≈ 230 pool × rata-rata ~150 sampel × 2 panggilan ≈ **~70 ribu panggilan (~700 ribu kredit Helius)**
untuk 3 window pada grid 24 jam.

| Kecepatan | Waktu |
|---|---|
| 3 panggilan/detik (default aman) | ~6,5 jam |
| 10 panggilan/detik | ~2 jam (hanya kalau key terpisah dari engine live) |

Perintah (resume dari cache):

```bash
LIVE_CAPITAL_SOL=2.85 LIVE_MAX_POSITION_SOL=1.8 npm run backtest:integrity -- --per-window-universe \
  --windows=3 --days=91 --end=2026-09-13 --candidates=96 \
  --tvl=onchain --tvl-cadence-hours=24 --tvl-rps=3
```

Di server, `LIVE_CAPITAL_SOL` / `LIVE_MAX_POSITION_SOL` sudah ada di `.env`, jadi prefix env tidak perlu.
**Sebaiknya pakai key Helius terpisah** (`SOLANA_RPC_URL=... npm run ...` hanya untuk proses ini) supaya
ingest tidak berbagi rate limit dengan engine live.

## Yang tidak bisa diklaim

- Tidak ada hasil backtest on-chain; pertanyaan TP/gate masih belum terjawab.
- Belum diketahui apakah key lokal = key engine live, dan apakah 429 tadi sempat memengaruhi engine live.
  Cek log engine sekitar 14 Sep 17:00–17:40 UTC untuk error RPC 429.
- Rate limit Helius untuk `getTransactionsForAddress` di paket ini tidak didokumentasikan di sini; 3/detik
  adalah pilihan konservatif, bukan batas terukur.
