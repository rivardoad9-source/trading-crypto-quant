/**
 * Token-2022 mint extensions, as far as the ENTRY path needs them.
 *
 * WHY THIS EXISTS — 13 Sep 2026, −0.079110 SOL of real money.
 *
 * The engine tried to open `NEARKAT-SOL` and the token turned out to be a Token-2022
 * mint carrying a **3% transfer fee** (`TransferFeeConfig`, 300 bps). A transfer fee is
 * charged on EVERY transfer of the token, so a round trip pays it twice: the balancing
 * swap in, the sell-back out. Measured on chain: −0.901586 SOL in, +0.822476 SOL back =
 * **8.77% of a 0.9 SOL swap**, against a +5% take-profit. Nothing in the funnel looked
 * at the mint's extensions — the friction gate models gas + slippage and the anti-rug
 * screen reads authorities and holders — so a pool the strategy can NEVER profit from
 * cleared every gate and was elected.
 *
 * Three extension facts are worth refusing a pool over, and all three are the same
 * shape: a third party, not the pool's price, decides how much value the token takes or
 * whether it can move at all. The exit path has to be unconditional.
 *
 *  - `TransferFeeConfig`   a tax on every transfer, both legs of the round trip.
 *  - `TransferHook`        every transfer is routed through someone else's program,
 *                          which can refuse or gate it. A position whose exit depends on
 *                          a stranger's program is not a position the engine can close.
 *  - `NonTransferable`     transfers are forbidden outright, so the sell-back can never
 *                          land and the LP position has no exit by swap.
 *
 * Decoded from the RAW account bytes rather than the provider's `jsonParsed` view on
 * purpose: the layout is fixed by the Token-2022 program, a raw decode cannot be
 * re-worded by an RPC upgrade, and it is testable offline with synthetic bytes.
 */
import { getRawAccount } from "./solana.js";

/** The program that owns Token-2022 mints (and their extended accounts). */
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

/** 82-byte `Mint` base + padding to 165 + one AccountType byte. TLV entries follow. */
const TOKEN_2022_FIXED_LENGTH = 166;

/** Extension type ids from the Token-2022 spec. */
const EXT_TRANSFER_FEE_CONFIG = 1;
const EXT_NON_TRANSFERABLE = 9;
const EXT_TRANSFER_HOOK = 14;

/**
 * `TransferFeeConfig`: two 32-byte authorities + an 8-byte withheld amount + two
 * fee records of (u64 epoch, u64 maximumFee, u16 basisPoints) = 108 bytes.
 */
const TRANSFER_FEE_CONFIG_LENGTH = 108;
const FEE_BPS_OFFSET_IN_RECORD = 16;
const OLDER_RECORD_OFFSET = 72;
const NEWER_RECORD_OFFSET = 90;

export interface TokenExtensionReading {
  /**
   * Basis points of the transfer fee, as the WORSE of the two configured records
   * (older and newer). 0 = no transfer fee.
   *
   * `max` rather than "pick by epoch" deliberately: choosing the epoch-correct record
   * needs a second RPC call, and picking WRONG in the permissive direction would admit
   * exactly the pool this module exists to refuse. A token whose fee is switched off
   * today and on tomorrow is refused today, which is the safe side of that error.
   */
  transferFeeBps: number;
  /** The mint routes every transfer through a third-party program. */
  hasTransferHook: boolean;
  /** The mint forbids transfers entirely. */
  nonTransferable: boolean;
}

/**
 * Reads the three facts above out of a mint account's raw bytes.
 *
 * Throws on data it cannot parse — a truncated Token-2022 account, or a TLV entry that
 * overruns the account. Throwing is the point: the caller treats "could not read" as a
 * refusal, so malformed data must not be silently reported as "no fee".
 *
 * A classic SPL mint (82 bytes, `Tokenkeg…`) cannot carry extensions and reads as
 * fee-free, which is a genuine measurement rather than an assumption: the transfer-fee
 * machinery does not exist in that program.
 */
export function decodeTokenExtensionReading(
  data: Uint8Array,
  ownerProgram: string,
): TokenExtensionReading {
  const reading: TokenExtensionReading = {
    transferFeeBps: 0,
    hasTransferHook: false,
    nonTransferable: false,
  };

  if (ownerProgram !== TOKEN_2022_PROGRAM) return reading;
  if (data.length < TOKEN_2022_FIXED_LENGTH) {
    throw new Error(
      `a Token-2022 mint account is at least ${TOKEN_2022_FIXED_LENGTH} bytes, got ${data.length}`,
    );
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = TOKEN_2022_FIXED_LENGTH;

  while (offset + 4 <= data.length) {
    const type = view.getUint16(offset, true);
    const length = view.getUint16(offset + 2, true);
    if (type === 0 && length === 0) break; // end of the TLV region
    const start = offset + 4;
    const end = start + length;
    if (end > data.length) {
      throw new Error(
        `the Token-2022 extension ${type} claims ${length} bytes but the account ends ${end - data.length} byte(s) early`,
      );
    }

    if (type === EXT_TRANSFER_FEE_CONFIG) {
      reading.transferFeeBps = Math.max(
        reading.transferFeeBps,
        readFeeBps(data.subarray(start, end)),
      );
    } else if (type === EXT_TRANSFER_HOOK) {
      reading.hasTransferHook = true;
    } else if (type === EXT_NON_TRANSFERABLE) {
      reading.nonTransferable = true;
    }

    offset = end;
  }

  return reading;
}

/** The worse of the two `TransferFee` records inside one `TransferFeeConfig` entry. */
function readFeeBps(entry: Uint8Array): number {
  if (entry.length < TRANSFER_FEE_CONFIG_LENGTH) {
    throw new Error(
      `TransferFeeConfig is ${TRANSFER_FEE_CONFIG_LENGTH} bytes, got ${entry.length}`,
    );
  }
  const view = new DataView(entry.buffer, entry.byteOffset, entry.byteLength);
  const older = view.getUint16(OLDER_RECORD_OFFSET + FEE_BPS_OFFSET_IN_RECORD, true);
  const newer = view.getUint16(NEWER_RECORD_OFFSET + FEE_BPS_OFFSET_IN_RECORD, true);
  return Math.max(older, newer);
}

export interface TokenFeeVerdict {
  blocked: boolean;
  /** Why the pool was refused, in the words the operator will read in the log. */
  reason: string | null;
}

/**
 * The entry-screen verdict for one mint.
 *
 * FAIL-CLOSED: a mint whose extensions cannot be read is REFUSED, never assumed
 * fee-free. The asymmetry is deliberate and matches the anti-rug screen — an unreadable
 * mint is an unknown, and an unknown is not evidence of a clean token.
 *
 * `maxTransferFeeBps` comes from `LIVE_MAX_TOKEN_TRANSFER_FEE_BPS`, default 0, i.e. any
 * transfer fee at all is refused. The knob exists so the operator can decide to pay a
 * small known tax later; it is not a value to raise casually, because the fee is paid on
 * both legs and the strategy's take-profit is 5%.
 */
export async function assessTokenFeeScreen(
  mint: string,
  maxTransferFeeBps: number,
  read: (mint: string) => Promise<TokenExtensionReading> = readTokenExtensionsCached,
): Promise<TokenFeeVerdict> {
  let reading: TokenExtensionReading;
  try {
    reading = await read(mint);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      blocked: true,
      reason:
        `could not read the mint's Token-2022 extensions (${detail}); refusing the pool ` +
        `— an unreadable mint cannot be proven free of a transfer fee`,
    };
  }

  if (reading.nonTransferable) {
    return {
      blocked: true,
      reason:
        "Token-2022 non-transferable mint: transfers are forbidden, so the sell-back at " +
        "exit can never land and the position has no way out by swap",
    };
  }

  if (reading.hasTransferHook) {
    return {
      blocked: true,
      reason:
        "Token-2022 transfer hook: every transfer is routed through a third-party " +
        "program that can gate or refuse it, so the exit depends on code this engine " +
        "does not control",
    };
  }

  if (reading.transferFeeBps > maxTransferFeeBps) {
    return {
      blocked: true,
      reason:
        `Token-2022 transfer fee ${reading.transferFeeBps / 100}% ` +
        `(${reading.transferFeeBps} bps) over the ${maxTransferFeeBps / 100}% ` +
        `(${maxTransferFeeBps} bps) limit — the fee is charged on BOTH legs of the ` +
        `round trip, and the take-profit cannot clear it`,
    };
  }

  return { blocked: false, reason: null };
}

/*
 * The read, cached briefly.
 *
 * One pool routinely has several sibling pools for the same token, and the funnel can
 * meet the same mint two or three times inside one cycle. The extension set of a mint is
 * effectively immutable for the life of a trade, so a short TTL removes the repeat calls
 * without ever hiding a token that was minted with a fee from the start.
 */
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { at: number; reading: TokenExtensionReading }>();

/** Exported for tests and for anything that must not read a stale verdict. */
export function clearTokenExtensionCache(): void {
  cache.clear();
}

export async function readTokenExtensions(mint: string): Promise<TokenExtensionReading> {
  const account = await getRawAccount(mint);
  if (account === null) throw new Error(`account ${mint} does not exist`);
  return decodeTokenExtensionReading(account.data, account.owner);
}

async function readTokenExtensionsCached(mint: string): Promise<TokenExtensionReading> {
  const hit = cache.get(mint);
  const now = Date.now();
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.reading;

  const reading = await readTokenExtensions(mint);
  cache.set(mint, { at: now, reading });
  return reading;
}
