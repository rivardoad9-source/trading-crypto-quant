/**
 * Outside-the-pool forensics for the token a signal is about.
 *
 * The scanner's fee estimate comes from pool stats: 24h fees / TVL. That number assumes
 * the volume is real. Two free endpoints tell us whether it is:
 *
 *   Jupiter (lite-api)  - per-window volume split into organic vs total, holder count,
 *                         authority state, and the dev wallet's mint history.
 *   RugCheck            - LP locked share, insider networks, risk flags, raw top holders.
 *
 * No API keys, no wallet, no signing. Nothing here can place or close anything - it only
 * decides what the card is allowed to claim.
 *
 * The single most useful field is `organicShare24h`. A "26x TVL daily volume" pool that
 * turns out to be 11% organic is not a fee machine; it is a bot washing volume that can
 * stop inside one hour. `organicFee24hUsd` restates the engine's fee estimate using only
 * the organic slice, which is the number worth trusting.
 */

export interface TokenForensics {
  mint: string;
  /** organic / total volume, 0..1. Null when the source has no data for the window. */
  organicShare24h: number | null;
  organicShare1h: number | null;
  volume24hUsd: number | null;
  organicVolume24hUsd: number | null;
  organicScore: number | null;
  organicLabel: string | null;
  lpLockedPct: number | null;
  rugged: boolean | null;
  rugScore: number | null;
  rugRisks: string[];
  insiderNetworks: number | null;
  topHolderPct: number | null;
  holderCount: number | null;
  mintAuthorityOff: boolean | null;
  freezeAuthorityOff: boolean | null;
  devMints: number | null;
  devMigrations: number | null;
  launchpad: string | null;
  /* ---- GMGN: the only source that answers "can you sell it at all?" ---- */
  honeypot: boolean | null;
  buyTaxPct: number | null;
  sellTaxPct: number | null;
  canNotSell: boolean | null;
  lpBurned: boolean | null;
  gmgnTop10Pct: number | null;
  gmgnFlags: string[];
  /** False when GMGN could not be reached — the card says so instead of staying quiet. */
  gmgnChecked: boolean;
  /** Machine-readable warnings; the card turns these into Indonesian sentences. */
  flags: string[];
}

export interface JupiterToken {
  id?: string;
  holderCount?: number;
  organicScore?: number;
  organicScoreLabel?: string;
  liquidity?: number;
  launchpad?: string;
  audit?: {
    mintAuthorityDisabled?: boolean;
    freezeAuthorityDisabled?: boolean;
    topHoldersPercentage?: number;
    devMints?: number;
    devMigrations?: number;
  };
  stats1h?: { buyVolume?: number; sellVolume?: number; buyOrganicVolume?: number; sellOrganicVolume?: number };
  stats24h?: { buyVolume?: number; sellVolume?: number; buyOrganicVolume?: number; sellOrganicVolume?: number };
}

export interface RugCheckReport {
  score?: number;
  rugged?: boolean;
  totalHolders?: number;
  graphInsidersDetected?: number;
  /**
   * The live API returns an array of networks. A plain count is also accepted so a
   * recorded fixture (or a future response shape) cannot silently turn this flag off.
   */
  insiderNetworks?: unknown[] | number;
  risks?: Array<{ name?: string }>;
  markets?: Array<{ lp?: { lpLockedPct?: number } }>;
}

/**
 * GMGN's security payload. Numbers arrive as strings ("0.1505"), flags as 0/1, so every
 * field is parsed rather than trusted; anything unparseable becomes null, never a default.
 */
export interface GmgnSecurityReport {
  honeypot?: number | string | boolean | null;
  buy_tax?: number | string | null;
  sell_tax?: number | string | null;
  can_not_sell?: number | string | null;
  burn_status?: string | null;
  renounced_mint?: boolean | null;
  renounced_freeze_account?: boolean | null;
  top_10_holder_rate?: number | string | null;
  flags?: string[] | null;
  lock_summary?: {
    is_locked?: boolean;
    lock_detail?: Array<{ percent?: number | string | null }> | null;
    left_lock_percent?: number | string | null;
  } | null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Same, but also accepts the numeric strings GMGN sends. */
const numAny = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

/** Percentages arrive as fractions; float noise (0.1505 * 100) must not reach the ledger. */
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

const bool01 = (v: unknown): boolean | null => {
  if (typeof v === "boolean") return v;
  const n = numAny(v);
  return n === null ? null : n > 0;
};

/** LP locked share from GMGN, where "burned" is the strongest form of locked. */
export function gmgnLpLockedPct(g: GmgnSecurityReport | null): number | null {
  if (!g) return null;
  if (g.burn_status === "burn") return 100;
  const detail = g.lock_summary?.lock_detail ?? [];
  const pcts = detail.map((d) => numAny(d?.percent)).filter((n): n is number => n !== null);
  if (pcts.length > 0) return round4(Math.max(...pcts) * 100);
  const left = numAny(g.lock_summary?.left_lock_percent);
  if (left === null) return null;
  return left <= 1 ? round4(left * 100) : left;
}

/** How many insider networks RugCheck reported, from whichever shape it sent. */
function insiderCount(rc: RugCheckReport | null): number | null {
  if (!rc) return null;
  if (Array.isArray(rc.insiderNetworks)) return rc.insiderNetworks.length;
  return num(rc.insiderNetworks) ?? num(rc.graphInsidersDetected);
}

/** Indonesian thousands/decimal separator, matching the rest of the signal card. */
const idNum = (v: number, digits = 0): string =>
  v.toLocaleString("id-ID", { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** organic volume / total volume for one window, or null when the window is empty. */
export function organicShare(window: {
  buyVolume?: number;
  sellVolume?: number;
  buyOrganicVolume?: number;
  sellOrganicVolume?: number;
} | undefined): number | null {
  if (!window) return null;
  const total = (window.buyVolume ?? 0) + (window.sellVolume ?? 0);
  if (total <= 0) return null;
  const organic = (window.buyOrganicVolume ?? 0) + (window.sellOrganicVolume ?? 0);
  return organic / total;
}

/**
 * Pure assessment of the two payloads, so it can be tested against captured responses
 * instead of against the network.
 */
export function assessForensics(
  mint: string,
  jup: JupiterToken | null,
  rc: RugCheckReport | null,
  gmgn: GmgnSecurityReport | null = null,
): TokenForensics {
  const s24 = jup?.stats24h;
  const volume24h = s24 ? (s24.buyVolume ?? 0) + (s24.sellVolume ?? 0) : null;
  const share24 = organicShare(s24);
  const share1 = organicShare(jup?.stats1h);

  // GMGN knows about burned LP, which RugCheck reports as a lock; either is fine, and the
  // burned reading is stronger, so it wins when both are present.
  const lpLocked = gmgnLpLockedPct(gmgn) ?? num(rc?.markets?.[0]?.lp?.lpLockedPct);
  const rawTop10 = numAny(gmgn?.top_10_holder_rate);
  const top10 = rawTop10 === null ? null : round4(rawTop10 * 100);

  const f: TokenForensics = {
    mint,
    organicShare24h: share24,
    organicShare1h: share1,
    volume24hUsd: volume24h,
    organicVolume24hUsd: share24 !== null && volume24h !== null ? share24 * volume24h : null,
    organicScore: num(jup?.organicScore),
    organicLabel: jup?.organicScoreLabel ?? null,
    lpLockedPct: lpLocked,
    rugged: typeof rc?.rugged === "boolean" ? rc.rugged : null,
    rugScore: num(rc?.score),
    rugRisks: (rc?.risks ?? []).map((r) => r.name).filter((n): n is string => Boolean(n)),
    insiderNetworks: insiderCount(rc),
    topHolderPct: num(jup?.audit?.topHoldersPercentage),
    holderCount: num(jup?.holderCount) ?? num(rc?.totalHolders),
    mintAuthorityOff: jup?.audit?.mintAuthorityDisabled ?? null,
    freezeAuthorityOff: jup?.audit?.freezeAuthorityDisabled ?? null,
    devMints: num(jup?.audit?.devMints),
    devMigrations: num(jup?.audit?.devMigrations),
    launchpad: jup?.launchpad ?? null,
    honeypot: gmgn ? bool01(gmgn.honeypot) : null,
    buyTaxPct: numAny(gmgn?.buy_tax),
    sellTaxPct: numAny(gmgn?.sell_tax),
    canNotSell: gmgn ? bool01(gmgn.can_not_sell) : null,
    lpBurned: gmgn ? gmgn.burn_status === "burn" : null,
    gmgnTop10Pct: top10,
    gmgnFlags: Array.isArray(gmgn?.flags) ? gmgn!.flags!.map(String) : [],
    gmgnChecked: gmgn !== null,
    flags: [],
  };

  if (f.rugged) f.flags.push("rugged");
  if (f.lpLockedPct !== null && f.lpLockedPct < 50) f.flags.push("lp-not-locked");
  if (f.lpLockedPct === null) f.flags.push("lp-lock-unknown");
  // The one that matters most: can a holder actually get out?
  if (f.honeypot === true || f.canNotSell === true) f.flags.push("honeypot");
  if (f.sellTaxPct !== null && f.sellTaxPct > 5) f.flags.push("sell-tax");
  if ((f.buyTaxPct ?? 0) + (f.sellTaxPct ?? 0) > 10) f.flags.push("high-tax");
  if (f.honeypot === false && f.canNotSell === false && f.sellTaxPct === 0) f.flags.push("sellable");
  if (gmgn?.renounced_mint === false) f.flags.push("mint-authority-live");
  if (gmgn?.renounced_freeze_account === false) f.flags.push("freeze-authority-live");
  if (!f.gmgnChecked) f.flags.push("gmgn-unavailable");
  if (f.rugRisks.length > 0) f.flags.push("rugcheck-risks");
  if (f.mintAuthorityOff === false) f.flags.push("mint-authority-live");
  if (f.freezeAuthorityOff === false) f.flags.push("freeze-authority-live");
  if (f.insiderNetworks !== null && f.insiderNetworks > 0) f.flags.push("insider-networks");
  if (Math.max(f.topHolderPct ?? 0, f.gmgnTop10Pct ?? 0) > 30) f.flags.push("holders-concentrated");
  // A wallet with dozens of migrations behind it is a token factory, not a team.
  if (f.devMigrations !== null && f.devMigrations >= 10) f.flags.push("serial-launcher");
  if (f.organicShare24h !== null && f.organicShare24h < 0.25) f.flags.push("mostly-inorganic-volume");
  if (f.organicShare24h !== null && f.organicShare24h < 0.10) f.flags.push("inorganic-volume");

  return f;
}

/**
 * Restate a fee estimate using only volume real users produced.
 *
 * The engine's figure is the honest one for "what does this pool pay per unit of TVL",
 * but if nine tenths of the volume is bots that can leave, that figure is not a forecast.
 * Reporting both is the point; the smaller one is the one to plan around.
 */
export function organicFee(fee24hUsd: number | null, forensics: TokenForensics | null): number | null {
  if (fee24hUsd === null || !forensics || forensics.organicShare24h === null) return null;
  return fee24hUsd * Math.min(1, forensics.organicShare24h);
}

const JUP = "https://lite-api.jup.ag/tokens/v2/search?query=";
const RC = "https://api.rugcheck.xyz/v1/tokens/";

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(9_000),
      headers: { "user-agent": "flowmetrix-signal-scanner/1.0" },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

const GMGN_URL = "https://openapi.gmgn.ai/v1/token/security";
/** Free tier bans the IP for a minute if asked too fast; one call per ENTER, well spaced. */
const GMGN_MIN_INTERVAL_MS = 4_000;
let lastGmgnCall = 0;
let gmgnBlockedUntilMs = 0;

/**
 * GMGN security: honeypot, buy/sell tax, LP burn, authority state, top-10 share.
 *
 * Returns null on any failure, including the rate-limit ban (`RATE_LIMIT_BANNED`), whose
 * `reset_at` is respected so one scan cannot dig the IP deeper into the hole. Null is not
 * silently treated as "clean": the assessment records `gmgnChecked = false` and the card
 * says the check did not happen.
 */
export async function fetchGmgnSecurity(mint: string): Promise<GmgnSecurityReport | null> {
  const key = process.env.GMGN_API_KEY;
  if (!key || !mint || mint.length < 30) return null;
  if (Date.now() < gmgnBlockedUntilMs) return null;

  const wait = GMGN_MIN_INTERVAL_MS - (Date.now() - lastGmgnCall);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastGmgnCall = Date.now();

  try {
    const url =
      `${GMGN_URL}?chain=sol&address=${mint}` +
      `&timestamp=${Math.floor(Date.now() / 1000)}&client_id=${Math.floor(Math.random() * 1e8)}`;
    const res = await fetch(url, {
      headers: { "X-APIKEY": key, "user-agent": "flowmetrix-signal-scanner/1.0" },
      signal: AbortSignal.timeout(9_000),
    });
    if (res.status === 429) {
      const body = (await res.json().catch(() => null)) as { reset_at?: number } | null;
      const resetAt = typeof body?.reset_at === "number" ? body.reset_at * 1_000 : Date.now() + 120_000;
      gmgnBlockedUntilMs = Math.max(gmgnBlockedUntilMs, resetAt);
      return null;
    }
    if (!res.ok) return null;
    const body = (await res.json()) as { code?: number; data?: GmgnSecurityReport };
    if (body.code !== 0 || !body.data) return null;
    return body.data;
  } catch {
    return null;
  }
}

export async function fetchTokenForensics(mint: string): Promise<TokenForensics | null> {
  const [jupRaw, rcRaw, gmgn] = await Promise.all([
    getJson<JupiterToken[]>(JUP + encodeURIComponent(mint)),
    getJson<RugCheckReport>(RC + encodeURIComponent(mint) + "/report"),
    fetchGmgnSecurity(mint),
  ]);
  const jup = Array.isArray(jupRaw) ? (jupRaw.find((t) => t.id === mint) ?? jupRaw[0] ?? null) : null;
  if (!jup && !rcRaw && !gmgn) return null;
  return assessForensics(mint, jup, rcRaw, gmgn);
}

const CACHE_PATH = process.env.FM_FORENSICS_CACHE ?? "/home/ubuntu/.hermes/data/fm_forensics_cache.json";
const CACHE_TTL_MS = 6 * 3600 * 1000;
/** Bump when TokenForensics gains fields, so stale entries are refetched, not served. */
const CACHE_VERSION = 2;
/** A result without the GMGN half is worth keeping for minutes, not hours — retry sooner. */
const PARTIAL_TTL_MS = 20 * 60 * 1000;

/**
 * Same as `fetchTokenForensics`, but a mint is only looked up once every six hours.
 *
 * The scan runs every 20 minutes and would otherwise ask both services about the same token
 * all day; these are free endpoints and the polite thing is to not hammer them. A stale
 * entry is still used when the network fails, because a slightly old risk profile beats
 * a card with no risk section at all.
 */
export async function fetchTokenForensicsCached(
  mint: string,
  now: number = Date.now(),
): Promise<{ forensics: TokenForensics | null; cached: boolean }> {
  const { readFileSync, writeFileSync, mkdirSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  let cache: Record<string, { ts: number; v?: number; data: TokenForensics }> = {};
  try {
    cache = JSON.parse(readFileSync(CACHE_PATH, "utf8")) as typeof cache;
  } catch {
    cache = {};
  }

  // Entries written before a schema change lack the fields the card reads; a version
  // stamp keeps them from being served as if they were current.
  const hit = cache[mint]?.v === CACHE_VERSION ? cache[mint] : undefined;
  const ttl = hit?.data?.gmgnChecked ? CACHE_TTL_MS : PARTIAL_TTL_MS;
  if (hit && now - hit.ts < ttl) return { forensics: hit.data, cached: true };

  const fresh = await fetchTokenForensics(mint);
  if (!fresh) return { forensics: hit?.data ?? null, cached: Boolean(hit) };

  cache[mint] = { ts: now, v: CACHE_VERSION, data: fresh };
  try {
    mkdirSync(dirname(CACHE_PATH), { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 1));
  } catch {
    /* cache is a courtesy, never a failure */
  }
  return { forensics: fresh, cached: false };
}

export function describeForensics(f: TokenForensics): string[] {
  const lines: string[] = [];
  if (f.organicShare24h !== null && f.volume24hUsd !== null && f.organicVolume24hUsd !== null) {
    lines.push(`Volume asli (organik) 24 jam: ${idNum(f.organicShare24h * 100, 1)}% — $${idNum(f.organicVolume24hUsd)} dari $${idNum(f.volume24hUsd)}`);
  }
  if (f.lpLockedPct !== null) {
    lines.push(
      `Likuiditas pool terkunci: ${idNum(f.lpLockedPct, 1)}%` +
        (f.holderCount !== null ? ` · ${idNum(f.holderCount)} pemegang` : "") +
        (f.topHolderPct !== null ? ` · 10 besar ${idNum(f.topHolderPct, 1)}%` : ""),
    );
  }
  if (f.devMigrations !== null && f.devMints !== null) {
    lines.push(`Dompet pembuat: ${idNum(f.devMints)} token pernah dibuat, ${idNum(f.devMigrations)} migrasi`);
  }
  if (f.insiderNetworks !== null && f.insiderNetworks > 0) {
    lines.push(`Jaringan insider terdeteksi: ${idNum(f.insiderNetworks)}`);
  }
  if (f.gmgnChecked) {
    const out = f.honeypot === true || f.canNotSell === true ? "⚠️ bisa beli, belum tentu bisa jual" : "bisa dijual";
    const lp = f.lpBurned ? "LP dibakar 100%" : f.lpLockedPct !== null ? `LP ${idNum(f.lpLockedPct, 1)}% terkunci` : "status LP tidak jelas";
    lines.push(`Jual-beli: ${out} · pajak jual ${idNum(f.sellTaxPct ?? 0, 1)}% · ${lp}`);
  } else if (lines.length > 0) {
    // Only worth saying when there is a token section to qualify: with no data at all the
    // card shows nothing, and this line would be a section of one meaningless sentence.
    lines.push("Jual-beli: belum diperiksa (GMGN sedang tidak bisa dihubungi)");
  }
  if (f.rugRisks.length > 0) lines.push(`Bendera RugCheck: ${f.rugRisks.slice(0, 3).join(" · ")}`);
  else if (f.rugScore !== null) lines.push(`Bendera RugCheck: tidak ada (skor ${idNum(f.rugScore)})`);
  return lines;
}
