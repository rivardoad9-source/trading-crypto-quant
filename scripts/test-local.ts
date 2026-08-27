/**
 * Local verification & smoke test.
 *
 *   npm run test:local
 *   npm run test:local -- --keep-db      # keep the temp database for inspection
 *
 * Exercises the real modules end-to-end against live upstreams. Two deliberate
 * choices:
 *
 *  - It runs against a THROWAWAY SQLite file, never ./data/flowmetrix.db, so a smoke
 *    test can never pollute real paper-trading history.
 *  - Unconfigured optional services (DeepSeek, Telegram) report SKIP, not PASS and not
 *    FAIL. Reporting PASS would claim a connection that was never made; reporting FAIL
 *    would flag a healthy install as broken.
 *
 * Exit code is 1 if any step FAILs. SKIPs do not fail the run.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
/* Type-only: erased at compile time, so it does not load env before it is configured. */
import type { ScreenedPool } from "../src/services/meteora.js";

/* Must be set before anything imports src/config/env.ts, which parses on load. */
const tempDir = mkdtempSync(join(tmpdir(), "flowmetrix-smoke-"));
process.env.DATABASE_PATH = join(tempDir, "smoke.db");
process.env.DRY_RUN = "true";
/* A dedicated port so a dev server already on 4000 does not collide. */
const TEST_PORT = 4321;
process.env.PORT = String(TEST_PORT);

const keepDb = process.argv.includes("--keep-db");

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

type Status = "PASS" | "FAIL" | "SKIP";

interface Check {
  stage: string;
  name: string;
  status: Status;
  detail: string;
}

const checks: Check[] = [];

const ICONS: Record<Status, string> = { PASS: "✓", FAIL: "✗", SKIP: "–" };

function record(stage: string, name: string, status: Status, detail = ""): void {
  checks.push({ stage, name, status, detail });
  const line = `  ${ICONS[status]} ${name}${detail ? ` — ${detail}` : ""}`;
  if (status === "FAIL") console.error(line);
  else console.log(line);
}

/** Runs a check, turning any throw into a FAIL rather than aborting the run. */
async function check(
  stage: string,
  name: string,
  fn: () => Promise<string | { status: Status; detail: string }>,
): Promise<void> {
  try {
    const result = await fn();
    if (typeof result === "string") record(stage, name, "PASS", result);
    else record(stage, name, result.status, result.detail);
  } catch (err) {
    record(stage, name, "FAIL", err instanceof Error ? err.message : String(err));
  }
}

function banner(title: string): void {
  console.log(`\n${"─".repeat(70)}\n${title}\n${"─".repeat(70)}`);
}

const skip = (detail: string) => ({ status: "SKIP" as const, detail });

/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  console.log("\nFlowMetrix — Local Verification & Smoke Test");
  console.log(`temp database: ${process.env.DATABASE_PATH}`);

  /* ================================================================ */
  /* STAGE 1 — Environment & database health                          */
  /* ================================================================ */
  banner("STAGE 1 · Environment & Database Health");

  const { env, hasDeepSeek, hasTelegram } = await import("../src/config/env.js");
  const { db, initDatabase, closeDatabase } = await import("../src/database/db.js");

  await check("1", "Zod env schema parsed", async () => {
    if (typeof env.PORT !== "number") throw new Error("PORT did not coerce to a number");
    if (env.DRY_RUN !== true) throw new Error("DRY_RUN must be true in this build");
    return `DRY_RUN=${env.DRY_RUN}, TZ=${env.TZ}, port=${env.PORT}`;
  });

  await check("1", "Live-trading guard active", async () => {
    const { isLiveTradingEnabled } = await import("../src/config/env.js");
    if (isLiveTradingEnabled !== false) throw new Error("live trading must be hard-disabled");
    return "isLiveTradingEnabled === false";
  });

  await check("1", "SQLite initialised", async () => {
    initDatabase();
    return `open at ${process.env.DATABASE_PATH}`;
  });

  const REQUIRED_TABLES = [
    "daily_research_logs",
    "simulated_positions",
    "daily_pnl_snapshots",
  ] as const;

  for (const table of REQUIRED_TABLES) {
    await check("1", `Table ${table}`, async () => {
      const row = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
        .get(table) as { name: string } | undefined;
      if (!row) throw new Error("table missing");

      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      return `${cols.length} columns`;
    });
  }

  await check("1", "Migrations applied", async () => {
    const cols = (
      db.prepare(`PRAGMA table_info(simulated_positions)`).all() as Array<{ name: string }>
    ).map((c) => c.name);

    const expected = [
      "post_mortem",
      "safety_verdict",
      "top10_holder_pct",
      "est_gas_cost_usd",
      "impermanent_loss_usd",
    ];
    const missing = expected.filter((c) => !cols.includes(c));
    if (missing.length > 0) throw new Error(`missing columns: ${missing.join(", ")}`);
    return `${cols.length} columns incl. ${expected.length} migrated`;
  });

  /* ================================================================ */
  /* STAGE 2 — External services                                      */
  /* ================================================================ */
  banner("STAGE 2 · External Services Fetch Test");

  const marketData = await import("../src/services/marketData.js");
  const meteora = await import("../src/services/meteora.js");
  const deepseek = await import("../src/services/deepseek.js");
  const telegram = await import("../src/services/telegram.js");

  await check("2", "Fear & Greed API", async () => {
    const fng = await marketData.fetchFearGreed();
    if (!fng) throw new Error("returned null");
    if (!Number.isFinite(fng.value)) throw new Error(`non-numeric value: ${fng.value}`);
    return `index ${fng.value} (${fng.classification})`;
  });

  await check("2", "DEXScreener trending", async () => {
    const trending = await marketData.fetchTrendingTokens(5);
    if (trending.length === 0) throw new Error("no trending tokens returned");
    return `${trending.length} tokens, chains: ${[...new Set(trending.map((t) => t.chainId))].join(", ")}`;
  });

  await check("2", "CoinGecko spot prices", async () => {
    const prices = await marketData.fetchSpotPrices();
    if (!prices || !(prices.solUsd > 0)) throw new Error("SOL/USD unavailable");
    return `SOL $${prices.solUsd.toFixed(2)}, BTC $${prices.btcUsd.toFixed(0)}`;
  });

  /*
   * The PRD names https://dlmm-api.meteora.ag/pair/all_by_groups. That host now
   * answers 404 for every path, so the check asserts the documented endpoint is
   * genuinely gone rather than silently testing something else.
   */
  await check("2", "PRD Meteora endpoint (expected dead)", async () => {
    const res = await fetch("https://dlmm-api.meteora.ag/pair/all_by_groups", {
      signal: AbortSignal.timeout(20_000),
    }).catch(() => null);

    if (res && res.ok) {
      return {
        status: "PASS" as const,
        detail: "PRD endpoint is alive again — consider switching back",
      };
    }
    return {
      status: "SKIP" as const,
      detail: `HTTP ${res?.status ?? "unreachable"} — superseded by dlmm.datapi.meteora.ag/pools`,
    };
  });

  let candidates: ScreenedPool[] = [];

  await check("2", "Meteora DLMM pools (live endpoint)", async () => {
    const pools = await meteora.fetchLivePools({ pageSize: 200, pages: 2 });
    if (pools.length === 0) throw new Error("no pools returned");
    return `${pools.length} pools from ${env.METEORA_API_URL}`;
  });

  await check("2", "Rule-based screener (vol ≥ $10k, fee/TVL ≥ 0.8%)", async () => {
    const pools = await meteora.fetchLivePools({ pageSize: 200, pages: 2 });
    const thresholds = meteora.defaultThresholds();
    const result = meteora.screenPools(pools, thresholds);
    candidates = result.candidates;

    if (candidates.length === 0) {
      throw new Error(
        `no pool passed; rejections: ${JSON.stringify(result.rejected)}`,
      );
    }

    // Assert the filter actually filtered, rather than passing everything through.
    for (const c of candidates) {
      if (c.volume24hUsd < thresholds.minVolume24hUsd) {
        throw new Error(`${c.pairName} slipped the volume filter`);
      }
      if (c.feeTvlRatio24h < thresholds.minFeeTvlRatio24h) {
        throw new Error(`${c.pairName} slipped the fee/TVL filter`);
      }
    }

    const top3 = candidates.slice(0, 3);
    const summary = top3
      .map((c) => `${c.pairName} (${(c.feeTvlRatio24h * 100).toFixed(2)}%)`)
      .join(", ");
    return `${candidates.length} passed of ${result.scanned}; top 3: ${summary}`;
  });

  /*
   * Not a pass/fail of the code — a sanity read on what the screener actually feeds
   * downstream. Live data routinely contains pools reporting 20-300% fee/TVL per 24h
   * on a few thousand dollars of liquidity. The arithmetic is real, but the yield is
   * not one a position could realise, and MAX_FEE_TVL_RATIO is the only thing keeping
   * them out of the LLM prompt and the fee-accrual model.
   */
  await check("2", "Screener yield plausibility", async () => {
    if (candidates.length === 0) return skip("no candidates to inspect");

    const implausible = candidates.filter((c) => c.feeTvlRatio24h > 0.2);
    const extreme = candidates.filter((c) => c.feeTvlRatio24h > 1.0);
    const top = candidates[0]!;

    const detail =
      `ceiling ${(env.MAX_FEE_TVL_RATIO * 100).toFixed(0)}%/24h · ` +
      `${implausible.length}/${candidates.length} candidates above 20%/24h, ` +
      `${extreme.length} above 100% · top = ${top.pairName} at ` +
      `${(top.feeTvlRatio24h * 100).toFixed(1)}%/24h on $${top.tvlUsd.toFixed(0)} TVL`;

    if (implausible.length > 0) {
      console.log(
        `      ! top-ranked candidates imply ~${(top.feeTvlRatio24h * 100).toFixed(0)}%/day fee yield;\n` +
          `        consider lowering MAX_FEE_TVL_RATIO (see README) before trusting projected PnL`,
      );
    }
    return detail;
  });

  await check("2", "DeepSeek API + JSON parsing", async () => {
    if (!hasDeepSeek) return skip("DEEPSEEK_API_KEY not configured");

    const { z } = await import("zod");
    const schema = z.object({
      status: z.string(),
      score: z.number(),
    });

    const parsed = await deepseek.structuredCompletion({
      system: "You are a test harness. Reply with JSON only.",
      user: 'Return exactly {"status":"ok","score":42} as a JSON object.',
      schema,
      reasoning: false,
      maxTokens: 100,
    });

    if (typeof parsed.status !== "string" || typeof parsed.score !== "number") {
      throw new Error(`schema mismatch: ${JSON.stringify(parsed)}`);
    }
    return `parsed {status:"${parsed.status}", score:${parsed.score}}`;
  });

  await check("2", "Telegram test message", async () => {
    if (!hasTelegram) return skip("TELEGRAM_BOT_TOKEN / CHAT_ID not configured");

    const sent = await telegram.sendMessage("[TEST] Local environment connected successfully");
    if (!sent) throw new Error("dispatcher reported the message was not delivered");
    return "delivered to the configured chat";
  });

  await check("2", "Solana RPC priority fee", async () => {
    const { getPriorityFeeEstimate } = await import("../src/services/solana.js");
    const fee = await getPriorityFeeEstimate({ solPriceUsd: null });
    if (fee.samples === 0) throw new Error("no fee samples returned");
    return `p${fee.percentile} = ${fee.microLamportsPerCu} µlamports/CU over ${fee.samples} slots`;
  });

  /* ================================================================ */
  /* STAGE 3 — Paper trading state machine                            */
  /* ================================================================ */
  banner("STAGE 3 · Paper Trading State Machine (dry-run)");

  const repos = await import("../src/database/repositories.js");
  const trader = await import("../src/agents/dlmmTraderAgent.js");
  const { runDailySnapshot } = await import("../src/agents/snapshotJob.js");
  const { localDateString } = await import("../src/agents/researcherAgent.js");
  const { randomUUID } = await import("node:crypto");

  const positionId = randomUUID();
  const VIRTUAL_SOL = 1.0;
  let notionalUsd = 0;
  let entryPrice = 0;
  let lower = 0;
  let upper = 0;

  await check("3", "Open virtual position (1 SOL)", async () => {
    const best = candidates[0];
    if (!best) throw new Error("stage 2 produced no candidate pool to trade");

    const solPriceUsd = await marketData.fetchSolPriceUsd();
    if (solPriceUsd === null) throw new Error("SOL/USD unavailable; refusing to fabricate a size");

    entryPrice = best.currentPrice;
    const range = trader.computeBinRange(entryPrice, 10, 10);
    lower = range.lower;
    upper = range.upper;
    notionalUsd = VIRTUAL_SOL * solPriceUsd;

    repos.insertPosition({
      positionId,
      poolAddress: best.address,
      pairName: best.pairName,
      strategyType: "SPOT",
      entryPrice,
      lowerBinPrice: lower,
      upperBinPrice: upper,
      virtualSolAmount: VIRTUAL_SOL,
      entryTvl: best.tvlUsd,
      entry24hVolume: best.volume24hUsd,
      confidenceScore: 70,
      reasoningLog: "[SMOKE TEST] synthetic position",
      entrySolPriceUsd: solPriceUsd,
      safetyVerdict: "SKIPPED",
      top10HolderPct: null,
      mintAuthorityRevoked: null,
      freezeAuthorityRevoked: null,
      estGasCostUsd: null,
      estPriorityMicroLamports: null,
    });

    const active = repos.getActivePositions();
    if (active.length !== 1) throw new Error(`expected 1 active position, got ${active.length}`);
    if (repos.countActivePositions() !== 1) throw new Error("countActivePositions disagrees");

    return `${best.pairName} @ ${entryPrice.toPrecision(6)}, notional $${notionalUsd.toFixed(2)}`;
  });

  await check("3", "Fee accrual estimate", async () => {
    const best = candidates[0]!;
    const fee6h = meteora.estimateFeeYieldUsd(notionalUsd, best.feeTvlRatio24h, 6, true);
    const fee24h = meteora.estimateFeeYieldUsd(notionalUsd, best.feeTvlRatio24h, 24, true);
    const feeOut = meteora.estimateFeeYieldUsd(notionalUsd, best.feeTvlRatio24h, 6, false);

    if (!(fee6h > 0)) throw new Error("6h in-range accrual should be positive");
    if (Math.abs(fee24h - fee6h * 4) > 1e-9) throw new Error("accrual is not linear in time");
    if (feeOut !== 0) throw new Error("out-of-range accrual must be exactly zero");

    repos.updatePositionMetrics({
      positionId,
      currentPrice: entryPrice,
      unclaimedFeeUsd: fee6h,
      impermanentLossUsd: 0,
      positionValueChangeUsd: 0,
      floatingPnlUsd: fee6h,
    });

    return `6h ≈ $${fee6h.toFixed(4)}, 24h ≈ $${fee24h.toFixed(4)}, out-of-range = $0`;
  });

  await check("3", "Out-of-range trigger", async () => {
    const outside = upper * 1.05;
    const valuation = meteora.valuePosition({
      positionValueUsd: notionalUsd,
      entryPrice,
      currentPrice: outside,
      lowerBinPrice: lower,
      upperBinPrice: upper,
      accruedFeeUsd: 1,
    });
    if (valuation.inRange) throw new Error("price above the upper bin was reported in range");

    const exit = trader.evaluateExit({
      netPnlPct: valuation.netPnlPct,
      inRange: valuation.inRange,
      ageHours: 1,
    });
    if (exit.status !== "CLOSED_OUT_OF_RANGE") {
      throw new Error(`expected CLOSED_OUT_OF_RANGE, got ${exit.status}`);
    }
    return exit.status;
  });

  await check("3", "Take-profit trigger", async () => {
    const exit = trader.evaluateExit({
      netPnlPct: env.TAKE_PROFIT_PCT + 1,
      inRange: true,
      ageHours: 1,
    });
    if (exit.status !== "CLOSED_PROFIT") throw new Error(`expected CLOSED_PROFIT, got ${exit.status}`);
    return `fires at ≥ ${env.TAKE_PROFIT_PCT}%`;
  });

  await check("3", "Max-age trigger", async () => {
    const exit = trader.evaluateExit({
      netPnlPct: 0,
      inRange: true,
      ageHours: env.MAX_POSITION_AGE_HOURS + 1,
    });
    if (exit.status !== "CLOSED_TIMEOUT") throw new Error(`expected CLOSED_TIMEOUT, got ${exit.status}`);
    return `fires at ≥ ${env.MAX_POSITION_AGE_HOURS}h`;
  });

  let realizedPnlUsd = 0;

  await check("3", "Close position with realised PnL", async () => {
    const exitPrice = entryPrice * 1.02;
    const feeUsd = notionalUsd * 0.01;

    const valuation = meteora.valuePosition({
      positionValueUsd: notionalUsd,
      entryPrice,
      currentPrice: exitPrice,
      lowerBinPrice: lower,
      upperBinPrice: upper,
      accruedFeeUsd: feeUsd,
    });
    realizedPnlUsd = valuation.netPnlUsd;

    repos.closePosition({
      positionId,
      status: "CLOSED_PROFIT",
      exitPrice,
      realizedPnlUsd: valuation.netPnlUsd,
      realizedPnlPct: valuation.netPnlPct,
      unclaimedFeeUsd: feeUsd,
      impermanentLossUsd: valuation.divergenceVsHoldUsd,
      positionValueChangeUsd: valuation.positionValueChangeUsd,
      closeReason: "[SMOKE TEST] forced close",
    });

    const row = repos.getPositionById(positionId);
    if (!row) throw new Error("position vanished after close");
    if (row.status !== "CLOSED_PROFIT") throw new Error(`status is ${row.status}`);
    if (!row.closed_at) throw new Error("closed_at was not stamped");
    if (repos.countActivePositions() !== 0) throw new Error("position still counted as active");
    if (repos.getTotalFloatingPnlUsd() !== 0) {
      throw new Error("closed position still contributes floating PnL");
    }

    // The identity the dashboard depends on: PnL is fees + LP value change vs
    // capital, NOT fees + divergence-vs-hold.
    const expected = feeUsd + valuation.positionValueChangeUsd;
    if (Math.abs(row.realized_pnl_usd - expected) > 1e-9) {
      throw new Error(`realised PnL ${row.realized_pnl_usd} != fees + IL ${expected}`);
    }

    return (
      `net $${valuation.netPnlUsd.toFixed(4)} ` +
      `(fees $${feeUsd.toFixed(4)} + position value $${valuation.positionValueChangeUsd.toFixed(4)})`
    );
  });

  await check("3", "daily_pnl_snapshots updated", async () => {
    const today = localDateString();
    await runDailySnapshot(today);

    const rows = repos.getSnapshotsInRange(today, today);
    const snap = rows[0];
    if (!snap) throw new Error(`no snapshot row written for ${today}`);
    if (snap.total_trades_closed !== 1) {
      throw new Error(`expected 1 closed trade, got ${snap.total_trades_closed}`);
    }
    if (Math.abs(snap.net_pnl_usd - realizedPnlUsd) > 1e-6) {
      throw new Error(`snapshot PnL ${snap.net_pnl_usd} != realised ${realizedPnlUsd}`);
    }
    return `${today}: ${snap.total_trades_closed} closed, net $${snap.net_pnl_usd.toFixed(4)}`;
  });

  await check("3", "Post-mortem reflection", async () => {
    if (!hasDeepSeek) return skip("DEEPSEEK_API_KEY not configured");

    const { reflectOnPosition } = await import("../src/agents/postMortemAgent.js");
    const row = repos.getPositionById(positionId)!;
    const text = await reflectOnPosition(row);
    if (!text) throw new Error("no post-mortem was produced");

    const stored = repos.getPositionById(positionId)!.post_mortem;
    if (!stored) throw new Error("post-mortem was not persisted");
    return `"${text.slice(0, 60)}${text.length > 60 ? "…" : ""}"`;
  });

  /* ================================================================ */
  /* STAGE 4 — REST API                                               */
  /* ================================================================ */
  banner("STAGE 4 · Backend REST API Health");

  const { startApiServer, stopApiServer } = await import("../src/api/server.js");
  const base = `http://127.0.0.1:${TEST_PORT}/api`;

  let serverUp = false;

  await check("4", "Fastify server starts", async () => {
    await startApiServer();
    serverUp = true;
    return `listening on port ${TEST_PORT}`;
  });

  const endpoints: Array<{ path: string; validate: (body: any) => string }> = [
    {
      path: "/overview",
      validate: (b) => {
        for (const key of [
          "currentBalanceUSD",
          "currentEquityUSD",
          "winRatePct",
          "maxDrawdownPct",
          "activePositionsCount",
        ]) {
          if (typeof b[key] !== "number") throw new Error(`${key} is not a number`);
        }
        if (b.isDryRun !== true) throw new Error("isDryRun must be true");
        if (b.profitFactor !== null && typeof b.profitFactor !== "number") {
          throw new Error("profitFactor must be a number or null");
        }
        return `equity $${b.currentEquityUSD.toFixed(2)}, ${b.totalSimulatedTrades} trades, PF ${b.profitFactor ?? "n/a"}`;
      },
    },
    {
      path: "/positions/active",
      validate: (b) => {
        if (!Array.isArray(b.positions)) throw new Error("positions is not an array");
        return `${b.positions.length} active`;
      },
    },
    {
      path: "/positions/history",
      validate: (b) => {
        if (!Array.isArray(b.positions)) throw new Error("positions is not an array");
        if (b.positions.length === 0) throw new Error("expected the smoke-test trade in history");
        const p = b.positions[0];
        if (typeof p.realizedPnlUsd !== "number") throw new Error("realizedPnlUsd missing");
        if (!p.safety) throw new Error("safety block missing from the DTO");
        return `${b.positions.length} closed, newest ${p.pairName}`;
      },
    },
    {
      path: `/pnl-calendar?month=${localDateString().slice(0, 7)}`,
      validate: (b) => {
        if (!Array.isArray(b.days)) throw new Error("days is not an array");
        if (b.days.length !== b.daysInMonth) {
          throw new Error(`days array (${b.days.length}) != daysInMonth (${b.daysInMonth})`);
        }
        if (typeof b.monthNetPnlUsd !== "number") throw new Error("monthNetPnlUsd missing");
        return `${b.month}: ${b.daysInMonth} days, ${b.monthTrades} trades, net $${b.monthNetPnlUsd.toFixed(4)}`;
      },
    },
    {
      path: "/health",
      validate: (b) => {
        if (b.status !== "ok") throw new Error(`status is ${b.status}`);
        return `uptime ${b.uptimeSeconds}s`;
      },
    },
  ];

  if (serverUp) {
    for (const { path, validate } of endpoints) {
      await check("4", `GET /api${path}`, async () => {
        const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(15_000) });
        if (res.status !== 200) throw new Error(`HTTP ${res.status}`);

        const contentType = res.headers.get("content-type") ?? "";
        if (!contentType.includes("application/json")) {
          throw new Error(`content-type is ${contentType}`);
        }
        return `200 · ${validate(await res.json())}`;
      });
    }

    await check("4", "Invalid month rejected with 400", async () => {
      const res = await fetch(`${base}/pnl-calendar?month=oops`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status !== 400) throw new Error(`expected 400, got ${res.status}`);
      return "400 with an error payload";
    });

    await stopApiServer();
  }

  /* ================================================================ */
  /* STAGE 5 — Summary                                                */
  /* ================================================================ */
  banner("STAGE 5 · Summary Report");

  const stages: Record<string, string> = {
    "1": "Environment & Database",
    "2": "External Services",
    "3": "Paper Trading State Machine",
    "4": "Backend REST API",
  };

  for (const [id, title] of Object.entries(stages)) {
    const rows = checks.filter((c) => c.stage === id);
    const pass = rows.filter((r) => r.status === "PASS").length;
    const fail = rows.filter((r) => r.status === "FAIL").length;
    const skipped = rows.filter((r) => r.status === "SKIP").length;

    const verdict = fail > 0 ? "FAIL" : "PASS";
    console.log(
      `  ${ICONS[verdict]} Stage ${id} · ${title.padEnd(30)} ` +
        `${pass} passed, ${fail} failed, ${skipped} skipped`,
    );

    for (const row of rows.filter((r) => r.status === "FAIL")) {
      console.log(`      ✗ ${row.name}: ${row.detail}`);
    }
    for (const row of rows.filter((r) => r.status === "SKIP")) {
      console.log(`      – ${row.name}: ${row.detail}`);
    }
  }

  const failed = checks.filter((c) => c.status === "FAIL");
  const skipped = checks.filter((c) => c.status === "SKIP");

  console.log(`\n  Total: ${checks.length} checks · ${checks.length - failed.length - skipped.length} passed · ${failed.length} failed · ${skipped.length} skipped`);

  if (skipped.length > 0) {
    console.log(
      "\n  SKIPPED checks are unconfigured optional services, not failures.\n" +
        "  They must be configured and re-run before the VPS deploy is considered verified.",
    );
  }

  console.log(
    failed.length === 0
      ? "\n  RESULT: PASS — every configured module responded correctly.\n"
      : `\n  RESULT: FAIL — ${failed.length} check(s) need attention before deploying.\n`,
  );

  closeDatabase();
  if (!keepDb) rmSync(tempDir, { recursive: true, force: true });
  else console.log(`  temp database kept at ${process.env.DATABASE_PATH}\n`);

  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\n[smoke] harness crashed:", err);
  process.exit(1);
});
