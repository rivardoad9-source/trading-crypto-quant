# Incident: no-wSOL pool passes all gates, dies at live execution (9 Sep 2026)

## Symptom

Recurring error every dlmm cycle (30 min), starting ~04:00 WIB 9 Sep 2026 (2 occurrences in the
error log before intervention):

```
[dlmm] live execution failed: [live] pool 9abbXL7rTz1GHitpJz7qdbcYNe8ATeXUW1po5RfMvT2t has no wSOL side; the engine sizes in SOL and cannot fund this pair
```

Triggered the watchdog alert ("error eksekusi baru di log") → user pinged.

## Root cause

Pool `9abbXL7rTz1GHitpJz7qdbcYNe8ATeXUW1po5RfMvT2t` is a **memecoin/USDC pair**
(tokenX `MukLDtJ8Cx9DxLbeyLRSWPSposTMWuwHANbuaudpump`, tokenY USDC) — **no wSOL leg at all**.

The engine is SOL-funded only: `describePair()` (liveExecution.ts) sizes the deposit in SOL and
requires one pool side to be wSOL, else it throws. BUT the screening funnel has **no "must have a
wSOL side" filter**, so a no-wSOL pool with high enough fees can clear EVERY gate (anti-rug ✓,
volatility ✓, breakeven 2.5x coverage ✓ — this pool's 24h fee was high enough) and get selected by
the model for live execution. It only dies at the last step, inside `describePair()`, wasting the
whole cycle (~60–90s vs normal ~5s) and raising an execution-error alert every 30 min until the
pool leaves the candidate set.

## Fix applied (ops-level, no code change)

Added the pool address to `POOL_DENYLIST` in `.env` (`.env` is gitignored — do NOT commit it):

```
POOL_DENYLIST=zxTpi4BtaWX3mgdAPoezkMD1hxx8CdeCfrqXMWvSCLX,STONK-SOL,9abbXL7rTz1GHitpJz7qdbcYNe8ATeXUW1po5RfMvT2t
```

then `pm2 restart flowmetrix-engine`. Boot clean: live profile ARMED, wallet 3.0017 SOL,
telegram bot session started with no 409 conflict. Denylist is parsed at module load, so the
execution guard now skips this pool before the model ever sees it.

## Follow-ups (NOT done — user decision pending)

- **Proper fix**: add a "pool must have a wSOL side" check to the funnel/execution guard (like the
  bin-cap check), so no-wSOL pools never reach the model. User explicitly deferred: they plan to
  backtest USDC-quoted pool support with Claude Code first — if USDC-quoted pairs become
  supported, the fix would be to let them through, not reject them.
- Same class of risk applies to any high-fee no-wSOL pool that appears later: denylist it the same
  way until the funnel filter or USDC support lands.
