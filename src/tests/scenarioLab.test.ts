/**
 * The scenario lab must fail loudly rather than measure nothing.
 *
 * `--sweep=stopLoss:-12` — the real field is `stopLossPct` — used to produce a row
 * IDENTICAL to the baseline in every column, printing `vs A $0.00`. Measured by the
 * operator on 16 Sep 2026 against the frozen 91-day cache:
 *
 *   S:stopLoss=-12     20 trade  PF 3.25  $500.64  DD 10.6%  vs A   $0.00
 *   S:stopLossPct=-12  16 trade  PF 6.95  $531.31  DD  9.6%  vs A  $30.67
 *
 * The typo row reads as "this lever does nothing" when the flag never applied: the tool
 * turned NOT MEASURED into MEASURED NO EFFECT, which in a program whose entire product is
 * the measurement is the worst thing it can do. Same failure mode as the "all bin arrays
 * exist" line CLAUDE.md records.
 *
 * The parser lives in `src/backtest/scenarioSpec.ts`; `scripts/scenarioLab.ts` re-exports it,
 * so the command line and the test see one implementation.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { defaultBacktestConfig, type BacktestConfig } from "../backtest/engine.js";
import { sweepScenarios, sweepableFields } from "../backtest/scenarioSpec.js";

const base: BacktestConfig = { ...defaultBacktestConfig(), startingCapitalUsd: 300 };

describe("--sweep refuses a field that is not a config field", () => {
  it("throws on a misspelling, names it, and suggests the real field", () => {
    assert.throws(() => sweepScenarios("stopLoss:-12", base), (err: Error) => {
      assert.match(err.message, /"stopLoss" is not a numeric field of BacktestConfig/);
      assert.match(err.message, /measure NOTHING while printing a row that looks like a result/);
      assert.match(err.message, /Did you mean: stopLossPct/);
      return true;
    });
  });

  it("builds ZERO scenarios when any field in the spec is invalid", () => {
    /*
     * The whole spec is refused, not just the bad group. A run that silently dropped the
     * unrecognised half would report a partial sweep as a complete one.
     */
    assert.throws(() => sweepScenarios("stopLossPct:-12;nonsense:5", base), /"nonsense" is not a numeric field/);
  });

  it("refuses a field that exists but is not numeric", () => {
    // `--sweep` only produces numbers; writing one into `exitCostModel` would corrupt the
    // config rather than measure it.
    assert.throws(() => sweepScenarios("exitCostModel:1", base), /is not a numeric field/);
    assert.throws(() => sweepScenarios("gateUsesExitCostModel:1", base), /is not a numeric field/);
  });

  it("still refuses a value that is not a number", () => {
    assert.throws(() => sweepScenarios("stopLossPct:abc", base), /is not a number \(or "off"\)/);
  });
});

describe("--sweep actually applies the value it advertises", () => {
  it("a valid sweep reaches the config — the property nothing asserted before", () => {
    const built = sweepScenarios("stopLossPct:-12", base);
    assert.equal(built.length, 1);
    const applied = built[0]!.apply(base);
    assert.equal(applied.stopLossPct, -12, "the swept value never reached the config");
    // and nothing else moved
    assert.equal(applied.takeProfitNetPct, base.takeProfitNetPct);
    assert.equal(applied.minFeeCostCoverage, base.minFeeCostCoverage);
  });

  it("`off` means Infinity, so a take-profit can be swept away", () => {
    const [scenario] = sweepScenarios("takeProfitNetPct:off", base);
    assert.equal(scenario!.apply(base).takeProfitNetPct, Number.POSITIVE_INFINITY);
  });

  it("walks every value in the list, one scenario each, labelled with the value", () => {
    const built = sweepScenarios("stopLossPct:-5,-8,-12", base);
    assert.deepEqual(
      built.map((s) => s.apply(base).stopLossPct),
      [-5, -8, -12],
    );
    assert.deepEqual(built.map((s) => s.key), [
      "S:stopLossPct=-5",
      "S:stopLossPct=-8",
      "S:stopLossPct=-12",
    ]);
  });

  it("several fields in one spec each apply to their own scenario", () => {
    const built = sweepScenarios("stopLossPct:-12;positionSizePct:35", base);
    assert.equal(built.length, 2);
    assert.equal(built[0]!.apply(base).stopLossPct, -12);
    assert.equal(built[1]!.apply(base).positionSizePct, 35);
    // The second must not carry the first's change: each row is one diff against A.
    assert.equal(built[1]!.apply(base).stopLossPct, base.stopLossPct);
  });
});

describe("the sweepable set is derived from the config, not hand-written", () => {
  it("every sweepable field is a numeric field that exists on the config", () => {
    const fields = sweepableFields(base);
    assert.ok(fields.length > 10, "suspiciously few sweepable fields");
    for (const field of fields) {
      assert.equal(typeof (base as unknown as Record<string, unknown>)[field], "number", field);
    }
  });

  it("a field added to BacktestConfig becomes sweepable with no second list to update", () => {
    /*
     * The anti-drift property. A hand-written allowlist would be a copy of the config's
     * shape and would go stale the first time a field is added — `maxPositionNotionalUsd`
     * is the most recent one and is present here without anyone listing it.
     */
    assert.ok(sweepableFields(base).includes("maxPositionNotionalUsd"));
    assert.ok(sweepableFields(base).includes("stopLossPct"));
    // Non-numeric fields are absent by construction, not by exclusion list.
    assert.ok(!sweepableFields(base).includes("exitCostModel"));
  });
});
