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

    // Database
    DATABASE_PATH: z.string().default("./data/flowmetrix.db"),
  })
  .superRefine((cfg, ctx) => {
    // Live mode is deliberately not implemented. Refuse to boot rather than half-arm it.
    if (!cfg.DRY_RUN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["DRY_RUN"],
        message:
          "DRY_RUN=false is not supported: live execution is not implemented. " +
          "This engine is paper-trading only and never signs a Solana transaction.",
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
    ] as const) {
      if (cfg[key] < 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} must be zero or positive (zero disables the gate).`,
        });
      }
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

/** True when the process is allowed to touch real funds. Always false in this build. */
export const isLiveTradingEnabled = false as const;

export const hasDeepSeek = Boolean(env.DEEPSEEK_API_KEY);
export const hasTelegram = Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID);
