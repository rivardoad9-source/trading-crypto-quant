/**
 * "Kenapa nggak ada entry?" — cetak SETIAP rem entry dan statusnya, lengkap dengan angkanya.
 *
 *   node --import tsx scripts/checkEntryBrakes.ts
 *
 * Read-only (nol signature, nol tulis DB). Dipakai tiap kali ada pertanyaan "kok nggak ada
 * trade", supaya jawabannya dari pembacaan rem yang sama dengan yang dibaca `openLivePosition`,
 * bukan dari tebakan urutan cek. Fungsi-fungsi di bawah ini yang MEMUTUSKAN, bukan skrip ini:
 * `sumFailedAttemptCost` (budget kegagalan), `countUnresolvedOrphanAttempts` (modal nyangkut),
 * `readEngineControlFile` (hold operator), `readNewsBlackout` (window berita).
 */
import { env } from "../src/config/env.js";
import { liveMicroCapital, isLiveExecutionActive } from "../src/config/liveConfig.js";
import { readEngineControlFile } from "../src/services/engineControl.js";
import { readNewsBlackout } from "../src/services/newsBlackout.js";
import {
  countUnresolvedOrphanAttempts,
  sumFailedAttemptCost,
} from "../src/database/repositories.js";
import {
  describeLiveExecutionBlockers,
  exitSlippageCapBps,
  onchainConfig,
  resolveSlippageBps,
  sweepSlippageLadder,
} from "../src/services/liveExecution.js";

function main(): void {
  const live = isLiveExecutionActive();
  console.log(`mode live aktif : ${live ? "YA" : "TIDAK (paper)"} | DRY_RUN=${env.DRY_RUN}`);

  const held: string[] = [];

  const control = readEngineControlFile();
  console.log(
    `file control    : ${control.paused ? `HOLD (${control.reason ?? "tanpa alasan"})` : "tidak ada hold"}`,
  );
  if (control.paused) held.push("file control");

  const blackout = readNewsBlackout();
  const window = blackout.active;
  console.log(
    `news blackout   : ${window ? `AKTIF ${window.event} s/d ${window.end.toISOString()}` : "tidak ada"}`,
  );
  if (window) held.push("news blackout");

  const stranded = countUnresolvedOrphanAttempts();
  console.log(`modal nyangkut   : ${stranded} attempt orphan (0 = bersih)`);
  if (stranded > 0) held.push("StrandedCapitalError");

  const spent = sumFailedAttemptCost(env.LIVE_FAILED_COST_WINDOW_HOURS);
  const spentSol = spent.lamports / 1e9;
  const over = Number.isFinite(env.LIVE_MAX_FAILED_COST_SOL)
    ? spentSol > env.LIVE_MAX_FAILED_COST_SOL
    : false;
  console.log(
    `breaker biaya    : ${spentSol.toFixed(6)} SOL gagal dalam ${env.LIVE_FAILED_COST_WINDOW_HOURS}h ` +
      `(${spent.attempts} attempt, ${spent.unmeasured} tak terukur) vs budget ` +
      `${Number.isFinite(env.LIVE_MAX_FAILED_COST_SOL) ? `${env.LIVE_MAX_FAILED_COST_SOL} SOL` : "Infinity (mati)"}` +
      ` -> ${over ? "MENAHAN ENTRY" : "lolos"}`,
  );
  if (over) held.push("FailedCostBreakerError");

  console.log(
    `ukuran posisi    : capital ${liveMicroCapital.capitalSol} SOL - reserve ` +
      `${liveMicroCapital.minReserveSol} SOL = deployable ${liveMicroCapital.deployableSol} SOL, ` +
      `maks ${liveMicroCapital.maxPositionSol} SOL/posisi, ${liveMicroCapital.maxConcurrentPositions} posisi`,
  );

  /*
   * The slippage bounds, both of them. Added 13 Sep 2026 with the EXIT-leg split: an operator
   * asking "why did the sale get refused" needs to see the bound the sale was held to, and
   * the two numbers must be visibly different or the split has silently collapsed.
   */
  const ladder = sweepSlippageLadder(exitSlippageCapBps());
  console.log(
    `slippage         : entry max ${resolveSlippageBps({ maxSlippageBps: onchainConfig.maxSlippageBps } as never)} bps ` +
      `| exit max ${exitSlippageCapBps()} bps | ladder sisa token ${ladder.join(" -> ")} bps`,
  );

  const blockers = describeLiveExecutionBlockers();
  console.log(`blocker config   : ${blockers.length === 0 ? "tidak ada" : blockers.join(" | ")}`);
  if (blockers.length > 0) held.push("config blocker");

  console.log(
    `\n>> ENTRY: ${held.length === 0 ? "NYALA (tidak ada rem)" : `DITAHAN oleh: ${held.join(", ")}`}`,
  );
  if (!live) console.log("   (mode live nggak aktif — rem di atas nggak relevan)");
}

main();
