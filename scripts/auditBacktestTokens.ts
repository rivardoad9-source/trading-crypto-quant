/**
 * Audit: berapa trade di sebuah hasil backtest yang tokennnya bakal DITOLAK gate live sekarang?
 *
 *   node --import tsx scripts/auditBacktestTokens.ts <backtest_micro_capital.json> [scenario=unbiased]
 *
 * Kenapa ada: gate Token-2022 (fee/hook/non-transferable) TIDAK ADA di model backtest —
 * `src/backtest/*` nggak tahu apa-apa soal extension mint. Jadi kalau ada trade di token
 * ber-fee, angka backtest itu kelebihan (fees nggak dibayar, exit di-mark di harga pool).
 * Skrip ini mengukur berapa banyak, dari trade yang benar-benar terjadi, bukan menduga.
 *
 * Read-only: nggak sign apa pun, nggak nulis DB. Semua lewat jalur kode yang sama dengan
 * engine (fetchPoolByAddress + readTokenExtensions).
 */
import { readFileSync } from "node:fs";
import { env } from "../src/config/env.js";
import { fetchPoolByAddress } from "../src/services/meteora.js";
import { readTokenExtensions } from "../src/services/tokenExtensions.js";
import { WSOL_MINT } from "../src/config/constants.js";

interface TradeRow {
  poolAddress: string;
  pairName: string;
  notionalUsd?: number;
  feesEarnedUsd?: number;
  netPnlUsd?: number;
  exitReason?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: node --import tsx scripts/auditBacktestTokens.ts <backtest.json> [scenario]");
    process.exit(2);
  }
  const scenario = process.argv[3] ?? "unbiased";
  const data = JSON.parse(readFileSync(path, "utf8")) as {
    scenarios?: Record<string, { trades?: TradeRow[] }>;
  };
  const trades = data.scenarios?.[scenario]?.trades ?? [];
  if (trades.length === 0) {
    console.error(`no trades in scenario "${scenario}" of ${path}`);
    process.exit(2);
  }

  const byPool = new Map<string, { pairName: string; trades: TradeRow[] }>();
  for (const t of trades) {
    const hit = byPool.get(t.poolAddress);
    if (hit) hit.trades.push(t);
    else byPool.set(t.poolAddress, { pairName: t.pairName, trades: [t] });
  }

  console.log(
    `file: ${path}\nscenario: ${scenario} | ${trades.length} trade di ${byPool.size} pool\n` +
      `limit gate live: LIVE_MAX_TOKEN_TRANSFER_FEE_BPS=${env.LIVE_MAX_TOKEN_TRANSFER_FEE_BPS}\n`,
  );

  let blockedTrades = 0;
  let blockedNet = 0;
  let blockedFees = 0;
  let unknownTrades = 0;
  const rows: string[] = [];

  for (const [pool, info] of byPool) {
    let mint = "";
    let status = "?";
    let detail = "";
    try {
      const poolInfo = await fetchPoolByAddress(pool);
      if (!poolInfo) throw new Error(`pool ${pool} tidak ada di Meteora API`);
      const base = String(poolInfo.baseMint ?? "");
      const quote = String(poolInfo.quoteMint ?? "");
      mint = base === WSOL_MINT ? quote : base;
      const reading = await readTokenExtensions(mint);
      const blocked =
        reading.transferFeeBps > env.LIVE_MAX_TOKEN_TRANSFER_FEE_BPS ||
        reading.hasTransferHook ||
        reading.nonTransferable;
      status = blocked ? "DITOLAK" : "lolos";
      detail =
        `fee=${reading.transferFeeBps}bps hook=${reading.hasTransferHook} ` +
        `nonTransfer=${reading.nonTransferable}`;
      if (blocked) {
        blockedTrades += info.trades.length;
        for (const t of info.trades) {
          blockedNet += t.netPnlUsd ?? 0;
          blockedFees += t.feesEarnedUsd ?? 0;
        }
      }
    } catch (err) {
      status = "TAK TERBACA";
      detail = err instanceof Error ? err.message.slice(0, 70) : String(err);
      unknownTrades += info.trades.length;
    }
    rows.push(
      `${status.padEnd(11)} ${info.pairName.padEnd(16)} trade ${String(info.trades.length).padStart(2)}  ` +
        `${mint.slice(0, 8)}  ${detail}`,
    );
    await sleep(250);
  }

  rows.sort();
  for (const r of rows) console.log(r);

  const safeNet = trades.reduce((s, t) => s + (t.netPnlUsd ?? 0), 0);
  console.log(
    `\nTOTAL trade ${trades.length} | net skenario $${safeNet.toFixed(2)}\n` +
      `DITOLAK gate live: ${blockedTrades} trade (${((blockedTrades / trades.length) * 100).toFixed(1)}%) ` +
      `| net dari trade itu $${blockedNet.toFixed(2)} ` +
      `(${safeNet !== 0 ? ((blockedNet / safeNet) * 100).toFixed(1) : "n/a"}% dari net) ` +
      `| fee yang mereka klaim $${blockedFees.toFixed(2)}\n` +
      `TAK TERBACA: ${unknownTrades} trade`,
  );
}

void main();
