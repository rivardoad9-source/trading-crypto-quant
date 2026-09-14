# Wait-and-see: yang ditambah selama config dibekukan (14 Sep 2026)

Branch: `work/wait-and-see-measurement`, dibangun di atas `work/window-universe-scale-and-exit-cost-completeness`
(WO3). Merge branch ini = dapat WO3 + tambahan di bawah.

**Tidak ada yang mengubah entry/exit engine selama default dipakai.** TP/SL, gate coverage, ukuran posisi,
`LIVE_MAX_POSITION_BINS` tidak disentuh. Tidak ada deploy, restart, perubahan `.env` server, atau transaksi.

## Aturan selama wait-and-see

| Dibekukan | Tetap jalan |
|---|---|
| TP/SL, gate coverage, ukuran posisi, modal | engine live seperti sekarang |
| `LIVE_MAX_POSITION_BINS=70` (narrow only) | pengukuran di bawah |
| fitur/strategi baru | ingest backtest WO3 (offline) |

Evaluasi ulang setelah **~30 trade live** atau setelah pasar jelas pernah turun, mana yang duluan.
Pertanyaannya: (1) wallet SOL naik vs modal awal, termasuk biaya open gagal? (2) setelah biaya exit masih
untung? (3) profit dari fee atau dari harga?

## 1. `npm run report:live` (read-only)

Buka DB dengan `readonly: true`, tidak migrasi, aman dijalankan saat engine jalan.

```bash
npm run report:live -- --baseline-sol=3.10          # 7 hari terakhir
npm run report:live -- --baseline-sol=3.10 --days=30 --json   # + reports/live_report.json (gitignored)
```

Isi: wallet terukur terakhir vs `LIVE_CAPITAL_SOL` vs baseline · per posisi live: fee vs perubahan nilai,
porsi fee, delta SOL chain (hanya kalau terukur & sweep settled), fee exit + konsesi (keputusan & landing) ·
open gagal (biaya terukur vs tak terukur, terpisah) · hasil bersih SOL + apa yang tidak ikut dihitung ·
konsentrasi per token · progress N/30. Yang tidak terukur dicetak `—`, tidak pernah 0.

## 2. Token concentration (default REPORT, entry tidak berubah)

| Env | Default | Arti |
|---|---|---|
| `LIVE_TOKEN_CONCENTRATION_MODE` | `report` | `report` = log + catat saja; `enforce` = pool dibuang sebelum LLM |
| `LIVE_MAX_ENTRIES_PER_TOKEN` | `2` | open live terkonfirmasi per mint dalam window; ke-N+1 di-flag. 0 ditolak saat boot |
| `LIVE_TOKEN_ENTRY_WINDOW_HOURS` | `24` | window |

- Sumber: `live_execution_attempts` (`outcome='opened'`), key = mint token pasangan (lintas pool sibling).
  Row tanpa mint dicocokkan per pool saja dan disebut di reason.
- Hanya aktif saat live execution aktif (paper mode tidak berubah). Gagal baca DB → gate dilewati (fail-open).
- Log: `[concentration] flagged <pair> (report mode, kept): …`. Funnel: `scan_funnel_cycles.concentration_flagged`
  (dua mode) dan `exec_token_concentration_rejected` (enforce saja, ikut `execution_rejected` supaya funnel rekonsiliasi).
- **Catatan jujur:** kalau ini `enforce` sejak 12 Sep, dua dari empat trade EMBER (dua-duanya TP) akan ditolak.
  Keputusan `enforce` sebaiknya diambil dari jumlah flag + hasil trade yang ter-flag setelah beberapa minggu.

Query untuk cek:

```sql
SELECT cycle_at, concentration_flagged, exec_token_concentration_rejected, skip_reason
FROM scan_funnel_cycles WHERE concentration_flagged > 0 ORDER BY id DESC LIMIT 20;
```

## 3. Shadow pick: LLM vs aturan sederhana

Setiap siklus yang sampai ke keputusan DeepSeek sekarang mencatat, di shortlist yang SAMA:
`llm_pick_pool/pair` (null kalau model menolak) dan `rule_pick_pool/pair` = pool dengan fee/TVL 24h tertinggi,
plus `shortlist_size`. Rule tidak pernah dieksekusi. Log: `[shadow] shortlist N: LLM X · rule(max fee/TVL) Y · SAME|DIFFERENT`.

```sql
SELECT COUNT(*) AS keputusan,
       SUM(llm_pick_pool IS NULL) AS llm_menolak,
       SUM(llm_pick_pool = rule_pick_pool) AS sama,
       SUM(llm_pick_pool IS NOT NULL AND llm_pick_pool <> rule_pick_pool) AS beda
FROM scan_funnel_cycles WHERE shortlist_size IS NOT NULL;
```

Kalau hampir selalu `sama`, LLM tidak menambah apa-apa di pemilihan pool. Kalau sering `beda`, pool pilihan rule
bisa dinilai belakangan dari bar historisnya (alamat + `cycle_at` tersimpan).

## Migrasi DB

Semua kolom lewat `addColumnIfMissing` saat boot (`scan_funnel_cycles`: 7 kolom baru; `exit_economics`: 4 kolom
dari WO3). Row lama tetap NULL/0. Tidak ada tabel baru.

## Verifikasi

- `npm run typecheck` hijau.
- `npm test` di Windows: **990/990 pass** (970 WO3 + 10 `liveReport` + 10 `tokenConcentration`).
- `report:live` dijalankan pada DB lokal (hanya row paper): output kosong tapi benar (`BELUM ADA saldo terukur`, `0/30`).

## Yang belum bisa diklaim

- Belum pernah jalan di engine live; gate konsentrasi dan shadow pick hanya diuji unit + bentuk source.
- `report:live` belum pernah dijalankan pada DB live; angka pertamanya baru muncul di server.
- Shadow pick mencatat pilihan, bukan hasil: membandingkan hasil pool pilihan rule butuh analisis offline terpisah.
