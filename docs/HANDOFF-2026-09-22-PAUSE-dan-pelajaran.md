# FlowMetrix — PAUSE & PELAJARAN (handoff 22 Sep 2026)

> Dokumen ini ditulis saat engine **di-pause** dan saldo wallet dikosongkan (operator pindah ke Kryskal).
> Tujuannya satu: sesi berikutnya nggak mulai dari nol dan nggak ngulang error yang sama.
> Bahasa campur Indonesia + istilah teknis Inggris, sesuai cara kerja kita.

---

## 0. STATUS SEKARANG — apa yang MATI, apa yang HIDUP

**MATI (dipause 22 Sep 2026):**

| Hal | Kondisi |
|---|---|
| Engine | `pm2 flowmetrix-engine` **stopped** (`dist/index.js`, node v22.23.2, cwd `/home/ubuntu/flowmetrix-ai-agent`) |
| API | `localhost:4000` mati (http 000) |
| Hold entry | `data/engine_control.json` = `{"paused": true, ...}` → kalaupun engine nyala lagi (reboot / `pm2 resurrect`), **semua entry baru DITOLAK**; monitoring/exit tetap jalan (desain: hold = entries only) |
| Cron | 18 job FlowMetrix di-pause (daftar di §10) |
| Wallet | operator tarik SOL manual (lihat §7 untuk langkahnya) |

**HIDUP (sengaja nggak diganggu):** dashboard `pm2 flowmetrix-dashboard` (:3100 — sering restart, 53×), job news (radar/ briefing / FOMC / HyperTrack), Lynk webhook check, backup config harian.

**Snapshot terakhir sebelum dimatikan (22 Sep 2026 ~09:45 WIB):**
- Wallet on-chain: `2.719070393 SOL` ≈ $320.82 (SOL $117.99), **0 posisi open**, **0 token nyangkut**
- Sisa 4 token account semua ~kosong: `6GmAFSYs…`(0), `EPjFWdd5…`=USDC(0), `HcRLc9VD…`(0, Token-2022), `91ryaCo…pump`(0.000015)
- Buku engine: equity $314.91 (start $288.27, +26.64 realized, 8 trade, win rate 75%, max DD 6.67%)
- `live_execution_attempts` terakhir: **21 Sep 02:25 WIB** (TIGRINO open) — jadi selama 21→22 Sep engine **nol** eksekusi live
- Registry LP manual: `positions: []` (kosong, bersih)

---

## 1. CARA NYALAIN LAGI (pre-flight — urutannya penting)

```bash
# 1) RPC sehat? (3× getSlot harus 200 & <1s; kalau 522 → JANGAN nyalain dulu)
cd /home/ubuntu/flowmetrix-ai-agent && set -a && . ./.env && set +a
curl -s -m 25 "$SOLANA_RPC_URL" -X POST -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getSlot"}' -w ' [%{http_code} %{time_total}s]\n'

# 2) Wallet ada isinya + LIVE_CAPITAL_SOL ≤ (SOL on-chain − 0.15)
#    (guard sizing MENOLAK semua entry kalau LIVE_CAPITAL_SOL > saldo on-chain)

# 3) Guard state bersih (angka peak/halt PALSU bikin alarm kalau nggak direset)
cat ~/.hermes/cache/fm_dd_state.json /tmp/fm_watchdog_state* ~/.hermes/cache/fm_cadence_guard_state.json 2>/dev/null

# 4) Lepas hold file  (⚠️ /resume lewat Telegram TIDAK bisa menghapus hold ini)
rm /home/ubuntu/flowmetrix-ai-agent/data/engine_control.json

# 5) Start engine
pm2 start flowmetrix-engine && pm2 save

# 6) Nyalain cron lagi
hermes cron resume <job_id>     # daftar ID di §10

# 7) Verifikasi: /api/health ok → tunggu ≤20 menit → ada baris baru di scan_funnel_cycles
curl -s localhost:4000/api/health; curl -s localhost:4000/api/overview | head -c 400
```

**Deploy/restart kode: JANGAN `pm2 restart` dari shell.** Pakai `python3 diag/fm_deploy_clean.py --go`
(hold → TUNGGU IDLE → build → restart → verify → lepas). Worktree live WAJIB di branch `main`.
Test wajib node22. Harness yang nyentuh uang WAJIB `background=true` (timeout foreground 420s
membunuh proses di tengah swap).

---

## 2. ARSITEKTUR SINGKAT

- **Engine** (TypeScript → `dist/index.js`, pm2 `flowmetrix-engine`): screener DLMM Meteora → filter →
  anti-rug → **gerbang ekonomi** → keputusan LLM → sizing guard → entry; API di `:4000`.
- **DB**: `data/flowmetrix.db` — `scan_funnel_cycles` (funnel tiap siklus), `live_execution_attempts`,
  tabel posisi. **`sqlite3` CLI nggak terpasang** → pakai Python:
  `sqlite3.connect("file:...db?mode=ro", uri=True)`.
- **Cadence**: `DLMM_BASE_CADENCE_MIN=20`, cron tick `*/5`. Siklus nyata **19–21 menit** karena engine
  tidur SETELAH kerja (satu siklus makan 4–80 detik). Jarak 19/21 menit itu **NORMAL**.
- **Dashboard** `:3100` (read-only, tidak menandatangani apa pun).
- **Hard rule**: hanya engine yang menandatangani transaksi. Semua script Hermes (`fm_*`) **alert-only
  by construction** — nggak nutup, nggak jual, nggak mindahin uang.

---

## 3. GERBANG EKONOMI — alasan #1 "kok nggak ada trade" (JANGAN diakalin)

Syarat masuk: **proyeksi fee pool ≥ 2.5× biaya round-trip (entry+exit) selama 24 jam.**

Malam 21→22 Sep 2026 (contoh paling jelas):
- **31 siklus, 0 entry, 0 attempt live**
- **23 siklus**: `skip_reason = "no candidate clears the breakeven gate (2.5x round-trip cost over 24h of fees)"`
  (kandidat ada 29–32/siklus, tapi nggak ada yang lolos biaya)
- **8 siklus**: kandidat sampai ke LLM, tapi **LLM-nya sendiri nolak** — mayoritas `TIGRINO-SOL`,
  pool yang barusan stop-out 2× (−8.33% & −8.41% setelah dump 18% dalam 4 jam)
- Filter layar per siklus buang: lowTvl ~208, unverifiedToken ~200, lowFeeRatio ~85, highTvl ~45

**Bacaannya:** mesinnya sehat, opsinya yang nggak dibayar. Menurunkan 2.5× = nambah frekuensi trade
tanpa nambah edge (bukan perbaikan). Yang benar: cari pool/regime lain, dan ukur dengan
counterfactual (`gate_counterfactual`, `paper_trade_scorer`) — bukan feeling.

---

## 4. RPC HELIUS 522 — pelajaran paling mahal

**Gejala:** `getSlot` sukses 0.06–0.2 s, gagal **HTTP 522** (Cloudflare timeout) dengan latency
**19.5–19.7 s**. Bergantian dalam satu menit (200, 522, 200, 200, 522…).

**Efek nyata (dan bedanya):**
1. Anti-rug nggak bisa baca holder concentration → kandidat ditandai `UNKNOWN` → **ditolak**
   → kita kehilangan kandidat (bukan uang).
2. Sizing guard **MENOLAK entry** saat saldo wallet nggak kebaca ("unverified wallet = empty").
   Ini fail-safe yang benar.
3. Semua alat alert yang nggak dibedakan → **alarm palsu**. Ini yang paling mahal: 22 Sep 03:00–05:00
   operator dibangunin 17× "🚨 wallet on-chain ANOMALY" padahal wallet-nya bersih.

**Aturan yang sekarang dipegang:**
- **Kegagalan BACA ≠ anomali OBJEK.** Alat ukur gagal → alert "alat gagal", bukan "aset rusak".
- Alert wajib: retry → dedupe (6 jam) → **watermark jangan dihapus oleh satu bacaan bersih**
  (522 datang bergantian sukses/gagal; kalau watermark di-reset tiap sukses, alarm nyala tiap ~10 menit).
- **Utang teknis**: cuma ada 1 endpoint RPC. Kalau produksi mau jalan lagi, siapkan endpoint kedua
  (keputusan biaya, bukan keputusan teknis).

---

## 5. GUARD & ALAT — plus bug yang ketemu 22 Sep

| Alat (cron) | File | Fungsi | Pelajaran |
|---|---|---|---|
| live watchdog `*/5` (`57a809ada658`) | `~/.hermes/scripts/fm_live_watchdog.sh` | sweep chain + scan log engine + dead-man | 🐞 lihat di bawah |
| cadence guard `*/30` (`b7f908e7efe9`) | `fm_cadence_guard.py` | bandingkan cadence src vs dist vs proses vs jarak siklus nyata | toleransi **±1 menit** (19/21 menit itu normal); `--selftest` 10/10 |
| drawdown guard `*/5` (`70820da0659a`) | `fm_drawdown_guard.py` | auto-halt entry (satuan SL) | pisahkan "equity TIDAK TERUKUR" dari alert riil; pesan itu dedupe 1 jam + hormati `--quiet` |
| dead-man ping `*/5` (`eab14e07631c`) | `deadman_ping_cron.sh` | heartbeat eksternal | kalau ini senyap, seluruh box dicurigai mati |
| book vs chain recon `06:05` (`0c02e02797db`) | `fm_book_chain_recon_cron.sh` | rekonsiliasi buku engine vs wallet | drift = temuan, bukan alarm palsu |
| orphan self-heal `*/10` (`b9f020ba1f1b`) | `fm_orphan_selfheal.py` | selamatkan posisi funded yang ditinggal open gagal | lahir dari insiden **10 Sep** (half-landed open) |
| residual self-heal `*/2` (`cf7d63a88605`) | `fm_residual_selfheal.py` | retry jual sisa token setelah close gagal | lahir dari insiden **KNOTS 12 Sep** |
| lp-manual-keeper `*/5` (`f2f68f4b7c1a`) | `fm_manual_lp_monitor.py` | alert LP manual operator (Meteora nggak punya TP/SL) | registry `~/.hermes/data/fm_manual_positions.json` WAJIB diupdate tiap buka/tutup |
| paper ledger `*/30` (`4e6f2af35eca`) | `paper_trade_scorer.py` + `audit_paper_chain.py` | ledger kertas + audit | "deduped" = kembar, bukan trade baru |
| counterfactual `*/15` (`c2b5663b5f79`, `63d533faf722`) | `gate_counterfactual.py`, `entrycosts_sweep.sh` | ukur pool yang bakal lolos kalau biaya diukur beda | bukti untuk revisit threshold |
| trade doc `12 * * * *` (`739909d3dc26`) | `fm_trade_doc.py` | catatan bukti tiap posisi LIVE yang ditutup | jejak audit per trade |

### 🐞 Tiga bug yang ketemu & diperbaiki 22 Sep 2026 (semua alert-only, nol uang)

1. **Matcher watchdog salah anchor.** `grep -qi '^sweep error'` **tidak pernah match**, karena
   `fm_chain_sweep.mjs` mencetak SETIAP temuan sebagai `🔴 <teks>` — termasuk kegagalan bacanya.
   Akibatnya cabang "alat ukur gagal" (retry + dedupe 6 jam) jadi **dead code**, dan outage RPC
   dilaporkan sebagai 17× "🚨 anomali wallet". → pola diganti tanpa anchor.
2. **Watermark `chainerr` dihapus oleh satu bacaan bersih.** Karena 522 bergantian sukses/gagal,
   dedupe 6 jam jadi dedupe ~10 menit. → watermark sekarang cuma diganti kalau keadaan benar-benar pulih.
3. **Pesan dobel (bot + stdout).** Script kirim Telegram sendiri DAN mencetak ke stdout, sementara
   cron job-nya `deliver=origin` → tiap kejadian terkirim 2×. → jalur kegagalan-baca tidak lagi
   nge-echo; aturan baru: **satu kejadian = satu pesan** (kalau script kirim sendiri, stdout harus kosong).

**Pelajaran umum (dipakai buat Kryskal nanti):** kalau *producer* menempelkan prefix/emoji pada
outputnya, *matcher* di konsumen harus diuji terhadap **output nyata**, bukan terhadap teks yang kita
kira. Dan: watchdog jangan pernah menyamakan "alat ukur gagal" dengan "objeknya rusak".

---

## 6. VERIFIKASI YANG SUDAH DILAKUKAN (biar nggak ada klaim kosong)

- Harness non-sending `/tmp/verify_wd.sh` + `/tmp/verify_wd2.sh` — 3 varian input (error 522 / temuan
  asli / bacaan bersih): kegagalan baca → **1 pesan benar** (bukan "chain anomaly"), temuan asli tetap
  🚨, sisanya senyap; watermark bertahan setelah bacaan bersih. `bash -n` 3/3 OK.
- **Run produksi 05:06 WIB** (setelah patch): watchdog mencetak `sweep read failed (bukan anomali
  wallet)` — bukan `chain anomaly`. Run-run setelahnya **senyap**. Bukti fix jalan di live.
- `fm_cadence_guard.py --selftest` → **10/10 lulus**; `fm_drawdown_guard.py` → dedupe 1 jam + `--quiet`
  terbukti lewat harness.
- DB: semua siklus 21 Sep 19:00 → 22 Sep 05:01 WIB `opened=0`; `live_execution_attempts` terakhir
  21 Sep 02:25 WIB. → **nggak ada uang bergerak selama window itu.**

---

## 7. UANG & PEMBUKUAN (jangan percaya buku saja)

- **Sumber kebenaran = chain (wallet), bukan buku engine.** Buku bisa drift.
- Per 22 Sep: buku equity $314.91 vs wallet 2.719070393 SOL ($320.82) → selisih ≈ **0.43 SOL** dari
  total deposit. Penyebab yang sudah teridentifikasi: friksi yang nggak termodel, biaya attempt gagal,
  dan burn pra-live. **Selalu validasi angka guard (peak/halt) ke chain/wallet** — peak bisa artefak
  (wallet basi + notional).
- **LP manual operator di wallet yang SAMA** → registry `~/.hermes/data/fm_manual_positions.json` wajib
  diupdate tiap buka/tutup (kalau nggak: sweep nge-flag posisi manual sebagai "nyangkut" → alarm palsu,
  kejadian 19 Sep). Modal LP manual dihitung sebagai equity. Efek samping: engine **menolak semua entry**
  kalau `LIVE_CAPITAL_SOL` > saldo on-chain → turunkan `LIVE_CAPITAL_SOL` saat ada LP manual.
- **Menarik/mengirim dana = tindakan MANUAL operator.** Nggak ada script Hermes yang menandatangani.

### Langkah mengosongkan wallet (manual, operator)
- Alamat wallet: `FaVHg7bThap7wcF9G7kjSjrDsMbVrgUkpG6twzi1yQKi`
- Saldo saat pause: **2.719070393 SOL** (0 token berharga, 0 posisi)
- Caranya: buka wallet (Phantom/Solflare) → **Send** → alamat tujuan → **Max** → konfirmasi.
  Engine sudah stop + hold, jadi nggak ada yang bakal memakai saldo itu lagi.
- Opsional: tutup/burn 4 token account kosong (`6GmAFSYs…`, `EPjFWdd5…` USDC, `HcRLc9VD…`, `91ryaCo…pump`)
  → rent kembali ≈ **0.006 SOL** (~$0.71).

---

## 8. EXIT MECHANICS (kalau nanti live lagi)

- **zap 1 tx hanya kalau withdraw muat 1 tx** (binStep ≳200). binStep 50 (148 bin) = 3 tx → jalur
  **legacy**: close → jual residu → tutup ATA.
- **Floor swap dihitung dari jumlah SETELAH fee transfer-2022** (dulu salah hitung → sisa token nyangkut).
- Tx besar (CU ~500k) butuh `ONCHAIN_MIN_PRIORITY_MICRO_LAMPORTS=300000`, kalau nggak: tx gagal.
- **Jual-balik = leg EXIT 300 bps**, bukan 50 bps (50 bps itu entry).
- Referensi lengkap: skill `flowmetrix-ops` → `zap-out-vs-position-width-2026-09-20.md`.

---

## 9. ATURAN KERJA (ini yang bikin sesi berikutnya nggak ngulang error)

1. **Deploy**: worktree live WAJIB di `main`; `diag/fm_deploy_clean.py --go` (hold → TUNGGU IDLE →
   build → restart → verify → lepas). Jangan `pm2` dari shell untuk deploy. Test wajib node22.
2. **Uang**: harness yang menyentuh uang WAJIB `background=true`.
3. **Alert**: satu kejadian = satu pesan. Kegagalan alat ≠ temuan. Fail-safe boleh, alarm palsu nggak.
4. **Verifikasi ke sumber primer**: chain (wallet), DB, log mentah — bukan buku/summary/klaim.
5. `sqlite3` CLI nggak ada → Python `sqlite3` mode read-only URI.
6. Kritik dari agent lain sering benar → cek sumber primer sebelum membela diri.
7. Kalau nggak yakin: **jangan tanda tangan, jangan tutup posisi, jangan pindahkan uang.**

---

## 10. LAMPIRAN — file penting & daftar job yang dipause

**Script:** `~/.hermes/scripts/fm_*.sh | *.py | *.mjs` (`fm_live_watchdog.sh`, `fm_cadence_guard.py`,
`fm_drawdown_guard.py`, `fm_chain_sweep.mjs`, `fm_manual_lp_monitor.py`, `fm_orphan_selfheal.py`,
`fm_residual_selfheal.py`, `fm_book_chain_recon_cron.sh`, `fm_trade_doc.py`, `paper_trade_scorer.py`,
`audit_paper_chain.py`, `gate_counterfactual.py`, `entrycosts_sweep.sh`, `deadman_ping_cron.sh`,
`fm_daily_recap.py`, `fluxmetrix_export_cron.sh`, `fm_capital_gate_cron.sh`, `fm_news_brief_context.sh`)

**Data/state:** `data/flowmetrix.db`, `data/engine_control.json` (HOLD aktif),
`data/news_blackout.json`, `~/.hermes/data/fm_manual_positions.json`, `~/.hermes/cache/fm_dd_state.json`,
`~/.hermes/cache/fm_manual_lp_state.json`, `~/.hermes/cache/fm_cadence_guard_state.json`,
`/tmp/fm_watchdog_state*`

**Log:** `~/.pm2/logs/flowmetrix-engine-out.log`, `...-error.log`; cron output `~/.hermes/cron/output/<job_id>/`

**Job FlowMetrix yang di-pause 22 Sep 2026:**

| Job ID | Nama |
|---|---|
| `57a809ada658` | FlowMetrix live watchdog |
| `70820da0659a` | FlowMetrix penjaga drawdown |
| `eab14e07631c` | FlowMetrix dead-man ping |
| `b7f908e7efe9` | FlowMetrix cadence guard |
| `0c02e02797db` | FlowMetrix rekonsiliasi buku vs chain (06:05) |
| `b5758bcda564` | FlowMetrix rekap harian (06:00) |
| `cd15b7777690` | FlowMetrix nightly export (22:00) |
| `3da03d88274d` | FlowMetrix analytics refresh (4 jam) |
| `b9f020ba1f1b` | orphan self-heal |
| `cf7d63a88605` | residual self-heal |
| `739909d3dc26` | trade-doc |
| `3efa909b7442` | gate modal |
| `63d533faf722` | entrycosts-sweep |
| `c2b5663b5f79` | gate-counterfactual |
| `4e6f2af35eca` | paper-trade-tpsl |
| `f2f68f4b7c1a` | lp-manual-keeper |
| `c4df66bc1b47` | News blackout refresh |
| `09073e521734` | Pre-news briefing FlowMetrix x News |

Nyala lagi: `hermes cron resume <job_id>` (satu per satu), atau semua sekaligus dengan loop.

---

## 11. PINDAH KE KRYSKAL — apa yang dibawa

**Dibawa (pelajaran, bukan kode):**
1. Ukur **biaya dulu**, baru sinyal (gerbang ekonomi) — jangan tambah frekuensi tanpa edge.
2. **Fail-safe ke pembacaan yang gagal**, tapi pisahkan alarm alat vs alarm aset.
3. **Satu kejadian = satu pesan**; dedupe dengan watermark yang nggak gampang di-reset.
4. **Chain = kebenaran**; rekonsiliasi buku tiap hari; registry manual wajib kalau ada intervensi manusia.
5. Exit lebih mahal dari entry — hitung jalur exit (jumlah tx, fee transfer-2022, priority fee) sebelum masuk.
6. Deploy yang nggak mengganggu posisi terbuka: hold → tunggu idle → deploy → verify.

**Yang belum kita pecahkan (warisan):** drift buku vs chain, dan cuma 1 endpoint RPC.

---

*Terakhir diupdate: 22 Sep 2026, saat engine di-pause. Kalau engine dinyalakan lagi, update §0 dan §10.*
