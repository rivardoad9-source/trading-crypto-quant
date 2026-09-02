#!/usr/bin/env python
"""
QuantStats-style tear sheet for the annual DLMM V1.1 backtest.

    npm run backtest:annual      # produces reports/annual/daily_returns.csv
    npm run report:quant         # this script

Reads the daily realised-equity curve exported by `src/backtest/runAnnual.ts` and
renders:

    reports/annual/charts/monthly_returns_distribution.png
    reports/annual/charts/daily_returns.png
    reports/annual/tearsheet.html      self-contained (charts inlined as base64)
    reports/annual/tearsheet.md
    reports/annual/quantstats-full.html   best-effort, QuantStats' own tear sheet

Metrics come from `quantstats.stats` wherever the library defines them, so the
numbers match what QuantStats would print rather than a re-derivation of it. Each
call is guarded: a metric the library cannot compute renders as "—", never as 0.
That mirrors the project rule that an undefined metric stays null — returning 0 or
Infinity would render on the page as a real measurement.

The input series is REALISED-ONLY (equity steps on a close, never on open floating
PnL), so days without a close read 0.00%. That deflates daily volatility and
flatters every daily-sampled ratio. The caveats block carried in the backtest JSON
is reproduced verbatim in the HTML for that reason.
"""

from __future__ import annotations

import argparse
import base64
import json
import math
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

import matplotlib

matplotlib.use("Agg")  # No display on a headless run; must precede pyplot.

# The Windows console defaults to cp1252, which cannot encode the arrows, em dashes
# and box-drawing characters this report prints. Without this the run dies on a
# UnicodeEncodeError AFTER writing every file — a confusing failure that looks like
# the report itself broke. Reconfigure rather than degrade the output.
for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):  # already utf-8, or a non-reconfigurable stream
        pass

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

try:
    import quantstats as qs

    QS_AVAILABLE = True
    QS_ERROR = ""
except Exception as exc:  # pragma: no cover - environment dependent
    QS_AVAILABLE = False
    QS_ERROR = f"{type(exc).__name__}: {exc}"


# --------------------------------------------------------------------------- #
# Palette                                                                      #
# --------------------------------------------------------------------------- #

INK = "#1c1917"
MUTED = "#78716c"
GRID = "#e7e5e4"
PAPER = "#ffffff"
ACCENT = "#2563eb"
POSITIVE = "#0f766e"
NEGATIVE = "#b91c1c"
MEAN_LINE = "#dc2626"

plt.rcParams.update(
    {
        "figure.facecolor": PAPER,
        "axes.facecolor": PAPER,
        "axes.edgecolor": GRID,
        "axes.labelcolor": MUTED,
        "text.color": INK,
        "xtick.color": MUTED,
        "ytick.color": MUTED,
        "font.size": 10,
        "axes.titlesize": 12,
        "axes.titleweight": "bold",
        "figure.dpi": 130,
        "savefig.dpi": 130,
        "savefig.bbox": "tight",
    }
)


# --------------------------------------------------------------------------- #
# Formatting                                                                   #
# --------------------------------------------------------------------------- #

DASH = "—"


def is_undefined(value) -> bool:
    """True for None, NaN and +/-inf. Those must render as '—', never as a number."""
    if value is None:
        return True
    try:
        return not math.isfinite(float(value))
    except (TypeError, ValueError):
        return True


def pct(value, digits: int = 2) -> str:
    """Formats a FRACTION as a percentage. 0.0134 -> '+1.34%'."""
    if is_undefined(value):
        return DASH
    return f"{float(value) * 100:+.{digits}f}%"


def plural(n: int, word: str) -> str:
    return f"{n} {word}" if n == 1 else f"{n} {word}s"


def upct(value, digits: int = 2) -> str:
    """
    Percentage WITHOUT a leading sign, for quantities that cannot be negative —
    volatility, win rates, time underwater. A "+55.17%" win rate reads as a change in
    the win rate rather than its level.
    """
    if is_undefined(value):
        return DASH
    return f"{float(value) * 100:.{digits}f}%"


def ratio(value, digits: int = 2) -> str:
    if is_undefined(value):
        return DASH
    return f"{float(value):.{digits}f}"


def money(value, digits: int = 2) -> str:
    if is_undefined(value):
        return DASH
    v = float(value)
    return f"{'-' if v < 0 else ''}${abs(v):,.{digits}f}"


def days(value, digits: int = 1) -> str:
    if is_undefined(value):
        return DASH
    return f"{float(value):.{digits}f}"


def guarded(fn, *args, **kwargs):
    """
    Runs a metric and returns NaN instead of raising.

    QuantStats warns and returns NaN for degenerate inputs (no losing periods, an
    all-zero series). A backtest that made two trades hits several of those, and one
    of them must not take the whole report down.
    """
    try:
        value = fn(*args, **kwargs)
    except Exception:
        return float("nan")
    if isinstance(value, (pd.Series, pd.DataFrame)):
        return float("nan") if value.empty else float(np.asarray(value).ravel()[0])
    return value


# --------------------------------------------------------------------------- #
# Loading                                                                      #
# --------------------------------------------------------------------------- #


@dataclass
class Inputs:
    returns: pd.Series
    equity: pd.Series
    closes: pd.Series
    meta: dict


def load(daily_csv: Path, meta_json: Path | None) -> Inputs:
    if not daily_csv.exists():
        sys.exit(
            f"[quant] {daily_csv} not found.\n"
            f"[quant] Run `npm run backtest:annual` first — it writes the daily curve."
        )

    frame = pd.read_csv(daily_csv, parse_dates=["date"]).set_index("date").sort_index()
    for column in ("daily_return", "equity_usd", "closes"):
        if column not in frame.columns:
            sys.exit(f"[quant] {daily_csv} is missing the '{column}' column.")

    returns = frame["daily_return"].astype(float)
    # An inf or NaN here would silently poison every downstream aggregate.
    returns = returns.replace([np.inf, -np.inf], np.nan).fillna(0.0)
    returns.index = pd.DatetimeIndex(returns.index)
    returns.name = "DLMM V1.1"

    meta: dict = {}
    if meta_json is not None and meta_json.exists():
        try:
            meta = json.loads(meta_json.read_text(encoding="utf8"))
        except Exception as exc:
            print(f"[quant] warning: could not parse {meta_json}: {exc}")

    return Inputs(
        returns=returns,
        equity=frame["equity_usd"].astype(float),
        closes=frame["closes"].astype(int),
        meta=meta,
    )


# --------------------------------------------------------------------------- #
# Aggregation                                                                  #
# --------------------------------------------------------------------------- #


def compound(series: pd.Series) -> float:
    return float((1.0 + series).prod() - 1.0)


def periodic(returns: pd.Series, rule: str) -> pd.Series:
    """Compounded returns per calendar period. 'ME' month-end, 'QE' quarter, 'YE' year."""
    if returns.empty:
        return pd.Series(dtype=float)
    return returns.resample(rule).apply(compound)


def drawdown_series(returns: pd.Series) -> pd.Series:
    """Fractional drawdown from the running peak of the compounded curve."""
    curve = (1.0 + returns).cumprod()
    return curve / curve.cummax() - 1.0


def drawdown_table(returns: pd.Series) -> pd.DataFrame:
    """
    One row per underwater episode: start, valley, recovery, duration, depth.

    An episode still underwater at the end of the window is reported with its
    recovery date left blank rather than being dropped — an unrecovered drawdown is
    the one that matters most, and silently omitting it would understate the risk.
    """
    dd = drawdown_series(returns)
    rows: list[dict] = []

    underwater = dd < 0
    if not underwater.any():
        return pd.DataFrame(
            columns=["start", "valley", "end", "days", "max_drawdown", "recovered"]
        )

    start_idx: pd.Timestamp | None = None
    for timestamp, is_under in underwater.items():
        if is_under and start_idx is None:
            start_idx = timestamp
        elif not is_under and start_idx is not None:
            window = dd.loc[start_idx:timestamp]
            rows.append(
                {
                    "start": start_idx,
                    "valley": window.idxmin(),
                    "end": timestamp,
                    "days": (timestamp - start_idx).days,
                    "max_drawdown": float(window.min()),
                    "recovered": True,
                }
            )
            start_idx = None

    if start_idx is not None:
        window = dd.loc[start_idx:]
        rows.append(
            {
                "start": start_idx,
                "valley": window.idxmin(),
                "end": dd.index[-1],
                "days": (dd.index[-1] - start_idx).days,
                "max_drawdown": float(window.min()),
                "recovered": False,
            }
        )

    return pd.DataFrame(rows).sort_values("max_drawdown")


# --------------------------------------------------------------------------- #
# Metrics                                                                      #
# --------------------------------------------------------------------------- #


def build_metrics(data: Inputs) -> dict:
    r = data.returns
    monthly = periodic(r, "ME")
    quarterly = periodic(r, "QE")
    yearly = periodic(r, "YE")
    dd = drawdown_series(r)
    table = drawdown_table(r)

    trading_days = int((data.closes > 0).sum())
    calendar_days = int(len(r))

    # Wins are measured over days that actually closed a position. Counting the ~95%
    # of days with no close as "not a win" would report a win rate of a few percent
    # and say nothing about the strategy. Both denominators are surfaced below.
    active = r[data.closes > 0]

    def qs_stat(name: str, *args, **kwargs):
        if not QS_AVAILABLE:
            return float("nan")
        fn = getattr(qs.stats, name, None)
        if fn is None:
            return float("nan")
        return guarded(fn, *args, **kwargs)

    up_months = monthly[monthly > 0]
    down_months = monthly[monthly < 0]

    # Months and quarters in which a position actually closed. A period with no trade
    # has a realised return of exactly 0.00%, which is not a loss and not a win — but a
    # plain `(monthly > 0).mean()` counts it against the strategy and reports a win rate
    # that describes the data coverage rather than the edge. Both denominators are
    # published; the activity-aware one is the meaningful figure.
    closes_m = data.closes.resample("ME").sum()
    closes_q = data.closes.resample("QE").sum()
    monthly_active = monthly[closes_m.reindex(monthly.index).fillna(0) > 0]
    quarterly_active = quarterly[closes_q.reindex(quarterly.index).fillna(0) > 0]

    max_dd = float(dd.min()) if len(dd) else float("nan")
    total_return = compound(r)

    return {
        # ---- Window ----
        "start": r.index[0] if len(r) else None,
        "end": r.index[-1] if len(r) else None,
        "calendar_days": calendar_days,
        "active_days": trading_days,
        "active_day_share": trading_days / calendar_days if calendar_days else float("nan"),
        # ---- Headline ----
        "total_return": total_return,
        "cagr": qs_stat("cagr", r),
        "sharpe": qs_stat("sharpe", r),
        "sortino": qs_stat("sortino", r),
        "calmar": qs_stat("calmar", r),
        "volatility_ann": qs_stat("volatility", r),
        "skew": float(r.skew()) if calendar_days > 2 else float("nan"),
        "kurtosis": float(r.kurtosis()) if calendar_days > 3 else float("nan"),
        # ---- Monthly / yearly extremes ----
        "best_month": float(monthly.max()) if len(monthly) else float("nan"),
        "worst_month": float(monthly.min()) if len(monthly) else float("nan"),
        "best_year": float(yearly.max()) if len(yearly) else float("nan"),
        "worst_year": float(yearly.min()) if len(yearly) else float("nan"),
        "best_day": float(r.max()) if calendar_days else float("nan"),
        "worst_day": float(r.min()) if calendar_days else float("nan"),
        # ---- Drawdown ----
        "max_drawdown": max_dd,
        "avg_drawdown": float(table["max_drawdown"].mean()) if len(table) else float("nan"),
        "avg_drawdown_days": float(table["days"].mean()) if len(table) else float("nan"),
        "longest_drawdown_days": float(table["days"].max()) if len(table) else float("nan"),
        "drawdown_episodes": int(len(table)),
        "recovery_factor": qs_stat("recovery_factor", r),
        "ulcer_index": qs_stat("ulcer_index", r),
        "time_underwater": float((dd < 0).mean()) if calendar_days else float("nan"),
        # ---- Segmented win rates ----
        "avg_up_month": float(up_months.mean()) if len(up_months) else float("nan"),
        "avg_down_month": float(down_months.mean()) if len(down_months) else float("nan"),
        "win_days_active": float((active > 0).mean()) if len(active) else float("nan"),
        "win_days_calendar": float((r > 0).mean()) if calendar_days else float("nan"),
        "win_month": float((monthly > 0).mean()) if len(monthly) else float("nan"),
        "win_month_active": (
            float((monthly_active > 0).mean()) if len(monthly_active) else float("nan")
        ),
        "win_quarter": float((quarterly > 0).mean()) if len(quarterly) else float("nan"),
        "win_quarter_active": (
            float((quarterly_active > 0).mean()) if len(quarterly_active) else float("nan")
        ),
        "win_year": float((yearly > 0).mean()) if len(yearly) else float("nan"),
        "active_months": int(len(monthly_active)),
        "total_months": int(len(monthly)),
        "active_quarters": int(len(quarterly_active)),
        "monthly_closes": closes_m,
        # ---- Series ----
        "monthly": monthly,
        "quarterly": quarterly,
        "yearly": yearly,
        "drawdown": dd,
        "drawdown_table": table,
    }


# --------------------------------------------------------------------------- #
# Charts                                                                       #
# --------------------------------------------------------------------------- #


def chart_monthly_distribution(monthly: pd.Series, closes: pd.Series, path: Path) -> Path:
    """
    Chart 1 — Distribution of Monthly Returns.

    Histogram of compounded monthly returns, overlaid with the normal density implied
    by the sample's own mean and standard deviation, plus a red dashed line at the
    mean. The normal curve is a REFERENCE, not a fit claim: a handful of monthly
    observations cannot establish normality, and the visible gap between the bars and
    the curve is the point of drawing it.

    Months in which no position closed are stacked separately in grey. Their realised
    return is exactly 0.00%, so a single-colour histogram piles them into the bin next
    to zero and the chart reads as "mostly flat months" when it should read "mostly no
    data". The mean line and the normal reference are still computed over ALL months,
    because that is the series every other statistic on the page is built from.
    """
    fig, ax = plt.subplots(figsize=(9.5, 4.6))

    values = monthly.dropna().values * 100.0
    traded_mask = (closes.reindex(monthly.index).fillna(0) > 0).values[: len(values)]

    if len(values) == 0:
        ax.text(0.5, 0.5, "No monthly observations", ha="center", va="center",
                transform=ax.transAxes, color=MUTED)
        ax.set_axis_off()
        fig.savefig(path)
        plt.close(fig)
        return path

    bins = max(6, min(20, int(round(math.sqrt(len(values)) * 2.5))))
    traded = values[traded_mask]
    untraded = values[~traded_mask]

    counts, edges, _ = ax.hist(
        [traded, untraded],
        bins=bins,
        stacked=True,
        color=[ACCENT, GRID],
        edgecolor=PAPER,
        linewidth=1.1,
        label=[
            f"Traded ({len(traded)} month{'' if len(traded) == 1 else 's'})",
            f"No position closed ({len(untraded)})",
        ],
    )
    edges = np.asarray(edges)

    mean = float(np.mean(values))
    std = float(np.std(values, ddof=1)) if len(values) > 1 else 0.0

    if std > 0:
        span = max(abs(values.min() - mean), abs(values.max() - mean), 3 * std)
        grid = np.linspace(mean - span * 1.15, mean + span * 1.15, 400)
        density = np.exp(-0.5 * ((grid - mean) / std) ** 2) / (std * math.sqrt(2 * math.pi))
        bin_width = edges[1] - edges[0]
        ax.plot(
            grid,
            density * len(values) * bin_width,
            color=INK,
            linewidth=1.8,
            label=f"Normal reference (σ = {std:.2f}%)",
        )

    ax.axvline(
        mean,
        color=MEAN_LINE,
        linestyle="--",
        linewidth=2.0,
        label=f"Mean = {mean:+.2f}%",
    )
    ax.axvline(0, color=MUTED, linewidth=1.0, alpha=0.55)

    ax.set_title(f"Distribution of Monthly Returns  ({len(values)} months)", loc="left")
    ax.set_xlabel("Monthly return (%)")
    ax.set_ylabel("Number of months")
    ax.yaxis.grid(True, color=GRID, linewidth=0.8)
    ax.set_axisbelow(True)
    for spine in ("top", "right"):
        ax.spines[spine].set_visible(False)
    ax.legend(frameon=False, loc="upper right", fontsize=8.5)

    fig.savefig(path)
    plt.close(fig)
    return path


def chart_daily_returns(returns: pd.Series, closes: pd.Series, path: Path) -> Path:
    """
    Chart 2 — Daily Returns.

    A timeline spanning the whole window, drawn as a stem per day against a zero
    baseline. Days with no close are genuinely 0.00% on a realised-only curve, so the
    flat stretches are information: they show how sparsely the strategy traded.
    """
    fig, ax = plt.subplots(figsize=(11.0, 4.2))

    if returns.empty:
        ax.text(0.5, 0.5, "No daily observations", ha="center", va="center",
                transform=ax.transAxes, color=MUTED)
        ax.set_axis_off()
        fig.savefig(path)
        plt.close(fig)
        return path

    values = returns.values * 100.0
    colors = [POSITIVE if v > 0 else (NEGATIVE if v < 0 else GRID) for v in values]

    ax.vlines(returns.index, 0, values, colors=colors, linewidth=1.5)
    ax.axhline(0, color=INK, linewidth=1.0)

    active = returns[closes > 0]
    ax.scatter(
        active.index,
        active.values * 100.0,
        s=9,
        color=[POSITIVE if v > 0 else NEGATIVE if v < 0 else MUTED for v in active.values],
        zorder=3,
        linewidths=0,
    )

    limit = max(abs(values.min()), abs(values.max()), 0.1) * 1.18
    ax.set_ylim(-limit, limit)
    ax.set_xlim(returns.index[0], returns.index[-1])

    ax.set_title(
        f"Daily Returns  ({returns.index[0]:%d %b %Y} → {returns.index[-1]:%d %b %Y}, "
        f"{int((closes > 0).sum())} days with a close)",
        loc="left",
    )
    ax.set_ylabel("Daily return (%)")
    ax.yaxis.grid(True, color=GRID, linewidth=0.8)
    ax.set_axisbelow(True)
    for spine in ("top", "right", "left"):
        ax.spines[spine].set_visible(False)

    fig.autofmt_xdate()
    fig.savefig(path)
    plt.close(fig)
    return path


def chart_equity_and_drawdown(equity: pd.Series, dd: pd.Series, path: Path) -> Path:
    """Context for the two required charts: the realised curve and its underwater plot."""
    fig, (top, bottom) = plt.subplots(
        2, 1, figsize=(11.0, 5.6), sharex=True, gridspec_kw={"height_ratios": [2, 1]}
    )

    top.plot(equity.index, equity.values, color=ACCENT, linewidth=1.6)
    top.fill_between(equity.index, equity.values, equity.values.min(), color=ACCENT, alpha=0.08)
    top.set_title("Realised equity curve (steps on close, no floating PnL)", loc="left")
    top.set_ylabel("Equity ($)")
    top.yaxis.grid(True, color=GRID, linewidth=0.8)
    top.set_axisbelow(True)
    for spine in ("top", "right"):
        top.spines[spine].set_visible(False)

    bottom.fill_between(dd.index, dd.values * 100.0, 0, color=NEGATIVE, alpha=0.28)
    bottom.plot(dd.index, dd.values * 100.0, color=NEGATIVE, linewidth=1.2)
    bottom.set_ylabel("Drawdown (%)")
    bottom.yaxis.grid(True, color=GRID, linewidth=0.8)
    bottom.set_axisbelow(True)
    for spine in ("top", "right"):
        bottom.spines[spine].set_visible(False)

    fig.autofmt_xdate()
    fig.savefig(path)
    plt.close(fig)
    return path


# --------------------------------------------------------------------------- #
# Rendering                                                                    #
# --------------------------------------------------------------------------- #


def terminal_table(title: str, rows: list[tuple[str, str]]) -> str:
    width = max([len(title)] + [len(a) for a, _ in rows]) + 2
    value_width = max((len(b) for _, b in rows), default=6) + 2
    line = "─" * (width + value_width + 1)
    out = [f"\n{title}", line]
    for label, value in rows:
        out.append(f"{label:<{width}}{value:>{value_width}}")
    out.append(line)
    return "\n".join(out)


def metric_rows(m: dict) -> dict[str, list[tuple[str, str]]]:
    """The metric groups the report is built from, in display order."""
    return {
        "Headline": [
            ("Total return", pct(m["total_return"])),
            ("CAGR", pct(m["cagr"])),
            ("Sharpe (daily, ann.)", ratio(m["sharpe"])),
            ("Sortino (daily, ann.)", ratio(m["sortino"])),
            ("Calmar", ratio(m["calmar"])),
            ("Annualised volatility", upct(m["volatility_ann"])),
            ("Skew", ratio(m["skew"])),
            ("Kurtosis", ratio(m["kurtosis"])),
        ],
        "Monthly & Yearly Extremes": [
            ("Best Month", pct(m["best_month"])),
            ("Worst Month", pct(m["worst_month"])),
            ("Best Year", pct(m["best_year"])),
            ("Worst Year", pct(m["worst_year"])),
            ("Best Day", pct(m["best_day"])),
            ("Worst Day", pct(m["worst_day"])),
        ],
        "Drawdown": [
            ("Max Drawdown", pct(m["max_drawdown"])),
            ("Avg Drawdown", pct(m["avg_drawdown"])),
            ("Avg Drawdown Days", days(m["avg_drawdown_days"])),
            ("Longest Drawdown Days", days(m["longest_drawdown_days"], 0)),
            ("Drawdown episodes", str(m["drawdown_episodes"])),
            ("Time underwater", upct(m["time_underwater"])),
            ("Recovery Factor", ratio(m["recovery_factor"])),
            ("Ulcer Index", ratio(m["ulcer_index"], 4)),
        ],
        "Segmented Win Rates": [
            ("Avg Up Month", pct(m["avg_up_month"])),
            ("Avg Down Month", pct(m["avg_down_month"])),
            ("Win Days % (days with a close)", upct(m["win_days_active"])),
            ("Win Days % (all calendar days)", upct(m["win_days_calendar"])),
            (
                f"Win Month % (of {plural(m['active_months'], 'month')} traded)",
                upct(m["win_month_active"]),
            ),
            (
                f"Win Month % (of {plural(m['total_months'], 'calendar month')})",
                upct(m["win_month"]),
            ),
            (
                f"Win Quarter % (of {plural(m['active_quarters'], 'quarter')} traded)",
                upct(m["win_quarter_active"]),
            ),
            ("Win Quarter % (all quarters)", upct(m["win_quarter"])),
            ("Win Year %", upct(m["win_year"])),
        ],
    }


def eoy_rows(m: dict) -> list[tuple[str, str, str, str, str]]:
    """Return, months covered, best/worst month, per calendar year."""
    monthly = m["monthly"]
    rows = []
    for period, value in m["yearly"].items():
        year = period.year
        in_year = monthly[monthly.index.year == year]
        rows.append(
            (
                str(year),
                pct(value),
                str(len(in_year)),
                pct(in_year.max()) if len(in_year) else DASH,
                pct(in_year.min()) if len(in_year) else DASH,
            )
        )
    return rows


def worst_drawdown_rows(m: dict, limit: int = 10) -> list[tuple[str, ...]]:
    table = m["drawdown_table"]
    if table.empty:
        return []
    rows = []
    for _, row in table.head(limit).iterrows():
        rows.append(
            (
                f"{row['start']:%Y-%m-%d}",
                f"{row['valley']:%Y-%m-%d}",
                f"{row['end']:%Y-%m-%d}" if row["recovered"] else "not recovered",
                str(int(row["days"])),
                pct(row["max_drawdown"]),
            )
        )
    return rows


# Marks a month in which no position closed. Distinct from a month that traded and
# happened to return 0.00% — rendering both as "+0.00%" would let a stretch with no data
# coverage read as a flat but active period.
NO_TRADE = "·"


def monthly_matrix(monthly: pd.Series, closes: pd.Series) -> pd.DataFrame:
    """Year x month grid of returns, the QuantStats monthly-heatmap layout."""
    if monthly.empty:
        return pd.DataFrame()
    traded = closes.reindex(monthly.index).fillna(0) > 0
    frame = pd.DataFrame(
        {
            "year": monthly.index.year,
            "month": monthly.index.month,
            "value": [
                pct(v) if t else NO_TRADE for v, t in zip(monthly.values, traded.values)
            ],
        }
    )
    grid = frame.pivot(index="year", columns="month", values="value")
    grid.columns = [datetime(2000, int(c), 1).strftime("%b") for c in grid.columns]
    return grid


def concentration_note(m: dict) -> str:
    """
    Warns when the trades occupy only a small slice of the simulated window.

    A window in which most months never traded is describing data coverage, not a rate
    of return: "best month" is then one month out of two, and annualising it compounds
    a fortnight into a year. This is the same class of warning as the runner's
    single-cohort check — a result that comes from one corner of the window is an
    artefact of the sample until proven otherwise.
    """
    active, total = m["active_months"], m["total_months"]
    if total == 0 or active >= max(2, total // 2):
        return ""
    return (
        f'<div class="warn"><strong>Trading is concentrated in {active} of {total} '
        f"months.</strong> The other {total - active} closed no position at all, so their "
        f"0.00% is absent data rather than a flat month. Every monthly, quarterly and "
        f"annualised figure below (CAGR, Sharpe, best/worst month) is therefore extrapolated "
        f"from {plural(active, 'month')} of activity — read the trade-level statistics as the "
        f"primary evidence.</div>"
    )


def png_data_uri(path: Path) -> str:
    return "data:image/png;base64," + base64.b64encode(path.read_bytes()).decode("ascii")


HTML_STYLE = """
:root{color-scheme:light;--ink:#1c1917;--muted:#78716c;--rule:#e7e5e4;--paper:#fff;
--panel:#fafaf9;--pos:#0f766e;--neg:#b91c1c;--accent:#2563eb;}
*{box-sizing:border-box}
body{margin:0;background:var(--panel);color:var(--ink);
font:14px/1.55 ui-sans-serif,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;}
.wrap{max-width:1080px;margin:0 auto;padding:40px 24px 72px}
header{border-bottom:2px solid var(--ink);padding-bottom:18px;margin-bottom:28px}
h1{font-size:26px;margin:0 0 6px;letter-spacing:-.02em}
h2{font-size:16px;margin:38px 0 12px;text-transform:uppercase;letter-spacing:.09em;
color:var(--muted);border-bottom:1px solid var(--rule);padding-bottom:7px}
.sub{color:var(--muted);font-size:13px;margin:0}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin:22px 0 4px}
.kpi{background:var(--paper);border:1px solid var(--rule);border-radius:8px;padding:13px 15px}
.kpi .label{font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted)}
.kpi .value{font-size:22px;font-weight:650;margin-top:3px;
font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(310px,1fr));gap:20px}
figure{margin:0 0 8px;background:var(--paper);border:1px solid var(--rule);
border-radius:8px;padding:14px;overflow-x:auto}
figure img{display:block;width:100%;height:auto}
figcaption{color:var(--muted);font-size:12px;margin-top:9px}
.tablewrap{overflow-x:auto;background:var(--paper);border:1px solid var(--rule);border-radius:8px}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
th,td{padding:8px 13px;text-align:right;border-bottom:1px solid var(--rule);white-space:nowrap}
th:first-child,td:first-child{text-align:left}
thead th{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);
background:var(--panel)}
tbody tr:last-child td{border-bottom:none}
.pos{color:var(--pos)} .neg{color:var(--neg)} .dash{color:var(--muted)}
.warn{background:#fef2f2;border:1px solid #fecaca;border-left:4px solid #dc2626;
border-radius:6px;padding:14px 18px;margin:20px 0;font-size:13px;line-height:1.6}
.caveats{background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:16px 20px}
.caveats ol{margin:0;padding-left:20px} .caveats li{margin-bottom:9px;font-size:13px}
.note{background:var(--paper);border-left:3px solid var(--accent);
border-radius:0 6px 6px 0;padding:12px 16px;font-size:13px;color:var(--muted);margin:14px 0}
footer{margin-top:48px;padding-top:16px;border-top:1px solid var(--rule);
color:var(--muted);font-size:12px}
code{background:var(--panel);padding:1px 5px;border-radius:4px;font-size:12px}

/* ---- Print / PDF ----
   The browser drops background fills when printing, which would erase exactly the
   parts that carry the warnings: the red shortfall banner, the amber caveats block,
   and the green/red on every PnL figure. print-color-adjust:exact keeps them. Tables
   and figures are kept off page breaks so a drawdown table never splits mid-row. */
@page{size:A4;margin:13mm 12mm}
@media print{
  :root{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  body{background:var(--paper);font-size:11px}
  .wrap{max-width:none;padding:0}
  h1{font-size:20px} h2{font-size:13px;margin:20px 0 8px;break-after:avoid}
  .kpis{gap:8px} .kpi .value{font-size:16px}
  th,td{padding:4px 7px;font-size:10px}
  figure,.tablewrap,.warn,.note,.caveats li{break-inside:avoid}
  thead{display:table-header-group}
  .caveats li{font-size:10px;margin-bottom:6px}
  figcaption{font-size:9.5px}
  footer{font-size:9.5px}
  a{text-decoration:none;color:inherit}
}
"""


def cell(value: str) -> str:
    if value == DASH:
        return f'<td class="dash">{value}</td>'
    css = "pos" if value.startswith("+") else "neg" if value.startswith("-") else ""
    return f'<td class="{css}">{value}</td>' if css else f"<td>{value}</td>"


def html_table(headers: list[str], rows: list[tuple[str, ...]], empty: str) -> str:
    if not rows:
        return f'<div class="note">{empty}</div>'
    head = "".join(f"<th>{h}</th>" for h in headers)
    body = "".join(
        "<tr>" + f"<td>{r[0]}</td>" + "".join(cell(c) for c in r[1:]) + "</tr>" for r in rows
    )
    return (
        f'<div class="tablewrap"><table><thead><tr>{head}</tr></thead>'
        f"<tbody>{body}</tbody></table></div>"
    )


def partial_year_note(m: dict) -> str:
    """
    Names which calendar years the window only partially covers.

    Derived from the data rather than hard-coded: the achievable window depends on how
    far back the data source served, so a fixed sentence would eventually describe a
    window that was never simulated.
    """
    monthly = m["monthly"]
    if monthly.empty:
        return "No monthly observations, so there is no year to annualise."

    counts = monthly.groupby(monthly.index.year).size()
    partial = [f"{year} ({n} of 12 months)" for year, n in counts.items() if n < 12]
    if not partial:
        return "Every year in this table is a complete 12-month calendar year."
    return (
        "<strong>Partial calendar years:</strong> "
        + ", ".join(partial)
        + ". A partial year is not comparable with a full one, or with another partial "
        "year of a different length — read these as cumulative returns over the months "
        "listed, not as annual rates."
    )


def shortfall_banner(meta: dict) -> str:
    """
    States, at the top of the page, when the window is shorter than the one requested.

    The data source caps free historical OHLCV, so a 365-day request can silently come
    back as roughly six months. A tear sheet that did not say so would let a six-month
    result be quoted as an annual one.
    """
    if not meta.get("windowShortfall"):
        return ""
    requested = meta.get("windowDaysRequested", "?")
    achieved = meta.get("windowDaysAchieved", "?")
    cap = meta.get("freeTierHistoryDays", "?")
    return (
        f'<div class="warn"><strong>This is a {achieved:.0f}-day backtest, not a '
        f"{requested}-day one.</strong> The data source served {achieved:.0f} of the "
        f"{requested} days requested: GeckoTerminal's keyless tier caps hourly OHLCV at "
        f"about {cap} days and answers HTTP 401 beyond it, and daily aggregation is capped "
        f"at the same depth. Every figure on this page describes the window actually "
        f"simulated. Set <code>COINGECKO_PRO_API_KEY</code> to obtain the full year.</div>"
        if isinstance(achieved, (int, float))
        else '<div class="warn"><strong>The simulated window is shorter than requested.</strong> '
        "See the caveats below.</div>"
    )


def cohort_section(meta: dict) -> str:
    """
    Which cohort the trades actually came from, and a warning when they all came from
    one.

    This is the check that caught a real selection artefact in this harness once
    already, and it is the most load-bearing interpretive fact on the page: a run whose
    trades all land on dying pools is describing that corner of the universe, not the
    strategy. It belongs on the page people share, not only in the terminal.
    """
    trades = (meta.get("scenarios", {}).get("unbiased", {}) or {}).get("trades") or []
    if not trades:
        return ""

    universe = meta.get("universe", {})
    offered = {"survivor": universe.get("survivors"), "dead-or-dormant": universe.get("dead")}

    tally: dict[str, dict] = {}
    for t in trades:
        row = tally.setdefault(t.get("cohort", "unknown"), {"n": 0, "pnl": 0.0})
        row["n"] += 1
        row["pnl"] += float(t.get("netPnlUsd", 0.0))

    total = len(trades)
    rows = [
        (
            cohort,
            str(offered.get(cohort, DASH)),
            str(v["n"]),
            upct(v["n"] / total),
            money(v["pnl"]),
        )
        for cohort, v in sorted(tally.items(), key=lambda kv: -kv[1]["n"])
    ]
    # Cohorts that were offered pools but never traded matter as much as those that did.
    for cohort, count in offered.items():
        if cohort not in tally and count:
            rows.append((cohort, str(count), "0", upct(0), money(0)))

    warning = ""
    if len(tally) == 1:
        only = next(iter(tally))
        warning = (
            f'<div class="warn"><strong>Every trade came from the "{only}" cohort.</strong> '
            "That is a selection artefact of the universe or the TVL model, not a property "
            "of the strategy. The headline return describes that cohort only — the other "
            "cohort was offered pools and took none of them.</div>"
        )

    return (
        "<h2>Cohort Composition</h2>"
        + warning
        + html_table(
            ["Cohort", "Pools offered", "Trades", "Share", "Net PnL"], rows, "No trades."
        )
    )


def scenario_section(meta: dict) -> str:
    """
    The A/B runs and the assumption sweep, side by side with the headline.

    The TVL-model quartiles are not a refinement of the headline — fee income scales as
    1/k and the fitted IQR spans a factor of four, so the p25 run loses money and the
    p75 run never trades. A page that showed only the median run would present one draw
    from that range as the result.
    """
    scenarios = meta.get("scenarios", {})
    if not scenarios:
        return ""

    def row(label: str, summary: dict | None) -> tuple[str, ...] | None:
        if not summary:
            return None
        pfv = summary.get("profitFactor")
        return (
            label,
            str(summary.get("totalTrades", DASH)),
            upct((summary.get("winRatePct") or 0) / 100),
            DASH if pfv is None else ratio(pfv),
            money(summary.get("netPnlUsd")),
            money(summary.get("endingEquityUsd")),
            upct(-(summary.get("maxDrawdownPct") or 0) / 100).lstrip("-") or "0.00%",
        )

    head = (scenarios.get("unbiased") or {}).get("summary")
    rows = [
        row("Headline — full V1.1 guardrails", head),
        row("Anti-churn gates OFF", (scenarios.get("noChurn") or {}).get("summary")),
        row("Survivors only (biased universe)", (scenarios.get("biased") or {}).get("summary")),
    ]
    for band in scenarios.get("kBand") or []:
        rows.append(row(band.get("label", "k"), band.get("summary")))

    return "<h2>Scenario &amp; Assumption Sensitivity</h2>" + html_table(
        ["Scenario", "Trades", "Win rate", "Profit factor", "Net PnL", "Final equity", "Max DD"],
        [r for r in rows if r],
        "No scenarios recorded.",
    )


def build_html(m: dict, meta: dict, charts: dict[str, Path], data: Inputs) -> str:
    groups = metric_rows(m)
    summary = (meta.get("scenarios", {}).get("unbiased", {}) or {}).get("summary", {})
    config = meta.get("config", {})
    tvl = meta.get("tvlModel", {})
    universe = meta.get("universe", {})

    window = (
        f"{m['start']:%d %b %Y} → {m['end']:%d %b %Y}"
        if m["start"] is not None
        else "unknown window"
    )

    kpis = [
        ("Total return", pct(m["total_return"])),
        ("Final equity", money(data.equity.iloc[-1] if len(data.equity) else None)),
        ("Max drawdown", pct(m["max_drawdown"])),
        ("Sharpe", ratio(m["sharpe"])),
        ("Profit factor", ratio(summary.get("profitFactor")) if summary.get("profitFactor") is not None else DASH),
        ("Trades", str(summary.get("totalTrades", DASH))),
    ]
    kpi_html = "".join(
        f'<div class="kpi"><div class="label">{k}</div><div class="value">{v}</div></div>'
        for k, v in kpis
    )

    metric_html = ""
    for title, rows in groups.items():
        metric_html += f"<h2>{title}</h2>" + html_table(
            ["Metric", "Value"], [(a, b) for a, b in rows], "No data."
        )

    grid = monthly_matrix(m["monthly"], m["monthly_closes"])
    if grid.empty:
        monthly_html = '<div class="note">No monthly observations.</div>'
    else:
        monthly_html = html_table(
            ["Year"] + list(grid.columns),
            [
                tuple([str(int(year))] + [DASH if pd.isna(v) else str(v) for v in row])
                for year, row in grid.iterrows()
            ],
            "No monthly observations.",
        ) + (
            f'<div class="note"><code>{NO_TRADE}</code> = no position closed that month. '
            "Its realised return is 0.00%, but that is absent activity, not a flat month.</div>"
        )

    caveats = meta.get("caveats") or [
        "No caveats block was found in the backtest JSON. Do not quote these numbers "
        "without re-reading the assumptions in src/backtest/historicalData.ts."
    ]
    caveats_html = "".join(f"<li>{c}</li>" for c in caveats)

    tvl_note = ""
    if tvl:
        tvl_note = (
            f"Modelled TVL: k = {tvl.get('medianK', float('nan')):.3f} median "
            f"(p25 {tvl.get('p25K', float('nan')):.3f}, p75 {tvl.get('p75K', float('nan')):.3f}, "
            f"n = {tvl.get('samples', '?')}). Fee income scales as 1/k, so that IQR is the "
            f"error bar on every return figure on this page."
        )

    qs_note = (
        "Metrics are computed with the <code>quantstats</code> library where it defines "
        "them; a metric it cannot compute renders as — rather than as zero."
        if QS_AVAILABLE
        else f'<strong>quantstats unavailable</strong> ({QS_ERROR}); ratio metrics fell back to "—".'
    )

    figures = "".join(
        f"<figure><img src=\"{png_data_uri(path)}\" alt=\"{name}\">"
        f"<figcaption>{caption}</figcaption></figure>"
        for name, path, caption in [
            (
                "Distribution of Monthly Returns",
                charts["monthly"],
                "Chart 1 — compounded monthly returns. The black curve is the normal density "
                "implied by this sample's own mean and standard deviation; it is a reference "
                "shape, not a claim that the returns are normal. Red dashed line is the mean.",
            ),
            (
                "Daily Returns",
                charts["daily"],
                "Chart 2 — realised daily returns across the whole window. Flat stretches are "
                "days on which no position closed; on a realised-only curve those are genuinely "
                "0.00%, not missing data.",
            ),
            (
                "Equity and drawdown",
                charts["equity"],
                "Realised equity and its underwater plot, for context on the two charts above.",
            ),
        ]
    )

    return f"""<title>DLMM V1.1 Tear Sheet</title>
<style>{HTML_STYLE}</style>
<div class="wrap">
<header>
  <h1>DLMM V1.1 — Backtest Tear Sheet</h1>
  <p class="sub">{window} &nbsp;·&nbsp; {m['calendar_days']} calendar days &nbsp;·&nbsp;
  {m['active_days']} days with a close ({upct(m['active_day_share'], 1)}) &nbsp;·&nbsp;
  ${config.get('startingCapitalUsd', '?')} starting capital &nbsp;·&nbsp;
  universe {universe.get('survivors', '?')} survivors + {universe.get('dead', '?')} dead/dormant</p>
</header>

{shortfall_banner(meta)}
{concentration_note(m)}
<div class="kpis">{kpi_html}</div>

<div class="note">{qs_note}{(' ' + tvl_note) if tvl_note else ''}</div>

<h2>Charts</h2>
{figures}

{metric_html}

{scenario_section(meta)}

{cohort_section(meta)}

<h2>EOY Returns</h2>
{html_table(["Year", "Return", "Months", "Best month", "Worst month"], eoy_rows(m),
            "No completed year in the window.")}
<div class="note">{partial_year_note(m)}</div>

<h2>Monthly Returns</h2>
{monthly_html}

<h2>Worst Drawdowns</h2>
{html_table(["Started", "Valley", "Recovered", "Days", "Depth"], worst_drawdown_rows(m),
            "The equity curve never traded below its running peak.")}

<h2>Caveats</h2>
<div class="caveats"><ol>{caveats_html}</ol></div>

<footer>
Generated {datetime.now():%Y-%m-%d %H:%M} from
<code>reports/annual/daily_returns.csv</code>. Paper simulation — zero capital deployed,
nothing signed on-chain. Data fetched {meta.get('dataFetchedAt', 'unknown')}.
</footer>
</div>
"""


def build_markdown(m: dict, meta: dict) -> str:
    lines = ["# DLMM V1.1 — Backtest Tear Sheet", ""]
    if m["start"] is not None:
        lines.append(
            f"**Window:** {m['start']:%Y-%m-%d} → {m['end']:%Y-%m-%d} "
            f"({m['calendar_days']} days, {m['active_days']} with a close)"
        )
        lines.append("")

    for title, rows in metric_rows(m).items():
        lines += [f"## {title}", "", "| Metric | Value |", "| --- | ---: |"]
        lines += [f"| {a} | {b} |" for a, b in rows]
        lines.append("")

    lines += ["## EOY Returns", "", "| Year | Return | Months | Best month | Worst month |",
              "| --- | ---: | ---: | ---: | ---: |"]
    for row in eoy_rows(m) or [("—", DASH, DASH, DASH, DASH)]:
        lines.append("| " + " | ".join(row) + " |")
    lines.append("")

    lines += ["## Worst Drawdowns", "", "| Started | Valley | Recovered | Days | Depth |",
              "| --- | --- | --- | ---: | ---: |"]
    for row in worst_drawdown_rows(m) or [("—", "—", "—", DASH, DASH)]:
        lines.append("| " + " | ".join(row) + " |")
    lines.append("")

    lines += ["## Caveats", ""]
    for i, c in enumerate(meta.get("caveats", []), 1):
        lines.append(f"{i}. {c}")
    lines.append("")
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# PDF                                                                          #
# --------------------------------------------------------------------------- #

# Chrome and Edge both ship a headless PDF printer that honours the page's own CSS,
# so the PDF is the same document rather than a re-layout. Preferring an already
# installed browser keeps this step dependency-free: weasyprint needs GTK on Windows,
# and playwright would download a second browser.
BROWSER_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
]


def find_browser() -> str | None:
    for candidate in BROWSER_CANDIDATES:
        if Path(candidate).exists():
            return candidate
    for name in ("chrome", "chromium", "google-chrome", "msedge"):
        found = shutil.which(name)
        if found:
            return found
    return None


def render_pdf(html_path: Path, pdf_path: Path) -> str | None:
    """
    Prints the tear sheet to PDF with headless Chrome or Edge.

    Returns None on success, or a human-readable reason on failure. The PDF is a
    convenience export, so a missing browser must not fail a run that already wrote
    the HTML.
    """
    browser = find_browser()
    if browser is None:
        return "no Chrome or Edge found on PATH or in the usual install locations"

    # Both the file:// URL and --print-to-pdf need absolute paths: the browser runs
    # with its own working directory, so a relative path silently resolves elsewhere.
    html_path = html_path.resolve()
    pdf_path = pdf_path.resolve()

    # A throwaway profile directory keeps this off the user's running browser, which
    # otherwise makes headless exit immediately without writing anything.
    with tempfile.TemporaryDirectory() as profile:
        command = [
            browser,
            "--headless=new",
            "--disable-gpu",
            "--no-sandbox",
            f"--user-data-dir={profile}",
            "--no-pdf-header-footer",
            # The page inlines its images as data URIs, so nothing is fetched over the
            # network; the budget only covers layout and font resolution.
            "--virtual-time-budget=15000",
            f"--print-to-pdf={pdf_path}",
            html_path.as_uri(),
        ]
        try:
            done = subprocess.run(command, capture_output=True, timeout=180, text=True)
        except FileNotFoundError:
            return f"could not execute {browser}"
        except subprocess.TimeoutExpired:
            return "the browser did not finish within 180s"

    if not pdf_path.exists() or pdf_path.stat().st_size == 0:
        detail = (done.stderr or done.stdout or "").strip().splitlines()
        tail = detail[-1] if detail else f"exit code {done.returncode}"
        return f"the browser wrote no PDF ({tail})"
    return None


# --------------------------------------------------------------------------- #
# Entry point                                                                  #
# --------------------------------------------------------------------------- #


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--daily", default="reports/annual/daily_returns.csv")
    parser.add_argument("--json", dest="meta", default="reports/annual/backtest_annual.json")
    parser.add_argument("--outdir", default="reports/annual")
    parser.add_argument(
        "--skip-quantstats-html",
        action="store_true",
        help="Skip QuantStats' own tear sheet (the slowest step).",
    )
    parser.add_argument(
        "--no-pdf",
        action="store_true",
        help="Skip the PDF export (headless Chrome/Edge).",
    )
    args = parser.parse_args()

    outdir = Path(args.outdir)
    charts_dir = outdir / "charts"
    charts_dir.mkdir(parents=True, exist_ok=True)

    data = load(Path(args.daily), Path(args.meta) if args.meta else None)
    m = build_metrics(data)

    charts = {
        "monthly": chart_monthly_distribution(
            m["monthly"], data.closes.resample("ME").sum(),
            charts_dir / "monthly_returns_distribution.png"
        ),
        "daily": chart_daily_returns(
            data.returns, data.closes, charts_dir / "daily_returns.png"
        ),
        "equity": chart_equity_and_drawdown(
            data.equity, m["drawdown"], charts_dir / "equity_and_drawdown.png"
        ),
    }

    html_path = outdir / "tearsheet.html"
    html_path.write_text(build_html(m, data.meta, charts, data), encoding="utf8")

    md_path = outdir / "tearsheet.md"
    md_path.write_text(build_markdown(m, data.meta), encoding="utf8")

    # ---- Terminal ----
    if m["start"] is not None:
        print(
            f"\nDLMM V1.1 — annual tear sheet\n"
            f"{m['start']:%Y-%m-%d} → {m['end']:%Y-%m-%d}  "
            f"({m['calendar_days']} calendar days, {m['active_days']} with a close)"
        )
    for title, rows in metric_rows(m).items():
        print(terminal_table(title, rows))

    print(terminal_table("EOY / Yearly Returns", [(r[0], r[1]) for r in eoy_rows(m)] or [("(none)", DASH)]))
    print(
        terminal_table(
            "Worst Drawdowns (depth · duration)",
            [(f"{r[0]} → {r[2]}", f"{r[4]} over {r[3]}d") for r in worst_drawdown_rows(m)]
            or [("(none)", DASH)],
        )
    )

    qs_html = outdir / "quantstats-full.html"
    if QS_AVAILABLE and not args.skip_quantstats_html:
        try:
            qs.reports.html(
                data.returns,
                output=str(qs_html),
                title="DLMM V1.1 — Backtest (QuantStats)",
                download_filename=str(qs_html),
            )
            print(f"\n[quant] quantstats tear sheet → {qs_html}")
        except Exception as exc:
            # QuantStats' full report is a bonus, not the deliverable. It reaches for a
            # benchmark and a rolling window that a sparse one-year series may not
            # support; say so rather than failing the run.
            print(f"\n[quant] quantstats full tear sheet unavailable ({type(exc).__name__}: {exc})")
            print("[quant] the tear sheet below is unaffected.")

    print(f"\n[quant] charts     → {charts_dir}")
    print(f"[quant] tear sheet → {html_path}")
    print(f"[quant] markdown   → {md_path}")

    if not args.no_pdf:
        pdf_path = outdir / "tearsheet.pdf"
        problem = render_pdf(html_path, pdf_path)
        if problem is None:
            print(f"[quant] pdf        → {pdf_path} ({pdf_path.stat().st_size // 1024} KB)")
        else:
            print(f"[quant] PDF export skipped: {problem}")
            print(f"[quant] open {html_path} and print to PDF from the browser instead.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
