"use client";

import { useEffect, useState } from "react";
import { Activity, AlertTriangle, Clock, ShieldCheck, WifiOff } from "lucide-react";
import type { Overview } from "@/lib/api";

interface Props {
  overview: Overview | null;
  connected: boolean;
  lastUpdated: Date | null;
}

export default function StatusHeader({ overview, connected, lastUpdated }: Props) {
  // Rendered client-side only: a server-rendered clock would mismatch on hydration.
  const [clock, setClock] = useState<string>("--:--:--");

  useEffect(() => {
    const tick = () => {
      setClock(
        new Intl.DateTimeFormat("en-GB", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          timeZone: overview?.timezone ?? "Asia/Jakarta",
        }).format(new Date()),
      );
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [overview?.timezone]);

  const online = connected && overview?.serverStatus === "ONLINE";

  return (
    <header className="border-b border-zinc-800 bg-zinc-950/80 backdrop-blur">
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-4 px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-md border border-emerald-500/30 bg-emerald-500/10">
            <Activity className="h-5 w-5 text-emerald-400" strokeWidth={2.25} />
          </div>
          <div>
            <h1 className="text-base font-semibold tracking-tight text-zinc-100">
              FlowMetrix
              <span className="ml-2 text-xs font-normal text-zinc-500">
                Meteora DLMM Command Center
              </span>
            </h1>
            <p className="text-[11px] text-zinc-600">
              Solana · Meteora DLMM · DeepSeek reasoning engine
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {/* DRY-RUN is the safety-critical fact on this page; it never gets a subtle style. */}
          {overview?.isDryRun ? (
            <Badge tone="emerald" icon={<ShieldCheck className="h-3.5 w-3.5" />}>
              DRY-RUN · ZERO CAPITAL
            </Badge>
          ) : overview ? (
            <Badge tone="rose" icon={<AlertTriangle className="h-3.5 w-3.5" />}>
              LIVE MODE
            </Badge>
          ) : null}

          <Badge
            tone={online ? "emerald" : "rose"}
            icon={
              online ? (
                <span className="pulse-dot inline-block h-2 w-2 rounded-full bg-emerald-400" />
              ) : (
                <WifiOff className="h-3.5 w-3.5" />
              )
            }
          >
            {online ? "ENGINE ONLINE" : "ENGINE OFFLINE"}
          </Badge>

          <Badge tone="zinc" icon={<Clock className="h-3.5 w-3.5" />}>
            <span className="font-mono">{clock}</span>
            <span className="ml-1.5 text-zinc-600">{overview?.timezone ?? "Asia/Jakarta"}</span>
          </Badge>

          <span className="text-[11px] text-zinc-600">
            {lastUpdated
              ? `synced ${lastUpdated.toLocaleTimeString("en-GB")}`
              : "awaiting first sync"}
          </span>
        </div>
      </div>
    </header>
  );
}

function Badge({
  tone,
  icon,
  children,
}: {
  tone: "emerald" | "rose" | "zinc";
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  const tones = {
    emerald: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
    rose: "border-rose-500/30 bg-rose-500/10 text-rose-300",
    zinc: "border-zinc-800 bg-zinc-900 text-zinc-400",
  } as const;

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-medium tracking-wide ${tones[tone]}`}
    >
      {icon}
      {children}
    </span>
  );
}
