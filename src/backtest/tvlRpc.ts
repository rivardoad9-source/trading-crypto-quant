/**
 * Which RPC endpoint the on-chain TVL reads go to.
 *
 * The default is `SOLANA_RPC_URL` from `.env` — and on the live host there is ONE `.env`, which
 * the pm2 engine reads too. So a default ingest spends the same provider key the engine monitors
 * positions and runs its authority checks with: the first run drew HTTP 429 on 6 of 8 calls, and
 * the engine logged a 429 "authority check unavailable" that cost it a candidate. A stop-loss
 * that cannot read a price is the expensive version of that. `--tvl-rpc-url` lets the ingest run
 * on a key of its own without touching `.env`.
 *
 * Three rules:
 * - Absent flag = exactly the `.env` URL, so every existing run is unchanged.
 * - A given-but-unusable value THROWS, and is resolved before any ingest starts: a typo must
 *   not surface two hours in, and it must never fall back to the engine's key silently.
 * - The URL carries the provider key in its path or query, so nothing here returns it for
 *   printing — errors name the problem, logs name the HOST only.
 */

export type TvlRpcSource = "flag" | "env";

export interface TvlRpc {
  /** The full URL. Pass it to fetch; never to a log line, a file, or an Error. */
  url: string;
  /** Host only (`mainnet.helius-rpc.com`) — the one part safe to print. */
  host: string;
  source: TvlRpcSource;
  /** True when the flag was given but names the same endpoint `.env` does: nothing is separated. */
  sameAsEnv: boolean;
}

export const TVL_RPC_FLAG = "tvl-rpc-url";

/**
 * Reads `--tvl-rpc-url=<url>` or `--tvl-rpc-url <url>` from raw argv. The repo's flag parsers
 * only understand the `=` form and would store the space form as "true", dropping the URL — which
 * `resolveTvlRpc` then refuses — so this reads both. Undefined when the flag is absent.
 */
export function readTvlRpcUrlArg(argv: readonly string[]): string | undefined {
  let value: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.toLowerCase().startsWith(`--${TVL_RPC_FLAG}=`)) value = arg.slice(TVL_RPC_FLAG.length + 3);
    else if (arg.toLowerCase() === `--${TVL_RPC_FLAG}`) {
      const next = argv[i + 1];
      value = next !== undefined && !next.startsWith("--") ? next : "";
      if (next !== undefined && !next.startsWith("--")) i++;
    }
  }
  return value;
}

/** Host of a URL for printing; never the path or query, where the key lives. */
export function rpcHostOf(url: string): string {
  try {
    return new URL(url).host || "unparseable-url";
  } catch {
    return "unparseable-url";
  }
}

/** Resolves the TVL endpoint. Throws on a given-but-invalid flag; messages never contain the value. */
export function resolveTvlRpc(flagValue: string | undefined, envUrl: string): TvlRpc {
  if (flagValue === undefined) return { url: envUrl, host: rpcHostOf(envUrl), source: "env", sameAsEnv: false };
  const raw = flagValue.trim();
  const usage = `--${TVL_RPC_FLAG} needs a full http(s) URL, e.g. --${TVL_RPC_FLAG}=https://<host>/?api-key=<key> (quote it in a shell)`;
  if (raw === "" || raw === "true") throw new Error(`--${TVL_RPC_FLAG} was given without a value. ${usage}`);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`--${TVL_RPC_FLAG} is not a parseable URL (value not printed: it may carry a key). ${usage}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`--${TVL_RPC_FLAG} must be http or https, got "${parsed.protocol.replace(/:$/, "").slice(0, 16)}". ${usage}`);
  }
  if (!parsed.hostname) throw new Error(`--${TVL_RPC_FLAG} has no host. ${usage}`);
  return { url: raw, host: parsed.host, source: "flag", sameAsEnv: raw === envUrl.trim() };
}

/** The one line a run prints about its TVL endpoint. Host and source only. */
export function describeTvlRpc(rpc: TvlRpc): string {
  const source = rpc.source === "flag" ? "(dari --tvl-rpc-url)" : "(default .env — key yang SAMA dengan engine live kalau satu .env)";
  const warn = rpc.sameAsEnv ? " · PERINGATAN: --tvl-rpc-url sama persis dengan SOLANA_RPC_URL di .env, tidak ada yang dipisahkan" : "";
  return `[tvl] RPC host ${rpc.host} ${source}${warn}`;
}
