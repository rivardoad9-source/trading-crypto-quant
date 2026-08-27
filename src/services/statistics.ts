/**
 * Small statistical helpers shared by the live agent and the research harness.
 *
 * These live outside both so the live engine never has to import from `backtest/`,
 * and so the volatility the agent screens on is computed by exactly the same code
 * that produced the research finding.
 */

/**
 * Standard deviation of hourly log returns, expressed as a percentage per hour.
 *
 * Returns null when there are fewer than `minSamples` usable returns — the caller
 * must treat that as unknown, never as calm.
 */
export function realizedVolatilityPctPerHour(
  hourlyCloses: number[],
  minSamples = 12,
): number | null {
  const returns: number[] = [];

  for (let i = 1; i < hourlyCloses.length; i++) {
    const prev = hourlyCloses[i - 1];
    const now = hourlyCloses[i];
    if (!prev || !now || prev <= 0 || now <= 0) continue;
    returns.push(Math.log(now / prev));
  }

  if (returns.length < minSamples) return null;

  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / (returns.length - 1);

  return Math.sqrt(variance) * 100;
}
