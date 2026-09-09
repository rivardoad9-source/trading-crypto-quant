# Incident: wide open fails with ExceededBinSlippageTolerance on volatile pool (9 Sep 2026)

## Symptom

First live open attempt after the wide-path re-arm (04f7c56). At 13:32 WIB the engine
selected **OTC-SOL** (`Ekm4LYkihEdQgZx2UReDMJ3eCDDjExPQLG94WfWmfyWr`), a 77-bin pool.
The balancing swap CONFIRMED, the wide position CREATE landed, then the funding
transaction was rejected at preflight:

```
[live] the balancing swap CONFIRMED but the position open failed. The wallet now holds
3885908112 base units of MukLDtJ8Cx9DxLbeyLRSWPSposTMWuwHANbuaudpump that nothing monitors
(swap 5fZPQF94...). Auto-unwind back to SOL submitted (4V4HSCL...).

Cause: openPosition on position DX2JQn7muPZtWNdBGwzA1YuVmi9C2yogKNQ2WGbqj8QZ landed 1 of
its transactions and then failed: dlmm openPosition (fund wide position) 1/2: rejected at
preflight, so it never reached the network and nothing is in flight: Simulation failed.
Message: Transaction simulation failed: Error processing Instruction 6: custom program error:
0x1774. Logs: ... Program log: Instruction: RebalanceLiquidity ...
AnchorError: ExceededBinSlippageTolerance. Error Number: 6004.
```

## Root cause

The SDK's chunked wide funding (`addLiquidityByStrategyChunkable`) emits
`RebalanceLiquidity` instructions carrying an `active_id` snapshot plus a
`max_active_bin_slippage` tolerance, both captured when the transaction was BUILT.
Between the create transaction landing and the funding transaction being built+landed
(seconds apart on a fast memecoin pool), price moved more than the tolerance → the program
rejects with `ExceededBinSlippageTolerance` (0x1774).

`sendSequentially` (onchainExecutor.ts:1768) retries only by refreshing the blockhash and
raising the priority fee — the instructions keep the stale `active_id`, so a retry cannot
fix a bin-slippage rejection. The simulation fails deterministically every time.

Distinct from the 8 Sep root cause (missing CU budget + redundant InitializeBinArray, fixed
in 6d685d8): those fixes worked (budget honoured, redundant arrays dropped). This is a
SECOND, independent failure mode of the wide path, specific to pools volatile enough to
move across bins within the create→fund gap.

Same pattern previously cost money on SOLCAT-SOL (7 Sep) and ZCAT-SOL (8 Sep) — both
"landed 1 of its transactions and then failed" on fund wide position.

## Why the controlled validation passed but this failed

TripleT-SOL (validated 12:27 WIB, same day, 95 bins) was quiet: price did not cross a bin
in the create→fund window. OTC-SOL (a `...pump` memecoin) moves bins in seconds.

## Impact & cleanup

- Wallet: 3.0017 → 2.9625 SOL over the whole wide-validation session (includes both
  controlled tests + this failure). This incident alone ≈ 0.033 SOL (swap in/out + gas).
- Auto-close of the unfunded position ran (rent recovered), auto-unwind of the stranded
  swap ran and FINALIZED: MUK balance 0, position account gone, no orphan, no stranded
  token. The 6d685d8-era safety nets worked as designed.
- OTC-SOL recorded `consecutive_failures=1, stage="open"` → execution breaker benches it
  immediately (BENCH_IMMEDIATELY for stage "open"), lockout EXECUTION_FAILURE_LOCKOUT_HOURS.
  It will not be re-attempted this session.

## Candidate fixes (not yet implemented)

1. **Rebuild funding transactions with a fresh `active_id` on rejection** — instead of
   only refreshing the blockhash, re-run `pool.addLiquidityByStrategyChunkable` (or rebuild
   the RebalanceLiquidity) so the tolerance is measured from the CURRENT active bin. Most
   correct; needs care in `sendSequentially` / the wide funding path (onchainExecutor.ts
   ~2238).
2. **Volatility filter before open** — reject pools whose price moved >N bins (or >X%) in
   the last ~1-2 min (or between rehearsal and open). Cheap, prevents the spend entirely,
   but adds a gate and needs a defensible threshold (fast pools are exactly the ones with
   the best fees).
3. **Widen `max_active_bin_slippage` on funding** — the SDK derives it from the position
   range; forcing it wider (e.g. cover a few bins) trades a small mispricing risk against
   the whole open failing. Cheap but changes execution economics.

Not implemented as of this doc — logged for the operator/Claude Code to pick up.

## Screening-layer idea (logged 9 Sep, operator request): GMGN data as a pre-filter

Context: OTC-SOL (`Ekm4LYki...`) passed every engine screen (antirug, volatility,
fee/TVL, age) yet was a `...pump` memecoin being driven hard enough to move bins in
seconds. Engine screens are on-chain facts (revoked authorities, holders, 1h/24h
price moves); they cannot see off-chain "who is driving this" signals.

GMGN (gmgn.ai) analytics could add, per candidate token, before any spend:
- holder count + distribution (top-10 % already known; add total holders)
- **dev wallet remaining %** (a dev still holding 30-40% is a rug/exit vector)
- **sniper/bundler activity** in the first minutes (bot-pumped tokens)
- fresh-deploy / bundling detection

Where it sits: an optional extra gate in the funnel (like antirug), NOT a fix for
the slippage error above — that stays a code fix. Decision: not integrated; would
need GMGN API access (paid) or fragile scraping. Revisit only after the code fixes
are done and bad-pool losses still justify it. Owner: operator.


## Files touched (this doc only)

No code changed. Working tree otherwise clean at 04f7c56.
