/**
 * The Token-2022 transfer-fee screen — 13 Sep 2026, 0.079110 SOL.
 *
 * `NEARKAT-SOL` was elected with a paired mint carrying a 300 bps transfer fee. The
 * balancing swap went out (0.901586 SOL), the open failed, and the sell-back returned
 * 0.822476 — 8.77% of the swap, against a 5% take-profit. The pool could not have been
 * profitable at any momentum; nothing in the funnel looked at the mint's extensions.
 *
 * Everything here is offline: the decoder reads raw bytes, and the screen takes its
 * reader as an argument, so the fail-closed branches are exercised without a node.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TOKEN_2022_PROGRAM,
  assessTokenFeeScreen,
  decodeTokenExtensionReading,
} from "../services/tokenExtensions.js";
import type { TokenExtensionReading } from "../services/tokenExtensions.js";

const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

/** 82-byte `Mint` + padding to 165 + the AccountType byte. TLV entries follow. */
const TOKEN_2022_FIXED_LENGTH = 166;
const TRANSFER_FEE_CONFIG = 1;
const NON_TRANSFERABLE = 9;
const TRANSFER_HOOK = 14;

interface Tlv {
  type: number;
  data: Uint8Array;
}

function tlv(type: number, length: number, fill: (view: DataView) => void): Tlv {
  const data = new Uint8Array(length);
  fill(new DataView(data.buffer));
  return { type, data };
}

/** A `TransferFeeConfig` entry with the given basis points in BOTH records. */
function transferFeeConfig(bps: number): Tlv {
  return tlv(TRANSFER_FEE_CONFIG, 108, (view) => {
    // 32B authority + 32B withdraw authority + 8B withheld amount, then two records of
    // (u64 epoch, u64 maximumFee, u16 basisPoints).
    view.setUint16(72 + 16, bps, true);
    view.setUint16(90 + 16, bps, true);
  });
}

/** A mint account: the fixed region followed by the given extension entries. */
function mintAccount(extensions: Tlv[]): Uint8Array {
  const tlvBytes = extensions.flatMap((e) => {
    const out = new Uint8Array(4 + e.data.length);
    const view = new DataView(out.buffer);
    view.setUint16(0, e.type, true);
    view.setUint16(2, e.data.length, true);
    out.set(e.data, 4);
    return [out];
  });
  const total = TOKEN_2022_FIXED_LENGTH + tlvBytes.reduce((n, b) => n + b.length, 0);
  const account = new Uint8Array(total);
  account[165] = 1; // AccountType::Mint
  let offset = TOKEN_2022_FIXED_LENGTH;
  for (const bytes of tlvBytes) {
    account.set(bytes, offset);
    offset += bytes.length;
  }
  return account;
}

describe("Token-2022 mint extension decoder", () => {
  it("reads a classic SPL mint as fee-free rather than assuming", () => {
    /*
     * The transfer-fee machinery does not exist in the classic program, so this is a
     * measurement and not a default: an 82-byte mint owned by Tokenkeg cannot carry the
     * extension even if the bytes are there.
     */
    const reading = decodeTokenExtensionReading(
      mintAccount([transferFeeConfig(300)]),
      SPL_TOKEN_PROGRAM,
    );
    assert.deepEqual(reading, {
      transferFeeBps: 0,
      hasTransferHook: false,
      nonTransferable: false,
    });
  });

  it("reads a Token-2022 mint with no extensions as fee-free", () => {
    const reading = decodeTokenExtensionReading(
      new Uint8Array(TOKEN_2022_FIXED_LENGTH),
      TOKEN_2022_PROGRAM,
    );
    assert.equal(reading.transferFeeBps, 0);
    assert.equal(reading.hasTransferHook, false);
    assert.equal(reading.nonTransferable, false);
  });

  it("reads the 300 bps the NEARKAT mint actually carried", () => {
    const reading = decodeTokenExtensionReading(
      mintAccount([transferFeeConfig(300)]),
      TOKEN_2022_PROGRAM,
    );
    assert.equal(reading.transferFeeBps, 300);
  });

  it("takes the WORSE of the two fee records", () => {
    /*
     * `older` 0 and `newer` 500: an epoch switch is pending, and picking the
     * epoch-correct record needs a second RPC call. Choosing wrong in the permissive
     * direction would admit exactly the pool this screen exists to refuse, so the
     * maximum is the only safe collapse of the two.
     */
    const entry = tlv(TRANSFER_FEE_CONFIG, 108, (view) => {
      view.setUint16(72 + 16, 0, true);
      view.setUint16(90 + 16, 500, true);
    });
    assert.equal(
      decodeTokenExtensionReading(mintAccount([entry]), TOKEN_2022_PROGRAM).transferFeeBps,
      500,
    );
  });

  it("sees a transfer hook and a non-transferable mint", () => {
    const hook = decodeTokenExtensionReading(
      mintAccount([tlv(TRANSFER_HOOK, 64, () => {})]),
      TOKEN_2022_PROGRAM,
    );
    assert.equal(hook.hasTransferHook, true);

    const frozen = decodeTokenExtensionReading(
      mintAccount([tlv(NON_TRANSFERABLE, 0, () => {})]),
      TOKEN_2022_PROGRAM,
    );
    assert.equal(frozen.nonTransferable, true);
  });

  it("walks past extensions it does not care about", () => {
    // MetadataPointer (18) and TokenMetadata (19) are what a real mint carries next to
    // the fee config; they must not stop the walk or be mistaken for it.
    const reading = decodeTokenExtensionReading(
      mintAccount([
        tlv(18, 64, () => {}),
        transferFeeConfig(300),
        tlv(19, 32, () => {}),
      ]),
      TOKEN_2022_PROGRAM,
    );
    assert.equal(reading.transferFeeBps, 300);
  });

  it("throws on data it cannot trust instead of reporting 'no fee'", () => {
    assert.throws(
      () => decodeTokenExtensionReading(new Uint8Array(100), TOKEN_2022_PROGRAM),
      /at least 166 bytes/,
    );

    // An entry that claims more bytes than the account holds.
    const account = mintAccount([transferFeeConfig(300)]);
    const view = new DataView(account.buffer);
    view.setUint16(TOKEN_2022_FIXED_LENGTH + 2, 4096, true);
    assert.throws(
      () => decodeTokenExtensionReading(account, TOKEN_2022_PROGRAM),
      /but the account ends/,
    );

    // A TransferFeeConfig entry too short to hold its own layout.
    assert.throws(
      () =>
        decodeTokenExtensionReading(
          mintAccount([tlv(TRANSFER_FEE_CONFIG, 40, () => {})]),
          TOKEN_2022_PROGRAM,
        ),
      /TransferFeeConfig is 108 bytes/,
    );
  });
});

describe("the entry screen built on it", () => {
  const feeFree: TokenExtensionReading = {
    transferFeeBps: 0,
    hasTransferHook: false,
    nonTransferable: false,
  };

  it("refuses any transfer fee at the shipped limit of 0 bps", async () => {
    const verdict = await assessTokenFeeScreen("mint", 0, async () => ({
      ...feeFree,
      transferFeeBps: 300,
    }));
    assert.equal(verdict.blocked, true);
    assert.match(verdict.reason ?? "", /transfer fee 3% \(300 bps\)/);
    assert.match(verdict.reason ?? "", /BOTH legs/);
  });

  it("admits a fee-free mint", async () => {
    const verdict = await assessTokenFeeScreen("mint", 0, async () => feeFree);
    assert.equal(verdict.blocked, false);
    assert.equal(verdict.reason, null);
  });

  it("admits a fee at or below the operator's limit", async () => {
    // Equality is inside the limit: the operator asked for "up to this much", and the
    // same rule the sizing guard uses.
    const verdict = await assessTokenFeeScreen("mint", 50, async () => ({
      ...feeFree,
      transferFeeBps: 50,
    }));
    assert.equal(verdict.blocked, false);
  });

  it("FAILS CLOSED when the mint cannot be read", async () => {
    /*
     * The whole point of the screen. An unreadable mint is an unknown, and an unknown is
     * not evidence that the token is fee-free — the same rule the anti-rug screen
     * follows. The reason has to say so, because the alternative reading of this refusal
     * is "the RPC was slow, try again" and an operator would.
     */
    const verdict = await assessTokenFeeScreen("mint", 0, async () => {
      throw new Error("getAccountInfo timed out");
    });
    assert.equal(verdict.blocked, true);
    assert.match(verdict.reason ?? "", /could not read/);
    assert.match(verdict.reason ?? "", /cannot be proven free of a transfer fee/);
  });

  it("refuses a transfer hook and a non-transferable mint, fee or no fee", async () => {
    const hook = await assessTokenFeeScreen("mint", 0, async () => ({
      ...feeFree,
      hasTransferHook: true,
    }));
    assert.equal(hook.blocked, true);
    assert.match(hook.reason ?? "", /transfer hook/);

    const frozen = await assessTokenFeeScreen("mint", 0, async () => ({
      ...feeFree,
      nonTransferable: true,
    }));
    assert.equal(frozen.blocked, true);
    assert.match(frozen.reason ?? "", /non-transferable/);
  });
});

describe("the screen in the funnel, where it has to be", () => {
  const agent = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "agents", "dlmmTraderAgent.ts"),
    "utf8",
  );

  it("is consulted only behind isLiveExecutionActive, so paper mode is unchanged", () => {
    const call = agent.indexOf("assessTokenFeeScreen(");
    assert.ok(call > 0, "the token-fee screen is not consulted at all");

    const before = agent.slice(0, call);
    const gate = before.lastIndexOf("if (isLiveExecutionActive())");
    assert.ok(gate > 0, "the screen must sit inside the live-only candidate filter");
    assert.ok(
      gate > before.lastIndexOf("summary.cooldownRejected ="),
      "the screen must run after the cooldown stage, with the other execution guards",
    );
  });

  it("runs LAST among the execution guards, after the operator width cap", () => {
    /*
     * Ordering is a COST decision here rather than a semantic one: this is the only gate
     * in the loop that costs an RPC call per pool, so it must only ever see pools that
     * survived every free check.
     */
    const binCap = agent.indexOf("kind: \"binCap\",");
    const fee = agent.indexOf("assessTokenFeeScreen(");
    const push = agent.indexOf("executable.push(pool)", fee);
    assert.ok(binCap > 0 && fee > binCap, "the fee screen must come after the bin cap");
    assert.ok(push > fee, "a refused pool must not reach the executable list");
  });

  it("counts and prints its own bucket, so the funnel can name it", () => {
    assert.match(agent, /kind: "transferFee",/);
    assert.match(agent, /token-fee \$\{byKind\.transferFee\}/);
    assert.match(agent, /execTransferFeeRejected: byKind\.transferFee,/);
  });

  it("sits behind an operator switch, and says so on the boot line when off", () => {
    /*
     * 13 Sep 2026: the operator asked for this gate OFF ("follow the formula that worked
     * before; the first trade ran without a guard"). The switch is explicit rather than a
     * bps number cranked to infinity, because hook and non-transferable refusals have no
     * number at all — and because "it is off" has to be a fact you can READ, not infer
     * from a cycle that happens to pass. Both halves are asserted here: the call site is
     * guarded, and the boot line names the disabled state.
     */
    assert.match(agent, /if \(env\.LIVE_TOKEN_FEE_SCREEN_ENABLED\) \{/);

    const guard = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "services", "executionGuard.ts"),
      "utf8",
    );
    assert.match(guard, /token fees: SCREEN OFF/);
  });
});
