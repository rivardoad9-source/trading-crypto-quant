# A/B: formula biasa (gate breakeven 2,5) vs formula baru (main di "standar terdekat" = gate dilepas)

Sumber: `docs/backtests/runs/gate_bestavail{,_300}/*.json` (29 run, 20 Sep 2026).
Arm (a) live-eligible & (b) full universe diambil apa adanya dari `eligibility[]` tiap run (angka runner).
Kolom konsentrasi/biaya dihitung dari daftar trade arm (b) (exact, karena trades JSON = arm b).

## Arm (a) live-eligible — yang benar-benar bisa dibuka engine

| setelan | 91d · $180 | 120d · $234 | 91d · $300 |
|---|---|---|---|
| **2.5 (formula biasa / LIVE)** | 20 tr · **+$141,36** · PF 3,18 · DD 12,0% | 24 tr · −$85,46 · PF 0,58 · DD 36,9% | 20 tr · **+$221,54** · PF 3,30 · DD 10,8% |
| 2.0 | identik | 37 tr · −$28,18 · PF 0,89 | identik |
| 1.5 | identik | 37 tr · −$28,18 · PF 0,89 | identik |
| 1.0 | 24 tr · −$1,46 · PF 0,99 · DD 24,1% | 91 tr · +$9,99 · PF 1,01 · DD 39,4% | 32 tr · −$35,45 · PF 0,87 |
| 0.75 | 73 tr · +$229,32 · PF 1,49 · DD 21,2% | 168 tr · +$332,27 · PF 1,15 · DD 54,8% | 86 tr · +$155,47 · PF 1,19 · DD 35,0% |
| **≤0,5 (formula baru)** | 86 tr · **+$11,85** · PF **1,03** · DD **44,4%** | 177 tr · +$453,28 · PF 1,15 · DD 53,0% | 86 tr · **+$60,41** · PF 1,08 · DD **37,8%** |
| maxfee0.5 (lever lain) | 33 tr · **+$357,85** · PF 3,68 · DD 15,2% | 24 tr · −$85,46 (tidak mengikat) | — |

Net per unit drawdown: 91d 11,8 → **0,27** · $300 20,5 → **1,6** · 120d −2,3 → 8,5 (tapi lihat catatan 120d).

## Arm (b) full universe + mekanismenya (exact dari trades)

| arm 91d | trade | net | PF | DD | fee/trade | cost/trade | top1% | top3% |
|---|---|---|---|---|---|---|---|---|
| cov2.5 | 31 | +$256,76 | 3,05 | 11,8% | $7,48 | $1,44 | 14% | 34% |
| cov1.0 | 60 | +$78,96 | 1,27 | 19,6% | — | — | — | — |
| cov0.75 | 97 | +$119,31 | 1,27 | 20,8% | $2,41 | $1,22 | 33,5% | 63,6% |
| cov≤0.5 | 134 | +$25,56 | 1,04 | 39,1% | $1,97 | $1,19 | **90,4%** | **230,4%** |
| maxfee0.5 | 45 | **+$566,73** | 3,42 | 15,2% | $10,67 | $1,70 | 10,7% | 26,1% |

## Koreksi biaya leg ENTRY (0,42% × notional × trade, tidak dihitung model)

- 91d arm ≤0,5: +$11,85 → **−$44** · $300: +$60,41 → **−$7** (nol koma nol logika: fee/trade $1,97 vs biaya $1,19+entry $0,52).

## Kenapa 120d tidak bisa dipakai membela formula baru

- cov2,0 (b) 48 tr −$105,35 padahal cov1,5 (b) 22 tr +$79,62 → naikkan gate bikin tanda balik.
- cov1,0 (b) 26 tr PF 15,24 DD 3,6% = sampel kecil/luck; cov0,0 arm (a) +$453,28 vs arm (b) −$42,51 → tanda beda antar-universe.
- Artinya hasil ditentukan trade mana yang kepilih (slot/kool-down), bukan oleh aturan gate → tidak robust.

## Kesimpulan

Formula baru **bukan perbaikan**: 4,3-7,4x lebih sering entry, tapi net turun 73-91% di akun kecil,
PF jatuh ke ~1,0 (dari 3,2), DD naik 3-4x, dan ~90% netnya berasal dari SATU trade. Formula biasa
memang sedikit entry, tapi tiap trade berdiri sendiri (fee 5x biaya), PF 3,2-3,3, DD 11-12%,
dan naik proporsional saat modal dinaikkan ($180 → $300: +$141 → +$222).
Kalau tujuannya menambah entry TANPA merusak kualitas, lever yang benar adalah plafon fee/TVL
0,25 → 0,5 (maxfee0.5): +65% entry, net 2,5x, PF 3,68, DD 15,2%, dan di 120d tidak mengubah apa pun.
