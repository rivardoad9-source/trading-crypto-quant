"use client";

import { useMemo, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { formatSignedUsd, type PnlCalendar as PnlCalendarData } from "@/lib/api";

interface Props {
  data: PnlCalendarData | null;
  month: string;
  onMonthChange: (month: string) => void;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export default function PnlCalendar({ data, month, onMonthChange }: Props) {
  const [hovered, setHovered] = useState<string | null>(null);

  /**
   * Heatmap intensity is scaled to the largest absolute PnL in the month, so a quiet
   * month still shows contrast instead of washing out to a single flat colour.
   */
  const maxAbs = useMemo(() => {
    if (!data) return 0;
    return data.days.reduce((max, d) => Math.max(max, Math.abs(d.netPnlUsd)), 0);
  }, [data]);

  const monthLabel = useMemo(() => {
    const [y, m] = month.split("-").map(Number) as [number, number];
    return new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-GB", {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    });
  }, [month]);

  const cells = useMemo(() => {
    if (!data) return [];
    // Pad the leading blanks so day 1 lands under the right weekday.
    return [
      ...Array.from({ length: data.firstWeekday }, () => null),
      ...data.days,
    ];
  }, [data]);

  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900/40">
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight text-zinc-200">
          <CalendarDays className="h-4 w-4 text-zinc-500" />
          PnL Calendar
        </h2>
        <div className="flex items-center gap-1">
          <NavButton onClick={() => onMonthChange(shiftMonth(month, -1))} label="Previous month">
            <ChevronLeft className="h-3.5 w-3.5" />
          </NavButton>
          <span className="min-w-[120px] text-center text-[11px] font-medium text-zinc-300">
            {monthLabel}
          </span>
          <NavButton onClick={() => onMonthChange(shiftMonth(month, 1))} label="Next month">
            <ChevronRight className="h-3.5 w-3.5" />
          </NavButton>
        </div>
      </div>

      <div className="p-4">
        <div className="mb-2 grid grid-cols-7 gap-1.5">
          {WEEKDAYS.map((d) => (
            <div key={d} className="text-center text-[10px] font-medium text-zinc-600">
              {d}
            </div>
          ))}
        </div>

        <div className="grid grid-cols-7 gap-1.5">
          {cells.map((cell, i) =>
            cell === null ? (
              <div key={`pad-${i}`} className="aspect-square" />
            ) : (
              <div
                key={cell.date}
                onMouseEnter={() => setHovered(cell.date)}
                onMouseLeave={() => setHovered(null)}
                title={`${cell.date} · ${cell.trades} trade${cell.trades === 1 ? "" : "s"} · ${formatSignedUsd(cell.netPnlUsd)}`}
                className="group relative flex aspect-square flex-col items-center justify-center rounded border transition-colors"
                style={cellStyle(cell.netPnlUsd, cell.trades, maxAbs)}
              >
                <span className="text-[10px] font-medium text-zinc-400 group-hover:text-zinc-200">
                  {cell.day}
                </span>
                {cell.trades > 0 && (
                  <span
                    className={`font-mono text-[9px] font-semibold ${
                      cell.netPnlUsd >= 0 ? "text-emerald-300" : "text-rose-300"
                    }`}
                  >
                    {cell.netPnlUsd >= 0 ? "+" : "−"}
                    {Math.abs(cell.netPnlUsd).toFixed(Math.abs(cell.netPnlUsd) >= 100 ? 0 : 1)}
                  </span>
                )}
                {hovered === cell.date && cell.trades > 0 && (
                  <div className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-1.5 -translate-x-1/2 whitespace-nowrap rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-[10px] shadow-xl">
                    <span className="text-zinc-400">{cell.trades} closed</span>
                    <span className="mx-1 text-zinc-700">·</span>
                    <span className="text-emerald-400">{cell.wins}W</span>
                    <span className="mx-0.5 text-zinc-700">/</span>
                    <span className="text-rose-400">{cell.losses}L</span>
                  </div>
                )}
              </div>
            ),
          )}
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-zinc-800 pt-3">
          <div className="flex items-center gap-1.5 text-[10px] text-zinc-600">
            <span>Loss</span>
            <Swatch color="rgba(244,63,94,0.55)" />
            <Swatch color="rgba(244,63,94,0.25)" />
            <Swatch color="rgba(39,39,42,0.4)" />
            <Swatch color="rgba(16,185,129,0.25)" />
            <Swatch color="rgba(16,185,129,0.55)" />
            <span>Profit</span>
          </div>

          {data && (
            <div className="flex items-center gap-4 text-[11px]">
              <Stat label="Month net">
                <span
                  className={
                    data.monthNetPnlUsd >= 0 ? "text-emerald-400" : "text-rose-400"
                  }
                >
                  {formatSignedUsd(data.monthNetPnlUsd)}
                </span>
              </Stat>
              <Stat label="Trades">
                <span className="text-zinc-300">{data.monthTrades}</span>
              </Stat>
              <Stat label="Win rate">
                <span className="text-zinc-300">
                  {data.monthTrades > 0 ? `${data.monthWinRatePct.toFixed(0)}%` : "—"}
                </span>
              </Stat>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function cellStyle(pnl: number, trades: number, maxAbs: number): React.CSSProperties {
  if (trades === 0) {
    return { backgroundColor: "rgba(24,24,27,0.5)", borderColor: "rgba(39,39,42,0.7)" };
  }
  // Floor the intensity so a tiny non-zero day is still visible.
  const intensity = maxAbs > 0 ? Math.max(0.18, Math.abs(pnl) / maxAbs) : 0.18;
  const rgb = pnl >= 0 ? "16,185,129" : "244,63,94";
  return {
    backgroundColor: `rgba(${rgb},${(intensity * 0.55).toFixed(3)})`,
    borderColor: `rgba(${rgb},${(intensity * 0.7).toFixed(3)})`,
  };
}

const Swatch = ({ color }: { color: string }) => (
  <span className="h-3 w-3 rounded-sm border border-zinc-800" style={{ backgroundColor: color }} />
);

const Stat = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <span>
    <span className="text-zinc-600">{label} </span>
    <span className="font-mono font-semibold">{children}</span>
  </span>
);

function NavButton({
  onClick,
  label,
  children,
}: {
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      className="rounded border border-zinc-800 bg-zinc-950 p-1 text-zinc-500 transition-colors hover:border-zinc-700 hover:text-zinc-300"
    >
      {children}
    </button>
  );
}
