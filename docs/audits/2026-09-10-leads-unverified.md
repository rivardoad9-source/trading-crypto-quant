# Leads — audit engine 10 Sep 2026 (BELUM TERVERIFIKASI penuh)

Sumber: 1) evidence pack server-side (`2026-09-10-evidence-pack.md`, terverifikasi), dan
2) jejak investigasi 4 sub-agent yang **dihentikan di tengah jalan** (23:02–23:05 WIB, laporan final
tidak sempat ditulis). Isi di bawah ini **LEAD, bukan temuan final** — tiap poin butuh verifikasi
satu langkah lagi ke kode/DB. Dikumpulkan agar kerja yang sudah jalan tidak terbuang, dan agar
auditor berikutnya (Claude atau sesi baru) bisa mulai dari sini, bukan dari nol.

Status: engine LIVE & ARMED, 0 posisi, equity $298.02 — tidak ada yang perlu diubah darurat.

---

## L1 — Race window double-entry (money, perlu verifikasi)
**`src/agents/dlmmTraderAgent.ts:2087–2096`** — komentar penulis kode sendiri mengakui:

> LIVE EXECUTION … Deliberately OUTSIDE positionMutex. … The capacity check therefore happens twice:
> once here, before spending anything, and again under the lock below. `maxConcurrentPositions` is 1,
> so the window is narrow, but **a second entry racing this one would be a real double spend rather
> than a duplicated row**.

Yang perlu diverifikasi: apakah ada guard anti-overlap di level CYCLE (mutex/flag `isRunning`), atau
apakah cron `*/5` bisa memulai cycle baru saat cycle sebelumnya masih jalan? Cycle normal ≈ 9,4 s
(dari `scan_funnel_cycles.duration_ms`), tapi cycle dengan panggilan DeepSeek lambat / RPC lambat bisa
jadi menit-an → jendela race membesar. Cek juga `positionMutex` di `src/index.ts` vs `dlmmTraderAgent`.
Bukti pendukung dari pack: `maxConcurrentPositions` efektif 1; tidak ada baris posisi ganda di DB
(`simulated_positions` 0 baris) — jadi belum pernah terjadi, ini pencegahan.

## L2 — Tidak ada scan orphan on-chain saat ENGINE BOOT (money, perlu verifikasi)
**`src/index.ts:19,169–172`** — saat boot hanya ada `reconcilePositions()` (level DB) + wallet
reconciliation. **Tidak ada pemindaian token on-chain saat startup.**

Kenapa penting: insiden 9 Sep (0,9 SOL nyangkut jadi token tanpa monitor setelah restart di tengah
cycle) persis kasus yang bisa ditangkap scan boot. Saat ini penjaganya hanya watchdog eksternal
(sweep on-chain tiap 15 menit di `~/.hermes/scripts/fm_live_watchdog.sh`), jadi ada jendela sampai
~15 menit + engine tidak mengatahui sendiri.

Yang perlu diverifikasi: apakah `reconcilePositions()` / wallet reconciliation benar-benar memeriksa
saldo token on-chain (bukan cuma baris DB), dan apakah hasilnya masuk alert operator.

## L3 — GMGN gate fail-open + report-only (desain, perlu dikonfirmasi aman)
**`src/services/gmgnScreener.ts:2,26,30–31`** + **`src/config/env.ts:213`**:

> OPTIONAL, FAIL-OPEN, REPORT-ONLY-BY-DEFAULT … FAIL-OPEN: any error, timeout, or rate-limit makes the
> assessment `null` … `GMGN_GATE_MODE=report` (default) logs flags and **never rejects**.

`.env` produksi memang `GMGN_GATE_MODE=report` → lapisan ini **tidak pernah memblokir**; kalau GMGN
error/timeout, assessment jadi `null` dan lolos. Ini gagal-ke-terbuka (fail open) by design.

Yang perlu diverifikasi: apakah lapisan anti-rug terpisah (fail-closed, `ANTIRUG_ON_ERROR=reject`)
memang selalu jalan SEBELUM entry sehingga kekosongan GMGN tertutup. Bukti pendukung dari log
(terverifikasi): anti-rug memang menolak secara fail-closed — `[antirug] rejected MET-SOL (FAIL):
top 10 holders control 80.0% (limit 25%)`, `rejected TOAD-SOL (FAIL): 31.9%`. Jadi risiko = GMGN
lapisan kedua mati, bukan satu-satunya penjaga.

## L4 — Partisi instruksi funding: fail-safe dua arah (desain, rendah)
**`src/services/onchainExecutor.ts:663–675`** — `partitionFundingInstructions()` hanya membuang
instruksi `initializeBinArray` bila decode + derived address cocok persis; selain itu KEEP dan bayar.
Alasan tertulis: "sending one redundant init wastes compute while dropping a needed one strands the
funding" — fail-safe ke arah aman ✓. Komentarnya mengklaim ada repro harness yang mendukung; verifikasi
apakah harness itu ada di repo dan masih dijalankan.

---

## Konteks terverifikasi dari evidence pack (tidak perlu dicari ulang)
- `pool_execution_failures`: **6 baris, `token_mint` SEMUA NULL**, key hanya `pool_address`; ada **2 baris
  KNOTS-SOL** dengan pool berbeda (95NyuWzMDmW… 09-09 19:32:10, nBXytBBfKLh… 09-09 19:02:49) → eksekusi
  kedua untuk mint yang sama, 29 menit jarak. Tidak ada guard level-mint yang bisa dibangun dari DB ini.
- `simulated_positions`: 0 baris; `integrity_check`: ok; wallet on-chain: **2.944854 SOL** + 1 token
  account (USDC 1.062727) → **0 token orphan** saat ini.
- Env: **1 var di-shadow** — `DEEPSEEK_API_KEY` proses (sha8 `99480a24`) = `HERMES_DEEPSEEK_API_KEY`,
  sedangkan `.env` engine (`8776c0ec`) **tidak dipakai** (dotenv tidak menimpa process.env). 115 var
  bocor ke proses engine (termasuk kredensial Hermes) — engine tidak membaca satu pun (sudah digrep),
  jadi hygiene, bukan jalur eksploitasi.
- `NODE_ENV` tidak dipakai di `src/` (false alarm ditutup).
- Log sepanjang umur: `unwind` out=7/err=14 · `max_tokens` err=56 · `timeout` err=36 · `bench` err=236 ·
  `409` err=176 (semua pra-perbaikan bot).
