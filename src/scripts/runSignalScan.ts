/**
 * SIGNAL-ONLY SCAN — nothing here signs anything.
 *
 * One shot of the engine's own funnel (scan → screen → anti-rug → volatility →
 * breakeven gate → LLM decision) rendered as a chat card instead of an order. Built
 * for the next phase after the 22 Sep pause, where automated LP execution was retired
 * in favour of signals a human can act on — or ignore.
 *
 * Safety by construction, three layers:
 *   1. `DRY_RUN=true` is forced BELOW, before any module is imported, so
 *      `isLiveTradingEnabled` (and therefore `isLiveExecutionActive`) is false for the
 *      whole process. `openLivePosition` is never reached; `liveOutcome` stays null.
 *   2. `ONCHAIN_EXECUTION_ARMED=false` is forced too. Belt and braces: even if someone
 *      later flips `DRY_RUN` back, `env.ts` refuses to boot with `DRY_RUN=false` and no
 *      arming, so the "signal" tool still cannot become a trading tool by accident.
 *   3. `LIVE_MICRO_CAPITAL=false` moves sizing onto the paper path
 *      (`VIRTUAL_SOL_PER_POSITION`), so a signal is never suppressed because the wallet
 *      happens to be empty — the failure mode that made the live engine report "no
 *      capital available" while the screener was working fine.
 *
 * It uses a scratch database by default (`data/signals.db`), because the funnel ends by
 * inserting the position row it decided on. Keeping that in its own file means signal
 * scanning never writes a PAPER row into the engine's book, and never inherits the
 * engine's cooldown/capacity state. Point `FM_SIGNAL_DB` elsewhere to override.
 *
 * Usage:
 *   node --import tsx src/scripts/runSignalScan.ts          # human card (Indonesian)
 *   node --import tsx src/scripts/runSignalScan.ts --json   # payload for the gate script
 *
 * Exit code is 0 whether or not a signal was produced — "no signal today" is a normal
 * outcome, not a failure a cron wrapper should alert on.
 */

process.env.DRY_RUN = "true";
process.env.ONCHAIN_EXECUTION_ARMED = "false";
process.env.LIVE_MICRO_CAPITAL = "false";
process.env.DATABASE_PATH = process.env.FM_SIGNAL_DB ?? "./data/signals.db";
/*
 * Blank the engine's Telegram credentials before any engine module loads.
 *
 * The funnel still announces every paper row it writes through services/telegram.ts —
 * "🟢 PAPER POSITION OPENED (DRY-RUN)", hard-coded English, a different template from the
 * gate's card. That alert reaching the same chat as the card is a second, older message
 * about the same signal, and the operator reads it as "the bot is still off-template".
 *
 * `hasTelegram` is computed once, at import time, from these two variables, so clearing
 * them here (before the dynamic imports below) makes every engine dispatch a no-op log
 * line. This path must never own an outbound channel: the gate's card is the only thing
 * the operator is supposed to receive.
 */
process.env.TELEGRAM_BOT_TOKEN = "";
process.env.TELEGRAM_CHAT_ID = "";

const { initDatabase, closeDatabase, db } = await import("../database/db.js");
const { seekNewEntry } = await import("../agents/dlmmTraderAgent.js");
const { fetchPoolByAddress } = await import("../services/meteora.js");
const { fetchPoolPriceChanges } = await import("../services/marketData.js");
const { isLiveExecutionActive } = await import("../config/liveConfig.js");
const { env } = await import("../config/env.js");
const { assessBinRange, binRangeCardLines } = await import("../services/binRange.js");
const { fetchTokenForensicsCached, describeForensics, organicFee } = await import("../services/tokenForensics.js");
const { structuredCompletion, isDeepSeekAvailable } = await import("../services/deepseek.js");
const { isTelegramEnabled } = await import("../services/telegram.js");
const { z } = await import("zod");
const { appendFileSync, mkdirSync } = await import("node:fs");
const { dirname } = await import("node:path");

if (isLiveExecutionActive()) {
  // Unreachable while the three switches above hold. If it ever fires, the forced env
  // did not apply (a bundler hoisting imports, say) and continuing would mean a scan
  // running under a live profile — the one thing this tool must never do.
  console.error("[signal] refusing to run: live execution is ACTIVE in this process.");
  process.exit(2);
}

const asJson = process.argv.includes("--json");

/**
 * Whether the engine's own Telegram channel is live inside this process.
 *
 * It must be false: the funnel's alerts ("🟢 PAPER POSITION OPENED (DRY-RUN)") are a second,
 * older template, and an operator who gets both them and the gate's card reads the bot as
 * broken. The credentials are blanked above; this is the assertion that the blanking worked
 * (a bundler hoisting imports, or someone reordering the file, would break it silently).
 */
const engineTelegramEnabled = isTelegramEnabled();
if (engineTelegramEnabled) {
  console.error(
    "[signal] WARNING: engine Telegram is ENABLED in the scan path — its legacy alert " +
      "template would reach the operator alongside the card.",
  );
}

/** Sentinel markers around the --json payload; see the note at the writer further down. */
const SIGNAL_JSON_BEGIN = "===SIGNAL_JSON_BEGIN===";
const SIGNAL_JSON_END = "===SIGNAL_JSON_END===";

/** Indonesian number formatting: 57651.97 → "57.652", 0.094454 → "0,0945". */
const fmtNum = (n: number | null | undefined, digits = 2): string =>
  n === null || n === undefined
    ? "—"
    : n.toLocaleString("id-ID", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const fmtUsd = (n: number | null | undefined): string =>
  n === null || n === undefined ? "—" : `$${fmtNum(n)}`;
const fmtSol = (n: number | null | undefined): string =>
  n === null || n === undefined ? "—" : `${fmtNum(n, 4)} SOL`;
const fmtCompact = (n: number | null | undefined): string =>
  n === null || n === undefined
    ? "—"
    : n >= 1_000_000
      ? `$${fmtNum(n / 1_000_000, 2)} Jt`
      : n >= 1_000
        ? `$${fmtNum(n / 1_000, 1)} rb`
        : `$${fmtNum(n)}`;
/** Signed percentage for price moves: 3.14 → "+3,1%", -2 → "−2,0%". */
const fmtPct = (n: number | null | undefined): string =>
  n === null || n === undefined ? "—" : `${n >= 0 ? "+" : "−"}${fmtNum(Math.abs(n), 1)}%`;

initDatabase();

/*
 * Statelessness. The funnel ends by inserting the row for the position it decided on, and
 * this tool has no monitor to ever close it — so three entries would fill the paper book
 * and every later scan would answer "at capacity" instead of looking at the market. The
 * row is dropped before each scan; the JSONL ledger further down is the record that
 * survives. The filename guard is deliberate: if someone points `FM_SIGNAL_DB` at a real
 * book, this refuses to touch it rather than silently emptying it.
 */
const scratchDb = /signals(\.[^/\\]*)?\.db$/.test(env.DATABASE_PATH);
if (scratchDb) {
  const cleared = db.prepare("DELETE FROM simulated_positions").run();
  if (cleared.changes > 0) {
    console.error(`[signal] cleared ${cleared.changes} paper row(s) from the scratch book (stateless scan)`);
  }
} else {
  console.error(
    `[signal] WARNING: DATABASE_PATH (${env.DATABASE_PATH}) does not look like a scratch signal ` +
      `database — leaving its position book untouched. Set FM_SIGNAL_DB if this is not what you meant.`,
  );
}

/**
 * The numbers of the decision the funnel just made (fee estimate, round-trip cost, safety
 * verdict, bin prices). `seekNewEntry` keeps them internally and returns only the summary,
 * so they are read straight off the row it wrote — the same numbers the live engine would
 * have acted on, not a second estimate that could disagree with them.
 */
type PaperRow = {
  pair_name: string;
  entry_price: number;
  lower_bin_price: number;
  upper_bin_price: number;
  virtual_sol_amount: number;
  breakeven_coverage_ratio: number | null;
  expected_fee_24h_usd: number | null;
  est_gas_cost_usd: number | null;
  safety_verdict: string | null;
  top10_holder_pct: number | null;
  mint_authority_revoked: number | null;
  freeze_authority_revoked: number | null;
};

function latestPaperRow(): PaperRow | null {
  try {
    const row = db
      .prepare(
        `SELECT pair_name, entry_price, lower_bin_price, upper_bin_price, virtual_sol_amount,
                breakeven_coverage_ratio, expected_fee_24h_usd, est_gas_cost_usd,
                safety_verdict, top10_holder_pct, mint_authority_revoked, freeze_authority_revoked
           FROM simulated_positions
          ORDER BY rowid DESC
          LIMIT 1`,
      )
      .get() as PaperRow | undefined;
    return row ?? null;
  } catch (err) {
    // A card without the supporting numbers is still a useful card; a crash here is not.
    console.error(`[signal] could not read the paper row: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

let summary: Awaited<ReturnType<typeof seekNewEntry>>;
let paperRow: PaperRow | null = null;
try {
  summary = await seekNewEntry();
  paperRow = latestPaperRow();
} finally {
  // The scan itself is done; the DB handle only exists so `seekNewEntry` could read
  // cooldowns and write its row. Closing before any network work below keeps the
  // connection lifetime to the part that needs it.
  closeDatabase();
}

const decision = summary.decision;
const entered = Boolean(decision && decision.action === "ENTER" && decision.selectedPool !== "NONE");

/*
 * The pool's live metrics are re-read for the card. `seekNewEntry` holds them internally
 * but does not return them, and a signal that does not say what the pool looks like NOW
 * is a signal nobody can judge in the five seconds they will give it.
 */
const pool = entered ? await fetchPoolByAddress(decision!.selectedPool, { quiet: true }).catch(() => null) : null;

/*
 * Price movement for the chosen pool, from the same feed the volatility gate reads. It is
 * not part of what `seekNewEntry` returns, and "is it dumping right now" is the first thing
 * anyone asks of a signal — so it is fetched here rather than inferred from the range.
 */
const priceChange =
  entered && decision
    ? ((await fetchPoolPriceChanges([decision.selectedPool]).catch(() => new Map())).get(
        decision.selectedPool,
      ) ?? null)
    : null;

const stamp = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta", hour12: false });
const notionalSol = entered ? env.VIRTUAL_SOL_PER_POSITION : null;

const feeEst = paperRow?.expected_fee_24h_usd ?? null;
const coverage = paperRow?.breakeven_coverage_ratio ?? null;

/*
 * What the pool's own stats cannot know: whether the volume paying those fees is real.
 * Fetched only when a signal actually fires, and cached for six hours, so a normal scan
 * costs nothing extra. `organicFee24h` is the same fee estimate restricted to the volume
 * Jupiter considers organic — the number to plan around when the two disagree.
 */
const forensicsResult =
  entered && pool?.baseMint ? await fetchTokenForensicsCached(pool.baseMint) : { forensics: null, cached: false };
const forensics = forensicsResult.forensics;
const organicFee24h = organicFee(feeEst, forensics);

/*
 * Whether the promised range physically fits, and what it costs in bin rent — see
 * `services/binRange.ts` for the derivation and the numbers it is checked against.
 *
 * The short version: bins are geometric, so the same "-45%" needs 61 bins on a step-100
 * pool but 300 on step 20 and ~3 000 on step 2, against a 1 400-bin program cap. On a
 * fine-step pool the advertised depth can be silently unreachable, and bin rent (a
 * refundable 0.075 SOL per 70-bin array) can tie up more SOL than the position itself.
 */
const downPct = entered ? Math.abs(decision!.binRangeDownsideCoverPct ?? 0) : 0;
const upPct = entered ? Math.abs(decision!.binRangeUpsideCoverPct ?? 0) : 0;
const binRange =
  entered && pool && pool.binStep > 0
    ? assessBinRange({
        downPct,
        upPct,
        binStep: pool.binStep,
        binCap: env.LIVE_MAX_POSITION_BINS,
      })
    : null;
/*
 * The round trip the cost gate actually priced, recovered as `fee ÷ ratio`.
 *
 * Not `est_gas_cost_usd`: that column holds network fees only (fractions of a cent) while the
 * gate compares against the full round trip — gas plus swap legs plus the ATA work. A first
 * version preferred the column whenever it was non-zero and produced "biaya $0,00" beside a
 * positive fee estimate, i.e. it made trading look free and the net-day figure look like the
 * whole fee estimate. The gate's own ratio is the number that decided the signal, so it is
 * the number the operator sees.
 */
const cost =
  coverage && coverage > 0 && feeEst !== null
    ? feeEst / coverage
    : paperRow?.est_gas_cost_usd && paperRow.est_gas_cost_usd > 0
      ? paperRow.est_gas_cost_usd
      : null;
/**
 * Hours of fees needed to pay for the round trip. It is the cost gate's own ratio turned
 * around (2.67× of a day's fees ⇒ ~9 hours), so the card cannot claim a faster break-even
 * than the gate that let the signal through.
 */
const breakEvenHours = coverage && coverage > 0 ? 24 / coverage : null;

/** Strategy names, in words an operator can act on rather than jargon. */
const STRATEGY_ID: Record<string, string> = {
  SPOT: "dua sisi seimbang",
  BID_ASK: "tumpuk beli di bawah, jual di atas",
  CURVE: "rapat, untuk pasar yang kalem",
};

/*
 * The model's own reasoning, rewritten for a human. The engine's prompt makes it write in
 * English and in the register of a risk memo; pasting that into a Telegram card is how a
 * signal ends up looking like a log line. One cheap chat call, only for signals that are
 * actually about to be shown (max 3 a day), and a plain fallback when it is unavailable —
 * a signal must never be withheld because a summariser failed.
 */
const RINGKASAN_SCHEMA = z.object({
  kenapa: z.string().max(500).describe("Alasan masuk, 2 kalimat, bahasa Indonesia"),
  risiko: z.string().max(300).describe("Risiko utama, 1 kalimat, bahasa Indonesia"),
});

async function ringkasUntukOperator(): Promise<{ kenapa: string; risiko: string }> {
  const fallback = {
    kenapa:
      "Pool ini masih menghasilkan fee yang cukup besar dibanding biaya masuk dan keluar, " +
      "dan lolos semua pemeriksaan keamanan token.",
    risiko:
      `Kalau harga bergerak keluar dari rentang ${fmtNum(decision?.binRangeDownsideCoverPct, 0)}% ke bawah ` +
      `atau ${fmtNum(decision?.binRangeUpsideCoverPct, 0)}% ke atas, posisi berhenti dapat fee dan kena biaya keluar.`,
  };
  if (!decision || !isDeepSeekAvailable()) return fallback;
  try {
    return await structuredCompletion({
      system:
        "Kamu menulis ringkasan untuk trader Indonesia. Gaya: santai tapi jelas, seperti menjelaskan " +
        "ke teman. Aturan: bahasa Indonesia, maksimal 2 kalimat untuk 'kenapa' dan 1 kalimat untuk " +
        "'risiko', tanpa istilah teknis Inggris (jangan pakai kata: pool, range, TVL, fee, APR, IL, " +
        "liquidity, slippage, breakeven), tanpa membuka dengan 'Pool ini' atau sapaan, langsung ke inti. " +
        // The word below is load-bearing: the API rejects `response_format: json_object`
        // unless the prompt itself mentions JSON, and the refusal costs a retry every call.
        // Naming the keys matters too — without it the model answers with `alasan`/`risiko`
        // often enough to fail schema validation on the first attempt.
        'Balas dalam format JSON dengan kunci "kenapa" dan "risiko".',
      user:
        `Alasan asli dari model (Inggris): ${decision.thesis}\n\n` +
        `Data pendukung: pasangan ${decision.pairName}, harga masuk ${fmtNum(pool?.currentPrice ?? paperRow?.entry_price, 6)}, ` +
        `nilai likuiditas ${fmtUsd(pool?.tvlUsd)}, volume 24 jam ${fmtUsd(pool?.volume24hUsd)}, ` +
        `perkiraan hasil sehari ${fmtUsd(paperRow?.expected_fee_24h_usd)}, biaya buka+tutup ${fmtUsd(paperRow?.est_gas_cost_usd)}.`,
      schema: RINGKASAN_SCHEMA,
      reasoning: false,
      maxTokens: 500,
    });
  } catch (err) {
    console.error(`[signal] ringkasan gagal: ${err instanceof Error ? err.message : err}`);
    return fallback;
  }
}

const lines: string[] = [];
lines.push(entered && decision ? `🎯 SINYAL — ${decision.pairName}` : "🔎 SCAN — belum ada sinyal");
lines.push(`${stamp} WIB · mode uji, uang sungguhan nol`);
lines.push("");

if (entered && decision) {
  const kenapa = await ringkasUntukOperator();

  lines.push(`Harga masuk    : ${fmtNum(pool?.currentPrice ?? paperRow?.entry_price, 6)}`);
  lines.push(
    `Rentang aman   : turun maks ${fmtNum(decision.binRangeDownsideCoverPct, 0)}% · ` +
      `naik maks ${fmtNum(decision.binRangeUpsideCoverPct, 0)}%` +
      // The headline must not promise a depth the pool's bin step cannot build; the
      // detail (bins needed vs cap, and why) is in the pool-condition block below.
      (binRange && !binRange.fits && binRange.deepestRealPct !== null
        ? ` (di pool ini cuma muat ~${fmtNum(binRange.deepestRealPct, 1)}% turun)`
        : ""),
  );
  lines.push(`Gaya posisi    : ${STRATEGY_ID[decision.strategy] ?? decision.strategy}`);
  lines.push(`Modal uji      : ${fmtSol(notionalSol)} — virtual, bukan saldo lu`);
  lines.push(`Keyakinan model: ${decision.confidenceScore} dari 100`);
  lines.push("");
  lines.push(`Kenapa: ${kenapa.kenapa}`);
  lines.push(`Risiko: ${kenapa.risiko}`);
  lines.push("");

  /*
   * Kondisi pool. The pace figure — the last hour projected over a day, against the 24h
   * average — is the cheap tell for "is this pool cooling off right now". A pool whose
   * volume has already gone by the time the signal lands is one nobody should stand by for,
   * and the screener alone cannot say that: it ranks on the 24h number.
   */
  const kondisi: string[] = [];
  if (pool) {
    kondisi.push(
      `Umur ${fmtNum(pool.ageHours / 24, 0)} hari · likuiditas ${fmtCompact(pool.tvlUsd)} · ` +
        `transaksi 24 jam ${fmtCompact(pool.volume24hUsd)}`,
    );
    if (pool.volume24hUsd > 0) {
      const pace = (pool.volume1hUsd * 24) / pool.volume24hUsd;
      const label = pace >= 1.3 ? "lebih ramai dari biasanya" : pace >= 0.7 ? "masih stabil" : "mulai sepi";
      kondisi.push(`Kesibukan sekarang ${fmtNum(pace, 2)}× rata-rata harian — ${label}`);
    }
    if (priceChange && (priceChange.h1 !== null || priceChange.h24 !== null)) {
      kondisi.push(
        `Pergerakan harga: 1 jam ${fmtPct(priceChange.h1)} · 24 jam ${fmtPct(priceChange.h24)}`,
      );
    }
    /*
     * Range feasibility and bin rent. Reported for every signal, not only the failures:
     * "muat" is the answer most of the time, and a line that is usually reassuring is
     * what makes the occasional truncation warning readable rather than noise.
     */
    if (binRange) {
      for (const line of binRangeCardLines(binRange, downPct, upPct)) kondisi.push(line);
    }
  }
  if (feeEst !== null) {
    kondisi.push(
      `Untung sehari ${fmtUsd(feeEst)} vs biaya buka+tutup ${fmtUsd(cost)}` +
        (coverage !== null ? ` — ${fmtNum(coverage, 2)}× lipat dari biaya` : ""),
    );
  }
  if (paperRow?.top10_holder_pct !== null && paperRow?.top10_holder_pct !== undefined) {
    const aman =
      paperRow.mint_authority_revoked === 1 && paperRow.freeze_authority_revoked === 1
        ? "pemilik token tidak bisa mencetak token baru atau membekukan saldo"
        : "ada izin token yang belum dicabut — baca lagi sebelum masuk";
    kondisi.push(`10 pemegang terbesar ${fmtNum(paperRow.top10_holder_pct, 1)}% · ${aman}`);
  }
  if (kondisi.length > 0) {
    lines.push("Kondisi pool saat ini:");
    for (const k of kondisi) lines.push(`• ${k}`);
    lines.push("");
  }

  /*
   * Token checks from outside the pool. The pool stats say what the volume pays; these
   * two free endpoints say whether the volume is real, who holds the LP, and how many
   * tokens the creator's wallet has already walked away from.
   */
  const luar = forensics ? describeForensics(forensics) : [];
  if (forensics && organicFee24h !== null && feeEst !== null && forensics.organicShare24h !== null) {
    if (forensics.organicShare24h < 0.5) {
      luar.push(
        `⚠️ Kalau cuma volume asli yang dihitung: untung sehari ± ${fmtUsd(organicFee24h)}, ` +
          `bukan ${fmtUsd(feeEst)} — sisanya dagang bot yang bisa berhenti kapan saja`,
      );
    }
  }
  if (forensics?.flags.includes("rugged")) luar.push("⚠️ RugCheck menandai token ini pernah rug");
  if (forensics?.flags.includes("lp-not-locked")) luar.push("⚠️ Likuiditas pool belum terkunci penuh");
  if (forensics?.flags.includes("lp-lock-unknown")) luar.push("⚠️ Status kunci likuiditas tidak diketahui");
  if (forensics?.flags.includes("serial-launcher")) {
    luar.push("⚠️ Dompet pembuat ini pabrik token — bukan tim yang jaga satu proyek");
  }
  if (forensics?.flags.includes("mint-authority-live") || forensics?.flags.includes("freeze-authority-live")) {
    luar.push("⚠️ Masih ada izin token yang hidup — mint/freeze belum dicabut");
  }
  if (luar.length > 0) {
    lines.push(`Pemeriksaan token, sumber luar${forensicsResult.cached ? " (data cache)" : ""}:`);
    for (const k of luar) lines.push(`• ${k}`);
    lines.push("");
  }

  /*
   * Rencana standby — how long this is worth watching, and what ends it.
   *
   * The holding estimate is arithmetic, not a promise: the cost gate already priced how
   * many days of fees it takes to cover the round trip (the coverage ratio), so break-even
   * is 24/coverage hours, and a full day at the modelled fee rate is what the position would
   * show. The two exit prices are the bin bounds the engine would have used. The check
   * cadence is derived from the break-even time: the faster a position pays for itself, the
   * faster it can also turn, so the operator's attention is scheduled by the same number.
   */
  const cekSetiapJam =
    breakEvenHours === null ? 4 : breakEvenHours <= 6 ? 2 : breakEvenHours <= 12 ? 3 : breakEvenHours <= 24 ? 4 : 6;

  const standby: string[] = [];
  if (breakEvenHours !== null) {
    standby.push(`Balik modal biaya ± ${fmtNum(breakEvenHours, 1)} jam kalau aktivitasnya bertahan`);
  }
  if (feeEst !== null && cost !== null) {
    standby.push(`Kalau seramai ini sehari penuh: untung bersih ± ${fmtUsd(feeEst - cost)}`);
  }
  standby.push(`Cek posisi tiap ± ${cekSetiapJam} jam`);
  if (paperRow?.lower_bin_price && paperRow.upper_bin_price) {
    standby.push(
      `Keluar kalau harga tembus ${fmtNum(paperRow.lower_bin_price, 6)} (bawah) atau ` +
        `${fmtNum(paperRow.upper_bin_price, 6)} (atas) — tembus dan bertahan, bukan cuma nyentuh`,
    );
  }
  if (cost !== null) {
    standby.push(`Keluar kalau untung harian turun di bawah ${fmtUsd(cost)}`);
  }
  /*
   * Give-back rule, structure taken from the dlmmbot repo's calibrated exit set
   * (config.toml, "Give-back stop", give_back_keep_frac = 0.75; their replay measured
   * +2.657 SOL over 120 closes). Their number is theirs — what is worth copying is the
   * shape: once a position has been up, do not ride the whole give-back down to the fee
   * floor, leave at three quarters. Phrased as a rule the operator applies by eye, since
   * this card is written before entry and has no peak to measure yet.
   *
   * "Fee yang belum diklaim tidak dihitung" is the same repo's audit finding: 6 of their 7
   * stop-loss triggers had already paid fees out, so a fee-inclusive mark made stops fire
   * on positions that were in profit (stop_loss_count_claimed_fees = false).
   */
  standby.push(
    "Kalau harga sempat naik: keluar saat untung tinggal 75% dari puncaknya, jangan tunggu balik ke nol",
  );
  standby.push("Hitung untung cuma dari fee yang sudah diklaim — fee nggantung bukan untung");
  lines.push("Rencana standby:");
  for (const s of standby) lines.push(`• ${s}`);
} else {
  /*
   * Not delivered to anyone — this branch exists for the ledger, the digest and anyone
   * reading the log. It speaks in the same plain language anyway, so that "why was there
   * no signal for three days" is answered without opening another tool.
   */
  const reason = summary.skipReason ?? "model menolak tanpa alasan yang dicatat";
  const reasonId = reason.startsWith("no candidate clears the breakeven gate")
    ? "Tidak ada kandidat yang hasilnya cukup untuk menutup biaya masuk dan keluar."
    : reason.startsWith("model declined")
      ? "Model menolak semua kandidat yang tersisa."
      : reason;
  lines.push(`Kesimpulan: ${reasonId}`);

  if (summary.breakevenRejected.length > 0) {
    lines.push("");
    lines.push("Hampir lolos, tapi biayanya belum tertutup:");
    for (const r of summary.breakevenRejected.slice(0, 3)) {
      lines.push(
        `• ${r.pairName} — untung sehari ${fmtUsd(r.expectedFee24hUsd)}, biaya masuk+keluar ` +
          `${fmtUsd(r.roundTripCostUsd)}: baru ${fmtNum(r.coverageRatio, 2)}× (minimal ` +
          `${fmtNum(env.MIN_FEE_COST_COVERAGE, 1)}×)`,
      );
    }
  }
}

lines.push("");
lines.push(
  `Alur penyaringan: ${summary.scanned} kandidat diperiksa → ${summary.screenerCandidates} lolos ` +
    `saringan awal → ${summary.safeCandidates} lolos pemeriksaan keamanan → ${entered ? 1 : 0} lolos uji biaya`,
);
const dropped = [
  ["keamanan token", summary.rugRejected.length],
  ["sedang naik terlalu tajam", summary.volatilityRejected.length],
  ["struktur pemegang token", summary.gmgnRejected.length],
  ["baru saja dipakai", summary.cooldownRejected.length],
  ["konsentrasi pemegang", summary.concentrationFlagged.length],
  ["biaya", summary.breakevenRejected.length],
].filter(([, n]) => (n as number) > 0);
if (dropped.length > 0) {
  lines.push(`Gugur karena: ${dropped.map(([why, n]) => `${why} ${n}`).join(" · ")}`);
}
lines.push("");
lines.push("Tidak ada yang dieksekusi — ini pemberitahuan, bukan perintah.");

/*
 * The signal ledger. One JSON line per scan, whether or not it produced an entry, so the
 * hit rate and the hypothetical outcome can be scored later without re-running anything.
 * Kept next to the scratch DB, in its own file, so the gate script and a future scorecard
 * can read it without opening SQLite.
 */
mkdirSync(dirname(env.DATABASE_PATH), { recursive: true });
appendFileSync(
  process.env.FM_SIGNAL_LEDGER ?? "./data/signal-ledger.jsonl",
  JSON.stringify({
    ts: new Date().toISOString(),
    action: entered ? "ENTER" : "SKIP",
    pairName: decision?.pairName ?? null,
    poolAddress: decision?.selectedPool === "NONE" ? null : (decision?.selectedPool ?? null),
    strategy: decision?.strategy ?? null,
    downsideCoverPct: decision?.binRangeDownsideCoverPct ?? null,
    upsideCoverPct: decision?.binRangeUpsideCoverPct ?? null,
    confidence: decision?.confidenceScore ?? null,
    thesis: decision?.thesis ?? null,
    notionalSol,
    entryPrice: pool?.currentPrice ?? paperRow?.entry_price ?? null,
    lowerBinPrice: paperRow?.lower_bin_price ?? null,
    upperBinPrice: paperRow?.upper_bin_price ?? null,
    tvlUsd: pool?.tvlUsd ?? null,
    binStep: pool?.binStep ?? null,
    expectedFee24hUsd: paperRow?.expected_fee_24h_usd ?? null,
    roundTripCostUsd: paperRow?.est_gas_cost_usd ?? null,
    coverageRatio: paperRow?.breakeven_coverage_ratio ?? null,
    breakEvenHours,
    priceChange1hPct: priceChange?.h1 ?? null,
    priceChange24hPct: priceChange?.h24 ?? null,
    poolAgeHours: pool?.ageHours ?? null,
    volume1hUsd: pool?.volume1hUsd ?? null,
    /** Must be false. A true here means the operator got the engine's legacy alert too. */
    engineTelegramEnabled,
    /**
     * Pools that got all the way to the cost gate and only lost on arithmetic. These are
     * the counterfactual set: the scorecard replays what each one did afterwards, which is
     * the only way to tell a strict gate from a broken one.
     */
    nearMisses: summary.breakevenRejected.slice(0, 5).map((r) => ({
      pairName: r.pairName,
      poolAddress: r.poolAddress,
      priceUsd: r.priceUsd,
      coverageRatio: r.coverageRatio,
    })),
    /**
     * Outside-the-pool checks on the token itself. `organicShare24h` is the one that
     * decides whether the fee estimate above is a forecast or a mirage.
     */
    forensics: forensics
      ? {
          organicShare24h: forensics.organicShare24h,
          organicFee24hUsd: organicFee24h,
          lpLockedPct: forensics.lpLockedPct,
          holderCount: forensics.holderCount,
          topHolderPct: forensics.topHolderPct,
          devMints: forensics.devMints,
          devMigrations: forensics.devMigrations,
          insiderNetworks: forensics.insiderNetworks,
          rugScore: forensics.rugScore,
          flags: forensics.flags,
        }
      : null,
    /* Range physics, from the dlmmbot formulas: does the promised depth fit in bins at all,
     * and how much refundable bin rent does it tie up. */
    binRange: binRange
      ? {
          binsNeeded: binRange.binsNeeded,
          binCap: binRange.binCap,
          fits: binRange.fits,
          deepestRealPct: binRange.deepestRealPct,
          binArrays: binRange.binArrays,
          binRentSol: binRange.binRentSol,
        }
      : null,
    skipReason: summary.skipReason ?? null,
    funnel: {
      scanned: summary.scanned,
      screenerCandidates: summary.screenerCandidates,
      candidates: summary.candidates,
      safeCandidates: summary.safeCandidates,
      breakevenRejected: summary.breakevenRejected.length,
      rugRejected: summary.rugRejected.length,
      volatilityRejected: summary.volatilityRejected.length,
    },
  }) + "\n",
);

if (asJson) {
  /*
   * Markers, not a bare JSON blob: the migration notices and the `[db] ready` line above
   * are written to stdout by modules that know nothing about this flag, so a caller that
   * parses "the whole of stdout" fails. The gate script reads between the markers.
   */
  console.log(SIGNAL_JSON_BEGIN);
  console.log(JSON.stringify({ summary, card: lines.join("\n"), engineTelegramEnabled }));
  console.log(SIGNAL_JSON_END);
} else {
  console.log(lines.join("\n"));
}

export {};
