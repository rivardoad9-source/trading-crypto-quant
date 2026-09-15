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

### Resep: ingest pakai key RPC terpisah (`--tvl-rpc-url`, WO #4)

Engine pm2 tidak membawa `SOLANA_RPC_URL` sendiri — dia membaca `.env` yang sama. Jadi tanpa flag, ingest
memakai **key yang sama dengan engine live**. `--tvl-rpc-url` mengarahkan HANYA pembacaan TVL on-chain
(`getTransactionsForAddress`) ke endpoint lain; `.env` tidak disentuh, engine tidak terpengaruh.

```bash
npm run backtest:integrity -- --per-window-universe --windows=3 --days=91 --end=2026-09-13 --candidates=96 \
  --tvl=onchain --tvl-cadence-hours=24 --tvl-rps=3 \
  --tvl-rpc-url 'https://mainnet.helius-rpc.com/?api-key=<KEY_INGEST>'
```

Validasi model memakai flag yang sama: `npm run validate:tvl -- --end=2026-09-13 --tvl-rpc-url '<url>'`.

Perilaku:

| Kondisi | Hasil |
|---|---|
| tanpa flag | `SOLANA_RPC_URL` dari `.env`, persis seperti sebelumnya; log `[tvl] RPC host <host> (default .env — key yang SAMA …)` |
| flag valid | semua read TVL ke host flag; log `[tvl] RPC host <host> (dari --tvl-rpc-url)` |
| flag = URL `.env` persis | jalan, tapi log `PERINGATAN … tidak ada yang dipisahkan` |
| flag kosong / bukan http(s) / tanpa host / tak ter-parse | **exit 1 sebelum window pertama di-load**, URL tidak dicetak |
| flag tanpa `--per-window-universe` | exit 1 (jalur itu tidak membaca TVL on-chain) |
| flag dengan `--tvl=model` | peringatan "flag diabaikan" |
| 429 yang lolos 6 retry | log + error: `HTTP 429 from <host> … lower --tvl-rps (now N) or … --tvl-rpc-url` |

Yang dicetak hanya host. Key tidak ditulis ke log, cache, report, atau manifest (`src/tests/tvlRpc.test.ts`).

Catatan operasional:

- **Kutip URL-nya** (`'…'`): `&` di query string dipotong shell.
- Key yang diberikan lewat baris perintah **terlihat di `ps` dan riwayat shell** selama proses jalan. Kode ini
  tidak bisa mencegah itu; kalau itu masalah, pakai key khusus ingest yang boleh dirotasi sesudahnya.
- Dengan key terpisah, `--tvl-rps` boleh dinaikkan (tabel di atas: 10/detik ≈ 2 jam), tapi batas paket key
  itu tetap belum terukur.
- **Ingest penuh (2–6 jam) adalah kerjaan Hermes di server**, bukan sesi Claude lokal. Sisi lokal hanya
  menyediakan flag + test.

## Yang tidak bisa diklaim

- Tidak ada hasil backtest on-chain; pertanyaan TP/gate masih belum terjawab.
- Belum diketahui apakah key lokal = key engine live, dan apakah 429 tadi sempat memengaruhi engine live.
  Cek log engine sekitar 14 Sep 17:00–17:40 UTC untuk error RPC 429.
- Rate limit Helius untuk `getTransactionsForAddress` di paket ini tidak didokumentasikan di sini; 3/detik
  adalah pilihan konservatif, bukan batas terukur.
