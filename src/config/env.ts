import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Minimal .env loader (no dotenv dependency).
 * Existing process.env values always win, so shell/CI overrides work as expected.
 */
function loadDotEnv(file = ".env"): void {
  const path = resolve(process.cwd(), file);
  if (!existsSync(path)) return;

  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();

    // Strip matching surrounding quotes.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    // Tolerate markdown-style links pasted into .env: [https://x](https://x) -> https://x
    const markdownLink = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(value);
    if (markdownLink) value = markdownLink[2] ?? markdownLink[1] ?? value;

    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv();

/** Coerces "true"/"1"/"yes" to boolean. Anything unrecognised falls back to the default. */
const booleanish = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v.trim() === "") return defaultValue;
      return ["true", "1", "yes", "on"].includes(v.trim().toLowerCase());
    });

/**
 * Whether the on-chain executor is armed, read straight from the environment.
 *
 * `ONCHAIN_EXECUTION_ARMED` is owned by the executor's own schema in
 * `services/onchainExecutor.ts`. This module deliberately does NOT import that one:
 * doing so would pull the signer into the engine's import graph through the config
 * layer, which is the exact edge `onchainExecutor.test.ts` polices. Duplicating one
 * boolean parse is the cheaper of the two costs, and it is parsed the same way
 * (`booleanish`) so the two cannot disagree about what "true" means.
 */
function armedInEnvironment(): boolean {
  const raw = process.env.ONCHAIN_EXECUTION_ARMED;
  if (raw === undefined || raw.trim() === "") return false;
  return ["true", "1", "yes", "on"].includes(raw.trim().toLowerCase());
}

const numeric = (defaultValue: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === "" ? defaultValue : Number(v)))
    .pipe(z.number().finite());

/**
 * Values left at their .env.example placeholder count as unset. Without this a
 * literal "your_deepseek_api_key_here" reads as configured and the failure only
 * surfaces later as a confusing 401 from the provider.
 */
const PLACEHOLDER = /^(your_|<|changeme|xxx+$|todo$)/i;

const optionalString = z
  .string()
  .optional()
  .transform((v) => {
    if (v === undefined) return undefined;
    const trimmed = v.trim();
    if (trimmed === "" || PLACEHOLDER.test(trimmed)) return undefined;
    return trimmed;
  });

/**
 * Placeholder text embedded inside a URL, e.g.
 * `https://mainnet.helius-rpc.com/?api-key=your_helius_key`.
 *
 * The leading-token check above cannot catch these, so a copied .env.example value
 * would read as configured and only fail later as an opaque HTTP 401.
 */
const EMBEDDED_PLACEHOLDER = /your_[a-z0-9_]*key|<[^>]+>|changeme|xxxx/i;

/** A URL that silently falls back to `fallback` when it still holds a placeholder. */
const urlWithFallback = (fallback: string, label: string) =>
  z
    .string()
    .optional()
    .transform((v) => {
      const trimmed = v?.trim() ?? "";
      if (trimmed === "" || EMBEDDED_PLACEHOLDER.test(trimmed) || PLACEHOLDER.test(trimmed)) {
        if (trimmed !== "") {
          console.warn(
            `[env] ${label} still contains a placeholder; falling back to ${fallback}`,
          );
        }
        return fallback;
      }
      return trimmed;
    })
    .pipe(z.string().url());

const EnvSchema = z
  .object({
    // Server & mode
    PORT: numeric(4000),
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    DRY_RUN: booleanish(true),
    TZ: z.string().default("Asia/Jakarta"),

    // AI provider
    DEEPSEEK_API_KEY: optionalString,
    DEEPSEEK_BASE_URL: z.string().url().default("https://api.deepseek.com"),
    DEEPSEEK_MODEL_CHAT: z.string().default("deepseek-chat"),
    DEEPSEEK_MODEL_REASONER: z.string().default("deepseek-reasoner"),

    // Solana & Meteora
    SOLANA_RPC_URL: urlWithFallback("https://api.mainnet-beta.solana.com", "SOLANA_RPC_URL"),
    METEORA_API_URL: z.string().url().default("https://dlmm.datapi.meteora.ag"),
    SOLANA_PRIVATE_KEY: optionalString,

    // Telegram
    TELEGRAM_BOT_TOKEN: optionalString,
    TELEGRAM_CHAT_ID: optionalString,
    /**
     * Comma-separated Telegram user IDs allowed to run control commands
     * (/status, /close_all, /pause, /resume). Empty = nobody is authorized —
     * control commands are denied to everyone (fail closed).
     */
    TELEGRAM_ALLOWED_USER_IDS: z
      .string()
      .optional()
      .transform((v) =>
        (v ?? "")
          .split(",")
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isInteger(n) && n > 0),
      ),

    // Paper trading engine
    VIRTUAL_SOL_PER_POSITION: numeric(1.0),
    MAX_CONCURRENT_POSITIONS: numeric(3),
    TAKE_PROFIT_PCT: numeric(5.0),
    STOP_LOSS_PCT: numeric(-8.0),
    MAX_POSITION_AGE_HOURS: numeric(24),

    // Screener thresholds
    MIN_24H_VOLUME_USD: numeric(10_000),
    MIN_FEE_TVL_RATIO: numeric(0.008),
    MIN_TVL_USD: numeric(50_000),
    /**
     * Outlier ceiling on the 24h fee/TVL ratio. Live data contains pools reporting
     * 300%+ fee/TVL in 24h — almost always a collapsed or transient TVL denominator
     * rather than a real yield. Without a ceiling these dominate the (fee/TVL)*volume
     * ranking. Set very high (e.g. 999) to disable.
     *
     * Lowered from 2.0 to 0.25 after a live screen showed 6 of 72 candidates above
     * 20%/24h and the top one at 85%/24h on $43k of liquidity — yields no position
     * could actually realise.
     */
    MAX_FEE_TVL_RATIO: numeric(0.25),

    // ---- Anti-rug screen ----
    ANTIRUG_ENABLED: booleanish(true),
    /** Reject when the largest 10 accounts hold at least this share of supply. */
    ANTIRUG_MAX_TOP10_HOLDER_PCT: numeric(25),
    ANTIRUG_REQUIRE_MINT_REVOKED: booleanish(true),
    ANTIRUG_REQUIRE_FREEZE_REVOKED: booleanish(true),
    /**
     * What to do when a safety check cannot be executed (RPC unreachable, or the
     * provider blocks getTokenLargestAccounts as the public node does).
     *
     * "reject"      — fail closed. An unverifiable pool never reaches the LLM.
     * "allow"       — fail open. Only sensible if you accept trading unscreened pools.
     *
     * Fail-closed is the default: a filter that silently passes when it cannot run is
     * worse than no filter, because it manufactures confidence that was never earned.
     */
    ANTIRUG_ON_ERROR: z.enum(["reject", "allow"]).default("reject"),

    // ---- GMGN holder-structure gate (optional, fail-open, report-only default) ----
    /**
     * GMGN OpenAPI key (https://gmgn.ai/ai). Empty disables the gate entirely.
     * Query-only credentials; the private key is NEVER needed here.
     */
    GMGN_API_KEY: z.string().default(""),
    /**
     * Sum of bundler/sniper/rat_trader holdings (percent of supply) at or above
     * which the pool is flagged. Calibrated 9 Sep 2026: Muk (caused a live loss)
     * sat at 9.4% across 7 wallets; healthy pools measured 0-8.2%.
     */
    GMGN_MAX_BAD_CONCENTRATION_PCT: numeric(15),
    /**
     * "report"  — log flags, never reject (calibration default).
     * "enforce" — reject flagged pools before the LLM sees them.
     */
    GMGN_GATE_MODE: z.enum(["report", "enforce"]).default("report"),

    // ---- Priority fee estimation ----
    /** Percentile across recently sampled slots; most slots report a zero fee. */
    PRIORITY_FEE_PERCENTILE: numeric(75),
    /** Compute units assumed for one DLMM position transaction. */
    PRIORITY_FEE_COMPUTE_UNITS: numeric(200_000),

    /* ---- Failure-avoidance guardrails ---- */
    /*
     * Four hard gates, each validated out-of-sample on ~13k enumerated entries split
     * 15d/15d. Together they cut the rate of losses worse than -10% from 6.5% to 1.5%
     * in-sample and from 8.3% to 0.9% out-of-sample. They are exclusions, not a
     * scoring formula: the composite score tried alongside them did NOT hold its sign
     * across the two halves, so ranking is left to the plain fee/TVL x volume rule.
     */
    /** Pools younger than this are rejected. Big-loss lift measured at 7.3x. */
    MIN_POOL_AGE_HOURS: numeric(48),
    /** Reject on a 1h price surge above this. Big-loss lift measured at 6.8x. */
    MAX_PRICE_SURGE_1H_PCT: numeric(10),
    /** Reject above this realized hourly volatility. Big-loss lift measured at 5.8x. */
    MAX_REALIZED_VOL_PCT_PER_HOUR: numeric(20),
    /**
     * Upper TVL bound. Above it fees are too thin to matter — the >$500k bucket
     * averaged 0.00% net across 2779 entries. The sweet spot is $50k-$500k.
     */
    MAX_TVL_USD: numeric(500_000),

    /**
     * Volatility gate: reject a pool whose token gained more than this in 24h.
     *
     * Entering at the top of a pump is how a DLMM position ends up fully converted to
     * the dumped token on the retrace. A pool whose 24h change cannot be determined is
     * rejected too — see MAX_PRICE_CHANGE_ON_UNKNOWN.
     */
    MAX_PRICE_CHANGE_24H_PCT: numeric(150),
    /** "reject" (fail closed) or "allow" when the 24h change is unavailable. */
    VOLATILITY_ON_UNKNOWN: z.enum(["reject", "allow"]).default("reject"),

    /*
     * EXECUTION-TIME volatility, which is a different question from the three gates
     * above and is measured in a different unit.
     *
     * Those gates ask whether a pool is a good place to provide liquidity — a pump
     * already run, a token that moves 20%/h. This one asks whether the pool will hold
     * still long enough for a deposit to LAND. The DLMM program bakes the active bin
     * into the funding instructions and rejects them if the pool has drifted more than
     * `maxActiveBinSlippage` bins by the time they execute
     * (`ExceededBinSlippageTolerance`), so the quantity that matters is bins of drift
     * per unit of execution time, not percent per hour.
     *
     * A pool can pass all three screening gates and still lose this race: 20%/h on a
     * bin_step-100 pool is 20 bins an hour, and a funding sequence that takes a minute
     * and change against a 3-bin tolerance is a coin flip. Live-only, pre-swap, and a
     * free refusal.
     */
    /** Seconds a funding sequence is assumed to take from build to land. */
    LIVE_EXECUTION_WINDOW_SECONDS: numeric(90),
    /**
     * Refuse when projected bin drift over that window exceeds this multiple of the
     * active-bin tolerance the deposit will carry. 1 means "refuse when the pool is
     * expected to outrun the tolerance"; Infinity disables the gate.
     */
    LIVE_MAX_BIN_DRIFT_RATIO: numeric(1),

    /**
     * How many recent losing closes are quoted back to the model when it picks a pool.
     *
     * Only closes that already carry a post-mortem count. Kept small on purpose: the
     * block is evidence about the current regime, and a long tail of old trades from a
     * different market would dilute rather than inform. 0 disables the block.
     */
    LOSS_CONTEXT_TRADES: numeric(5),

    /**
     * Hard ceiling on a single DeepSeek call, in milliseconds.
     *
     * The OpenAI SDK defaults to 10 minutes with 2 retries — up to half an hour of a
     * silently stalled screener. deepseek-reasoner genuinely takes minutes, so this is
     * generous, but bounded.
     */
    DEEPSEEK_TIMEOUT_MS: numeric(120_000),

    /* ---- Engine version cohorts ---- */
    /**
     * The instant the v1.1 "clean engine" took over: anti-churn cooldown/lockout plus
     * the 60s exit monitor. Positions OPENED at or after this are cohort v1.1;
     * everything earlier is v1.0 legacy.
     *
     * Opened, not closed, on purpose — the cohort names the engine that made the entry
     * decision. A position the old screener chose is v1.0's trade no matter when it
     * happened to close.
     *
     * The default is the commit that introduced v1.1 (2026-08-29T13:20:40Z). NOT
     * midnight that day: 13 of the 27 legacy trades were opened later the same morning,
     * the last at 12:40Z, so a date-only cutoff would file pre-fix trades under "Clean
     * Engine" — the exact mislabelling this filter exists to prevent.
     *
     * **Set this to the moment you actually restart the engine on v1.1.** The commit
     * time is a safe floor, not a deploy record: code that is committed but not yet
     * running has produced no trades, so anything opened between the commit and the
     * restart is still v1.0's work and would be misfiled as clean.
     *
     * Any format SQLite's datetime() accepts. Bare 'YYYY-MM-DD' is read as UTC midnight,
     * matching how opened_at / closed_at are stored.
     */
    ENGINE_V11_CUTOFF: z.string().trim().min(1).default("2026-08-29T13:20:40Z"),

    /**
     * Longest gap, in hours, that a single monitor tick may accrue fees for.
     *
     * Fees are credited as `rate x (now - last_checked_at)`. After downtime that span is
     * however long the engine was off — a 52h restart gap credited two days of fees in
     * one tick, on the strength of a single instantaneous in-range check, for a period
     * nothing was watching. Unobserved time is not evidence the position was earning:
     * the same fail-closed rule the anti-rug and volatility gates use.
     *
     * Generous next to the 60s monitor and the 30m screener, so normal operation never
     * reaches it; only a restart or a long stall does.
     */
    MAX_FEE_ACCRUAL_GAP_HOURS: numeric(1),

    /* ---- Fast position monitor ---- */
    /**
     * Runs the position monitor every 60s, decoupled from the 30-minute screener.
     *
     * On for good reason: a 10-minute cadence let a -8% stop-loss close at -13.84%
     * because price crossed the threshold between ticks. Turn it off only to fall back
     * to monitoring at screener cadence, and expect that overshoot back.
     */
    FAST_MONITOR_ENABLED: booleanish(true),

    /* ---- Pool cooldown & failure lockout (anti-churn) ---- */
    /*
     * Live paper trading showed the engine re-entering the same pool minutes after
     * closing it out of range, paying gas and forced-exit slippage on every lap. The
     * screener has no memory of its own trades, so the same pool keeps ranking first
     * and keeps failing the same way. These two gates give it that memory.
     */
    /**
     * A pool is excluded from the candidate list for this many hours after ANY of its
     * positions closes, regardless of outcome. Set to 0 to disable.
     */
    POOL_COOLDOWN_HOURS: numeric(4),
    /**
     * How many consecutive CLOSED_LOSS / CLOSED_OUT_OF_RANGE closes on one pool trip
     * the circuit breaker. The run is counted newest-first and reset by any other
     * outcome. Set to 0 to disable the lockout.
     */
    POOL_LOCKOUT_CONSECUTIVE_FAILURES: numeric(2),
    /** How long a tripped pool stays locked out, measured from its last failure. */
    POOL_LOCKOUT_HOURS: numeric(24),

    /* ---- Execution-failure guards (live path only) ---- */
    /**
     * Operator denylist: pool addresses and/or pair names, comma-separated,
     * case-insensitive.
     *
     * The escape hatch for "that pool specifically, gone" — checked before any network
     * call or swap, so a denied pool costs nothing. It lives HERE rather than being
     * read from `process.env` at the call site (which is how it first shipped) so that
     * it gets what every other setting gets: parsed once at boot, placeholder values
     * treated as unset, and a value the boot log can print. A safety gate that is
     * silently empty because of a typo is worse than no gate, because it is believed.
     */
    POOL_DENYLIST: z.string().optional().default(""),
    /**
     * How many consecutive EXECUTION failures on one pool bench it. Set to 0 to
     * disable.
     *
     * Deliberately separate from `POOL_LOCKOUT_CONSECUTIVE_FAILURES`, which counts
     * failed EXITS reconstructed from closed position rows. A failed OPEN writes no
     * row — "the chain decides, the database records" — so the V1.1 lockout is blind
     * to it by construction, and on 7 Sep 2026 the same pool was therefore re-elected
     * every 30 minutes and spent real money twice before an operator intervened. This
     * counter measures the other half: whether the engine can OPEN the pool at all.
     */
    EXECUTION_FAILURE_LOCKOUT_COUNT: numeric(2),
    /** How long a pool benched by execution failures stays benched. */
    EXECUTION_FAILURE_LOCKOUT_HOURS: numeric(24),
    /**
     * How long a pool AND ITS TOKEN stay benched after a failure that had already
     * SPENT — i.e. the balancing swap confirmed and the open then failed.
     *
     * Deliberately a SECOND knob rather than a reuse of the one above, because the two
     * measure different things. `EXECUTION_FAILURE_LOCKOUT_HOURS` governs the free
     * case, where the cluster refused a simulation and a day is a generous wait for
     * transient state to clear. This one governs the case where SOL left the wallet and
     * nothing came back: on 11 Sep 2026 three such attempts on one token burned
     * 0.0639 SOL between 02:0x and 02:31, and the pool-keyed 24h bench was the only
     * thing between that and a fourth.
     *
     * NO ZERO-DISABLE, unlike every other lockout in this file. A post-swap failure is
     * the exact outcome the breaker exists to stop repeating, and a gate an operator
     * can switch off with a typo is not a gate. Validated at or above 24 hours for the
     * same reason; the default is a week, on the argument that a token which took money
     * and produced no position is worth a human look before it is tried again.
     */
    EXECUTION_POST_SWAP_LOCKOUT_HOURS: numeric(168),

    /**
     * The 24-hour budget for FAILED live-entry attempts, in SOL. Infinity disables it.
     *
     * The 11 Sep 2026 incident left ZERO trace in the database: no position row, no
     * PnL, a clean `daily_pnl_snapshots` — and a wallet 0.0639 SOL lighter. Money that
     * leaves without producing a position is invisible to every accounting surface the
     * engine has, so the pattern can repeat until the wallet is empty with nothing
     * reporting anything wrong. `live_execution_attempts` makes the spend visible; this
     * is the number that acts on it.
     *
     * Fail-CLOSED and ENTRY-ONLY: over budget, `openLivePosition` refuses. Monitoring,
     * fee accrual and closes are untouched — holding an exit is how a stop-loss stops
     * being enforced.
     */
    LIVE_MAX_FAILED_COST_SOL: numeric(0.05),
    /** The window the budget above is measured over. */
    LIVE_FAILED_COST_WINDOW_HOURS: numeric(24),

    /**
     * Drift thresholds for the periodic wallet-vs-book reconciliation, in percent of
     * the book and in absolute SOL. EITHER being exceeded raises the alert.
     *
     * Two units because one alone is wrong at one end of the range: a percentage alone
     * never fires on a large book that has quietly lost real SOL, and an absolute alone
     * fires constantly on a small one. On 11 Sep 2026 the pinned baseline was ~$12
     * above the wallet and nothing said so.
     */
    WALLET_DRIFT_MAX_PCT: numeric(1),
    WALLET_DRIFT_MAX_SOL: numeric(0.02),
    /**
     * The SOL/USD price at which `STARTING_BALANCE_USD` was pinned. Written by the
     * OPERATOR, alongside that pin; never fetched, never defaulted.
     *
     * The drift check converts the USD book to SOL at THIS price and compares SOL to SOL.
     * Without it the only way to compare was `walletSol x spot`, which made every SOL/USD
     * move read as money leaving the wallet (11 Sep 2026: a 1.15% price dip paged
     * "-0.033474 SOL" on a wallet that had not changed by a lamport). A price guessed or
     * fetched here would re-create exactly that, so an unset value makes the check
     * report NOT MEASURED instead. Not positive is treated the same way.
     */
    BASELINE_SOL_PRICE_USD: z
      .string()
      .optional()
      .transform((v) => {
        const trimmed = v?.trim() ?? "";
        if (trimmed === "" || PLACEHOLDER.test(trimmed)) return null;
        return Number(trimmed);
      })
      .pipe(z.number().finite().nullable()),
    /**
     * The widest position, in bins, the LIVE path may open. Default 70 — narrow only.
     *
     * This is a CIRCUIT BREAKER on an execution path, not a view about what the DLMM
     * program allows. The program allows 1400 (`DLMM_MAX_BINS_PER_POSITION`) and that
     * gate still stands above this one. What this bounds is the two-phase
     * create-then-fund flow, which as of 8 Sep 2026 had never completed a single live
     * open in three real-money attempts (STONK-SOL 371 bins, SOLCAT-SOL 77, ZCAT-SOL
     * 95) while the one-transaction narrow path had never failed.
     *
     * Both defects behind those three failures are now fixed in `onchainExecutor.ts`
     * — the funding transactions were being starved of compute because the SDK
     * attaches no budget to them, and they carried a full-price `InitializeBinArray`
     * for every bin array in range whether or not it already existed. The fix is
     * proven against the chain by `scripts/reproWideFunding.cjs`, which is a builder
     * and a simulator; it has NOT yet been proven by a funded wide open. Until it is,
     * the default keeps live capital on the path with the measured success rate.
     *
     * Raising it is the sanctioned lever and costs universe coverage in the other
     * direction — 70 bins admitted 19.0% of the live 600-pool scan against 93.2% at
     * 1400. Validate one small wide open (~0.1 SOL) first, then set it to 1400.
     *
     * INERT IN PAPER MODE: the gate lives inside the live execution path and the
     * live-only candidate filter, so a dry run's candidate list is unchanged.
     */
    LIVE_MAX_POSITION_BINS: numeric(70),

    // ---- Post-trade reflection ----
    POST_MORTEM_ENABLED: booleanish(true),

    // ---- Friction / gas optimisation ----
    /**
     * Floor on the downside cover the LLM may choose, as a percentage of entry price.
     *
     * A tight range exits sooner, and every exit costs gas plus forced-exit slippage.
     * The 30-day unbiased backtest closed 62% of trades on out-of-range with gas and
     * slippage exceeding all fee income, so the range is widened by default to cut
     * churn.
     */
    MIN_DOWNSIDE_COVER_PCT: numeric(45),
    MIN_UPSIDE_COVER_PCT: numeric(15),
    /** Price concession assumed on a forced exit, used in the breakeven gate. */
    FORCED_EXIT_SLIPPAGE_PCT: numeric(2.0),
    /**
     * A pool must be expected to earn at least this multiple of its round-trip cost
     * (gas + slippage) in 24h of fees, or the entry is skipped.
     */
    MIN_FEE_COST_COVERAGE: numeric(2.5),

    /* ---- Macro-news entry blackout (live path only) ---- */
    /**
     * Whether NEW entries are skipped during a scheduled US data release (CPI, PPI,
     * NFP, FOMC). Monitoring, fee accrual and closes are never affected.
     *
     * Defaults to ON, which is the safe direction here for once: the gate reads a file
     * this repository does not write, and on a box with no calendar the read fails open
     * and warns, so an enabled-but-unfed gate costs a log line rather than an outage.
     * Leaving it OFF by default would instead mean a correctly provisioned host quietly
     * not using a calendar it is refreshing.
     *
     * INERT IN PAPER MODE regardless: the read lives behind `isLiveExecutionActive()`
     * in `runDlmmTradingCycle`, so a dry run does not open the file at all.
     */
    NEWS_BLACKOUT_ENABLED: booleanish(true),
    /**
     * Where the blackout calendar lives. Written by a Hermes cron from the NewsAgent
     * BLS/FOMC forward calendar (release -60min -> +45min) plus any ad-hoc operator
     * windows; never written by this engine.
     *
     * Resolved against `process.cwd()` like `DATABASE_PATH`, so an absolute path also
     * works — which is what the live host uses, since the cron and the engine do not
     * share a working directory.
     */
    NEWS_BLACKOUT_FILE: z.string().default("./data/news_blackout.json"),

    /* ---- Operator engine control (live path only) ---- */
    /**
     * A file that can hold NEW entries without going through Telegram.
     *
     * The kill-switch used to be Telegram-only, and on 10 Sep 2026 Telegram's intake
     * was dead for every boot — an external poller held the token and every
     * `bot.launch()` was refused with `409 Conflict` — so `/pause` did not exist.
     * `engineControl.ts` keeps its pause in MEMORY, so there was no way to hold entries
     * from outside the process at all, and `pm2 stop` is not a substitute because it
     * also stops monitoring the open positions.
     *
     * Written by an operator or by Hermes; never written by this engine. Resolved
     * against `process.cwd()` like `DATABASE_PATH` and `NEWS_BLACKOUT_FILE`, so an
     * absolute path also works — which is what the live host uses, since the writer and
     * the engine do not share a working directory.
     *
     * INERT IN PAPER MODE: the read lives behind `isLiveExecutionActive()` in
     * `runDlmmTradingCycle`, so a dry run does not open the file at all.
     */
    ENGINE_CONTROL_FILE: z.string().default("./data/engine_control.json"),

    // Database
    DATABASE_PATH: z.string().default("./data/flowmetrix.db"),
  })
  .superRefine((cfg, ctx) => {
    /*
     * `DRY_RUN=false` is now supported: Stage 1 (signing, priority fees, send/confirm,
     * Jupiter) and Stage 2 (the DLMM adapter) are both implemented, and the engine is
     * wired to them through `src/services/liveExecution.ts`.
     *
     * What replaced the blanket refusal is a narrower one. Live mode needs BOTH
     * switches: `DRY_RUN=false` says the engine should trade for real, and
     * `ONCHAIN_EXECUTION_ARMED=true` says the executor may sign. Half of that pair is
     * always a misconfiguration, and the dangerous half is silent — an engine that
     * believes it is live while nothing can sign would take entry decisions, fail to
     * execute them, and (before this) still write rows describing positions that do
     * not exist. Refusing to boot is the same reasoning the original refusal had; only
     * the condition changed.
     */
    if (!cfg.DRY_RUN && !armedInEnvironment()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["DRY_RUN"],
        message:
          "DRY_RUN=false requires ONCHAIN_EXECUTION_ARMED=true. Live trading needs an " +
          "executor that can actually sign; arming only one of the two would leave the " +
          "engine believing it trades live while every execution fails.",
      });
    }
    if (!cfg.DRY_RUN && !cfg.SOLANA_PRIVATE_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["SOLANA_PRIVATE_KEY"],
        message: "DRY_RUN=false requires SOLANA_PRIVATE_KEY: live trading must be able to sign.",
      });
    }
    if (cfg.TAKE_PROFIT_PCT <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["TAKE_PROFIT_PCT"],
        message: "TAKE_PROFIT_PCT must be positive.",
      });
    }
    if (cfg.STOP_LOSS_PCT >= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["STOP_LOSS_PCT"],
        message: "STOP_LOSS_PCT must be negative (e.g. -8).",
      });
    }
    for (const key of [
      "POOL_COOLDOWN_HOURS",
      "POOL_LOCKOUT_HOURS",
      "POOL_LOCKOUT_CONSECUTIVE_FAILURES",
      "EXECUTION_FAILURE_LOCKOUT_COUNT",
      "EXECUTION_FAILURE_LOCKOUT_HOURS",
      "LIVE_FAILED_COST_WINDOW_HOURS",
      "WALLET_DRIFT_MAX_PCT",
      "WALLET_DRIFT_MAX_SOL",
    ] as const) {
      if (cfg[key] < 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} must be zero or positive (zero disables the gate).`,
        });
      }
    }
    /*
     * Zero is NOT a neutral value here, and unlike the gates above it cannot mean
     * "disabled": a cap of zero bins admits no position at all, so the engine would
     * screen, decide and then refuse every entry while reporting itself healthy. A
     * cap above the program's own 1400-bin maximum is equally meaningless — that
     * gate binds first — so it is refused rather than silently clamped.
     */
    if (cfg.LIVE_MAX_POSITION_BINS < 1 || cfg.LIVE_MAX_POSITION_BINS > 1400) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["LIVE_MAX_POSITION_BINS"],
        message:
          "LIVE_MAX_POSITION_BINS must be between 1 and 1400 (the DLMM one-position " +
          "maximum). 70 is narrow-only, the path with a measured success rate.",
      });
    }
    /*
     * No zero-disable, and a hard 24h floor. See the setting's own note: a post-swap
     * failure is the outcome the breaker exists to stop repeating, so "off" is not one
     * of the values an operator should be able to reach through a typo, and 24 hours is
     * the minimum the 11 Sep 2026 incident settled on.
     */
    if (cfg.EXECUTION_POST_SWAP_LOCKOUT_HOURS < 24) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["EXECUTION_POST_SWAP_LOCKOUT_HOURS"],
        message:
          "EXECUTION_POST_SWAP_LOCKOUT_HOURS must be at least 24. A failure that " +
          "already spent SOL is not a gate to switch off.",
      });
    }
    /*
     * Infinity is the documented way to disable the failed-cost breaker. Zero is not:
     * it would block every entry the moment one lamport of failure was measured, while
     * reading like "no budget configured".
     */
    if (cfg.LIVE_MAX_FAILED_COST_SOL <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["LIVE_MAX_FAILED_COST_SOL"],
        message:
          "LIVE_MAX_FAILED_COST_SOL must be positive. Use Infinity to disable the " +
          "failed-attempt cost breaker; zero would refuse every entry.",
      });
    }
  });

export type AppEnv = z.infer<typeof EnvSchema>;

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("\n");
  console.error(`\n[env] Invalid environment configuration:\n${details}\n`);
  console.error("[env] Copy .env.example to .env and fill in the values.\n");
  process.exit(1);
}

export const env: AppEnv = parsed.data;

/**
 * True when the process is allowed to touch real funds.
 *
 * Both switches, never one. `DRY_RUN=false` is the engine's intent;
 * `ONCHAIN_EXECUTION_ARMED=true` is the executor's consent. The env schema refuses to
 * boot on either half alone, so by the time this is read the pair is already coherent
 * — this constant restates the condition rather than deciding it.
 *
 * Read straight from `process.env` rather than from `env`, because
 * `ONCHAIN_EXECUTION_ARMED` belongs to the executor's own schema in
 * `services/onchainExecutor.ts`, and importing that module here would put the signer
 * back into the engine's import graph through the config layer — the exact edge the
 * isolation test exists to police.
 */
export const isLiveTradingEnabled: boolean = !env.DRY_RUN && armedInEnvironment();

export const hasDeepSeek = Boolean(env.DEEPSEEK_API_KEY);
export const hasTelegram = Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID);
