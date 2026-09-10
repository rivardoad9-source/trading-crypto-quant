# Incident 2026-09-11 (02:0x–02:31 WIB) — kegagalan buka posisi live berulang: dana keluar, posisi tidak jadi

**Status:** DIPERBAIKI 11 Sep 02:52 WIB (engine di-pause, sizing dibetulin, KNOTS-SOL di-denylist).
**Severity:** major — **−0,0639 SOL (~$6,33, 2,17% saldo wallet) tanpa satu pun posisi kebuka.**
**Kelas akar masalah:** sizing memakai modal yang lebih besar dari saldo nyata → kaki funding gagal
setelah swap keburu jalan; diperparah bench yang hanya menahan ~3 jam lalu mencoba lagi.

## Kronologi (dari log pm2 + DB)

| Waktu (WIB) | Kejadian |
|---|---|
| 02:0x | `[live] KNOTS-SOL: 94 bins, open cost 0.0744 SOL … swapping 0.9000 SOL -> 8RVBk8vxLiUHueLUW1f4izFVqN3nWippLhkohKg6EGkS to balance the deposit` |
| 02:0x–02:31 | 3× percobaan: **swap balancing CONFIRMED** → DLMM `RebalanceLiquidity` gagal (`process deposit → TransferChecked → Error: insufficient funds`, program error 0x1) → **auto-unwind balik ke SOL di-submit** setiap kali |
| 02:30:58 | watchdog `chain anomaly` (sweep on-chain menemukan token KNOTS nangkut di wallet) → alert terkirim |
| 02:31:19 | baris bench `nBXytBBfKLhj6teXarAv8rk6WNgUFBMyybUFRkuK7ad` KNOTS-SOL: `consecutive_failures=2`, `total_failures=2` |
| 02:35:58 | watchdog `exec error` → alert terkirim |

Pesan kegagalan yg tercatat (tiga varian, semuanya pola sama):

```
[live] the balancing swap CONFIRMED but the position open failed. The wallet now holds 3539581852 base units
       of 8RVBk8vxLiUHueLUW1f4izFVqN3nWippLhkohKg6EGkS that nothing monitors (swap fB8wjoM7WLNi...).
       Auto-unwind back to SOL submitted (4b2STiJvp6y9aJ1C3YbY5de3r64EhqWGnBfJACtTU9LB5aZskgiYtDGD3StKaJhsW9u8EsMNaj1txhKng3dkEQeu).
```

## Dampak keuangan (terukur)

| | |
|---|---|
| SOL on-chain 10 Sep 23:05 | 2,944854 |
| SOL on-chain 11 Sep 02:47 | **2,880994** |
| Selisih | **−0,0639 SOL ≈ −$6,33** (@ $99,09/SOL) = 2,17% wallet |
| Posisi kebuka | **0** (DB `simulated_positions` 0 baris, `daily_pnl_snapshots` PnL 0) |
| Token orphan | **0** — account token-2022 mint `8RVBk8…` ada tapi saldo 0; unwind berhasil bersih |
| USDC | utuh (1,062727) |

Biaya = slippage + priority fee pada swap masuk, tx funding yang gagal, dan swap unwind keluar — dibayar
tiga kali karena percobaan diulang.

## Akar masalah

1. **`LIVE_CAPITAL_SOL=3.05` sedangkan wallet nyata 2,880994 SOL** → engine men-size posisi seolah punya
   **kelebihan +0,169 SOL**. Deposit DLMM dihitung dari asumsi itu, sementara swap balancing hanya
   mengirim 0,9 SOL → `insufficient funds` **setelah** dana sudah keluar.
   (Saat pin modal di-set 3.05, wallet memang 2,944854 — margin tipis; begitu tergerus, margin jadi negatif.)
2. **Bench hanya menahan ~3 jam** (`benched for another 3.0h of 24h`) untuk kegagalan **setelah swap
   terlanjur dibelanjakan** → tiap 3 jam dicoba lagi → tiap percobaan membakar ~0,02 SOL.
3. **Key bench = `pool_address`, bukan mint** → sibling pool dari mint yang sama bisa menembus (defect
   kelas yang sudah terdokumentasi 10 Sep). DB: 6 baris `pool_execution_failures`, `token_mint` **semua NULL**.

## Perbaikan yang diterapkan (11 Sep 02:52 WIB, butuh restart → engine di-pause dulu)

| Perubahan | Sebelum | Sesudah |
|---|---|---|
| `LIVE_CAPITAL_SOL` | 3.05 | **2.85** |
| `POOL_DENYLIST` | …5 entri | **+`KNOTS-SOL`** (level pair → semua pool mint itu) |
| `data/engine_control.json` | tidak ada | ada (pause operator, alasan tercatat) |

Backup `.env` sebelum edit: `~/.hermes/cache/fm_env_backup_20260911_025139.env`.
Script: `~/.hermes/scripts/diag/fm_fix_sizing.py` (edit) + `~/.hermes/scripts/diag/fm_restart_fix.sh` (restart+verifikasi).

## Verifikasi pasca-restart

- Preflight: `reserve 0.15 SOL untouchable, **2.70 SOL deployable**` (2.85 − 0.15) vs wallet **2.880994 SOL** → margin **+0,18 SOL** ✓ (sebelumnya asumsi melebihi saldo)
- `wallet FaVHg7…: 2.880994 SOL (floor 0.2 SOL) — OK`
- Token bot proses tetap `sha8 76e2d325` → `getMe` = **@zemiztradebot** ✓; **0** baris 409
- `control: pausedByFile=True` (entri ditahan, monitor jalan), posisi 0, `isDryRun=false`
- Cron terdaftar: monitor `* * * * *`, dlmm `*/5` (run 30m; 5m selama 90m setelah window news), snapshot 23:55

## Sisa risiko / belum tuntas

1. **Sizing masih manual.** Tidak ada guard yang membandingkan `LIVE_CAPITAL_SOL` dengan saldo on-chain
   saat boot. Kalau wallet turun lagi (biaya, slippage), bug yang sama bisa terulang. → butuh fix kode:
   fail-closed kalau `LIVE_CAPITAL_SOL + reserve > saldo nyata`.
2. **Bench per-pool + escalate 3 jam** masih utuh. Penambahan `KNOTS-SOL` hanya menambal satu mint.
   → fix kode: kunci bench ke mint, dan kegagalan pasca-swap = bench panjang/permanen.
3. **Pin `STARTING_BALANCE_USD=298.02` sekarang ~$12 lebih optimistis** dari wallet nyata (~$285,5).
   Belum diubah (ini baseline akuntansi + dasar perhitungan DD watchdog) — perlu keputusan operator.
4. Setelah wallet pulih/di-topup, `LIVE_CAPITAL_SOL` bisa dinaikkan lagi (≤ saldo nyata − reserve).
