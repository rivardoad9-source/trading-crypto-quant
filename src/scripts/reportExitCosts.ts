/**
 * npm run report:exitcosts [-- --solusd=100]
 *
 * The exit-cost calibration, re-fitted from the `exit_economics` ledger and printed BESIDE
 * the constants `src/backtest/exitCost.ts` ships with. It never edits those constants:
 * changing the model every simulated exit is priced with is a human decision, taken with
 * the stability table below in view.
 *
 * Reads the local database and (unless --solusd is given) one SOL/USD quote. Signs nothing.
 */
import { initDatabase } from "../database/db.js";
import { listExitEconomics } from "../database/repositories.js";
import { fetchSolPriceUsd } from "../services/marketData.js";
import { renderTable } from "../backtest/report.js";
import {
  LIVE_EXIT_OBSERVATIONS,
  binStepOnlySlope,
  bootstrapSlopeStability,
  calibrateExitCostModel,
  observationsFromLedger,
  observationsNeededFor,
  type ExitCostObservation,
} from "../backtest/exitCost.js";

const f = (v: number | null | undefined, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : v.toFixed(d));

function fitLine(label: string, obs: readonly ExitCostObservation[]): string[] {
  const usable2 = obs.filter((o) => Number.isFinite(o.shareOfTvlPct));
  const slope = binStepOnlySlope(obs);
  const envelope = obs.length ? Math.max(...obs.map((o) => o.concessionPct / (o.binStepBps / 100))) : null;
  const two = usable2.length >= 2 ? calibrateExitCostModel(usable2).fit : null;
  return [
    label,
    String(obs.length),
    two ? f(two.spreadPerBinStepPct, 3) : "—",
    two ? f(two.impactPerTvlPct, 3) : "—",
    f(slope, 3),
    f(envelope, 3),
  ];
}

async function main(): Promise<void> {
  initDatabase();
  const flag = process.argv.find((a) => a.startsWith("--solusd="));
  const solUsd = flag ? Number(flag.split("=")[1]) : await fetchSolPriceUsd().catch(() => null);

  const ledger = listExitEconomics();
  const { observations: measured, excluded } = observationsFromLedger(ledger, solUsd);

  console.log(`\nEXIT-COST CALIBRATION — ${ledger.length} ledger rows, ${measured.length} measured, SOL/USD ${f(solUsd)}\n`);

  console.log(
    renderTable(
      [
        { header: "Observation" },
        { header: "bin_step", align: "right" },
        { header: "notional/TVL", align: "right" },
        { header: "observed", align: "right" },
        { header: "fit now", align: "right" },
        { header: "envelope now", align: "right" },
        { header: "source" },
      ],
      (() => {
        const current = calibrateExitCostModel(LIVE_EXIT_OBSERVATIONS);
        const at = (spread: number, impact: number, o: ExitCostObservation) =>
          spread * (o.binStepBps / 100) + impact * (Number.isFinite(o.shareOfTvlPct) ? o.shareOfTvlPct : 0);
        return measured.map((o) => [
          o.label,
          String(o.binStepBps),
          Number.isFinite(o.shareOfTvlPct) ? `${o.shareOfTvlPct.toFixed(3)}%` : "—",
          `${o.concessionPct.toFixed(2)}%`,
          `${at(current.fit.spreadPerBinStepPct, current.fit.impactPerTvlPct, o).toFixed(2)}%`,
          `${at(current.envelope.spreadPerBinStepPct, 0, o).toFixed(2)}%`,
          o.source,
        ]);
      })(),
    ),
  );
  if (excluded.length) {
    console.log(`\nNot observations (unmeasured, NOT zero): ${excluded.map((e) => `${e.id.slice(0, 8)} ${e.why}`).join("; ")}`);
  }

  /*
   * EMBER #5 and NEARKAT are in both the hand-collected set and the ledger. The combined set
   * keeps the ledger's measurement and only adds hand points the ledger does not cover
   * (MANLET, whose residual was sold by hand and has no sweep to measure).
   */
  const ledgerPairs = new Set(measured.map((o) => o.label.split("#")[0]));
  const combined = [...measured, ...LIVE_EXIT_OBSERVATIONS.filter((o) => !ledgerPairs.has(o.label))];

  console.log("\nCONSTANTS — shipped vs refit (fit = a·bin_step% + b·TVL%, envelope = c·bin_step%). NOT applied.\n");
  console.log(
    renderTable(
      [
        { header: "Set" },
        { header: "n", align: "right" },
        { header: "a (fit)", align: "right" },
        { header: "b (fit)", align: "right" },
        { header: "bin-step-only slope", align: "right" },
        { header: "c (envelope)", align: "right" },
      ],
      [
        fitLine("SHIPPED (3 hand points)", LIVE_EXIT_OBSERVATIONS),
        fitLine("ledger only", measured),
        fitLine("ledger + hand points not in it", combined),
      ],
    ),
  );

  const sizes = [3, 5, 8, 12, 20, 30, 50];
  const base = combined.length ? combined : [...LIVE_EXIT_OBSERVATIONS];
  const stability = bootstrapSlopeStability(base, sizes);
  console.log(`\nSTABILITY — bootstrap of the bin-step-only slope from the ${base.length} points we have (1000 draws per n)\n`);
  console.log(
    renderTable(
      [
        { header: "n", align: "right" },
        { header: "mean slope", align: "right" },
        { header: "std error", align: "right" },
        { header: "relative", align: "right" },
      ],
      stability.map((r) => [String(r.n), f(r.meanSlope, 3), f(r.standardError, 3), r.relativeError === null ? "—" : `${(r.relativeError * 100).toFixed(0)}%`]),
    ),
  );
  for (const target of [0.25, 0.1]) {
    const need = observationsNeededFor(stability, target);
    console.log(
      `relative error <= ${target * 100}%: ${need ? `n ≈ ${need.n}${need.extrapolated ? " (extrapolated 1/sqrt(n))" : ""}` : "not computable"}`,
    );
  }
  const binSteps = [...new Set(base.map((o) => o.binStepBps))].sort((a, b) => a - b);
  console.log(
    "\nThe bootstrap resamples the points we HAVE; it cannot show exits we have not seen (other bin steps,",
    `\nother market states). Treat these n as a lower bound. Bin steps covered so far: ${binSteps.join(", ")}.`,
  );
}

main().catch((err) => {
  console.error("[exitcosts] report failed:", err);
  process.exit(1);
});
