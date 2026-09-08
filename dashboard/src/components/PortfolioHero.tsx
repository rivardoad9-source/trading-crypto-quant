"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Copy, Eye, EyeOff, RefreshCw, Wallet, WifiOff } from "lucide-react";
import type { Overview, WalletSnapshot } from "@/lib/api";

/**
 * Jupiter-portfolio-style hero: wallet identity, total balance, and today's PnL.
 *
 * The balance shown here is the LIVE ON-CHAIN wallet, read from the RPC. It is
 * deliberately not `overview.currentBalanceUSD`, which is `startingBalanceUSD` plus
 * realised paper PnL — a simulation baseline, not custody. The two are different
 * numbers and the card says so, because a paper equity figure rendered as a portfolio
 * balance is a fabricated balance with a dollar sign in front of it.
 *
 * For the same reason the PnL row is labelled PAPER while the engine is in dry run:
 * putting an unlabelled PnL under a real balance implies the one moved the other.
 */

interface Props {
  wallet: WalletSnapshot | null;
  overview: Overview | null;
  onRefresh: () => void;
  refreshing: boolean;
}

const HIDDEN = "••••••";

/** Persisted so the balance stays hidden across reloads once someone hides it. */
const HIDE_KEY = "flowmetrix.hideBalance";

export default function PortfolioHero({ wallet, overview, onRefresh, refreshing }: Props) {
  const [hidden, setHidden] = useState(false);
  const [copied, setCopied] = useState(false);

  // Read after mount, never during render: localStorage does not exist on the server
  // and reading it during render would mismatch on hydration.
  useEffect(() => {
    try {
      setHidden(window.localStorage.getItem(HIDE_KEY) === "1");
    } catch {
      /* private mode, or site data blocked — the default (visible) is fine */
    }
  }, []);

  const toggleHidden = useCallback(() => {
    setHidden((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(HIDE_KEY, next ? "1" : "0");
      } catch {
        /* non-fatal: the toggle still works for this session */
      }
      return next;
    });
  }, []);

  const copyAddress = useCallback(() => {
    if (!wallet?.address) return;
    void navigator.clipboard
      .writeText(wallet.address)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      })
      .catch(() => {
        /* clipboard denied — the address is still selectable in the tooltip */
      });
  }, [wallet?.address]);

  const unavailable = wallet === null || wallet.status !== "ok" || wallet.sol === null;
  const todayPnl = overview?.todayRealizedPnLUSD ?? null;

  return (
    /*
      The hero shrinks when there is no wallet to show.

      With SOLANA_WALLET_ADDRESS unset — every dev machine — the full-height layout
      renders a 6xl em dash and a warning across ~230px of the fold, pushing the
      figures that DO exist below it. The band still appears, because the reason no
      balance is shown is itself worth stating; it just stops being the largest
      element on the page.
    */
    <section className="border-b border-zinc-800 bg-gradient-to-b from-zinc-900/60 to-zinc-950">
      <div
        className={`mx-auto flex max-w-[1600px] flex-col items-center gap-3 px-6 ${
          wallet?.status === "unconfigured" ? "py-4" : "py-8"
        }`}
      >
        {/* ---- wallet identity ---- */}
        <div className="flex w-full items-start justify-between gap-4">
          <WalletBadge wallet={wallet} copied={copied} onCopy={copyAddress} />

          <div className="flex items-center gap-1.5">
            <IconButton
              label={hidden ? "Show balance" : "Hide balance"}
              onClick={toggleHidden}
            >
              {hidden ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </IconButton>
            <IconButton label="Refresh balance" onClick={onRefresh} disabled={refreshing}>
              <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
            </IconButton>
          </div>
        </div>

        {/* ---- total balance ---- */}
        {wallet?.status === "unconfigured" ? (
          /*
            No wallet configured — every dev machine. The full treatment renders a 6xl
            em dash and "— SOL" across the fold, so the largest thing on the page is
            the absence of a number. The reason is still stated (below), it just does
            not outrank the figures that exist.
          */
          <div className="flex flex-col items-center text-center">
            <span className="text-[11px] uppercase tracking-widest text-zinc-600">
              Wallet Balance · on-chain
            </span>
            <span className="font-mono text-lg text-zinc-600">not configured</span>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-1 py-1 text-center">
            <span className="text-[11px] uppercase tracking-widest text-zinc-500">
              Wallet Balance · on-chain
            </span>

            <span className="font-mono text-5xl font-semibold tracking-tight text-zinc-50 tabular-nums sm:text-6xl">
              {hidden ? HIDDEN : formatUsd(wallet?.usd ?? null)}
            </span>

            <span className="font-mono text-sm text-zinc-400 tabular-nums">
              {hidden ? HIDDEN : formatSol(wallet?.sol ?? null)}
              {!hidden && wallet?.solPriceUsd != null && (
                <span className="ml-2 text-zinc-600">@ ${wallet.solPriceUsd.toFixed(2)}/SOL</span>
              )}
            </span>
          </div>
        )}

        {/* ---- today's PnL ---- */}
        <TodayPnl value={hidden ? null : todayPnl} hidden={hidden} isDryRun={overview?.isDryRun} />

        {/*
          A failed read is stated, not smoothed over. Rendering a dash where a balance
          belongs and saying why beats showing "$0.00", which is indistinguishable from
          an empty wallet.
        */}
        {unavailable && (
          <p className="flex items-center gap-1.5 text-[11px] text-amber-400/80">
            <WifiOff className="h-3 w-3" />
            {wallet?.status === "unconfigured"
              ? "SOLANA_WALLET_ADDRESS is not set — no wallet to read"
              : `Balance unavailable via ${wallet?.endpoint ?? "RPC"}`}
          </p>
        )}

        {wallet?.checkedAt && !unavailable && (
          <p className="text-[10px] text-zinc-600">
            read {new Date(wallet.checkedAt).toLocaleTimeString("en-GB")} · {wallet.endpoint}
          </p>
        )}
      </div>
    </section>
  );
}

function WalletBadge({
  wallet,
  copied,
  onCopy,
}: {
  wallet: WalletSnapshot | null;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <div className="flex h-9 w-9 items-center justify-center rounded-full border border-zinc-700 bg-zinc-800/80">
        <Wallet className="h-4 w-4 text-zinc-300" />
      </div>
      <div className="leading-tight">
        <p className="text-sm font-semibold text-zinc-100">{wallet?.label ?? "Wallet"}</p>
        {wallet?.address ? (
          <button
            type="button"
            onClick={onCopy}
            title={wallet.address}
            className="group flex items-center gap-1 font-mono text-[11px] text-zinc-500 transition hover:text-zinc-300"
          >
            {truncateAddress(wallet.address)}
            {copied ? (
              <Check className="h-3 w-3 text-emerald-400" />
            ) : (
              <Copy className="h-3 w-3 opacity-0 transition group-hover:opacity-100" />
            )}
          </button>
        ) : (
          <p className="font-mono text-[11px] text-zinc-600">not configured</p>
        )}
      </div>
    </div>
  );
}

function TodayPnl({
  value,
  hidden,
  isDryRun,
}: {
  value: number | null;
  hidden: boolean;
  isDryRun: boolean | undefined;
}) {
  if (hidden) {
    return <span className="font-mono text-sm text-zinc-500">Today&apos;s PnL: {HIDDEN}</span>;
  }
  if (value === null) {
    return <span className="font-mono text-sm text-zinc-500">Today&apos;s PnL: —</span>;
  }

  /*
   * Zero is its own case, and it is neutral. Colouring 0.00 green would read as a gain
   * on a day nothing closed — which is exactly the state a freshly reset database is in.
   */
  const tone =
    value > 0 ? "text-emerald-400" : value < 0 ? "text-rose-400" : "text-zinc-400";
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";

  return (
    <div className="flex items-center gap-2">
      <span className={`font-mono text-sm font-medium tabular-nums ${tone}`}>
        Today&apos;s PnL: {sign}${Math.abs(value).toFixed(2)}
      </span>
      {/*
        Tagged in BOTH modes, because the figure is the engine's in both.

        It was tagged only while `isDryRun`, on the reasoning that a paper number needs
        the warning and a real one does not. But this is `todayRealizedPnLUSD` — the same
        valuation model that values simulated positions, which cannot see the balancing
        swap's slippage, the priority fees or bin-array rent. Untagged and sitting
        directly under a balance read from the chain, it reads as the amount that
        balance moved today. That is the custody claim the KPI card one row down was
        relabelled "Book Equity" to avoid, left standing in the more prominent place.

        `undefined` means the overview has not loaded, so nothing is asserted yet.
      */}
      {isDryRun === true && (
        <span
          title="Paper PnL — this engine is in dry run and holds no on-chain positions."
          className="rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-zinc-500"
        >
          paper
        </span>
      )}
      {isDryRun === false && (
        <span
          title="Engine accounting, not the wallet: the valuation model does not see swap slippage, priority fees or bin-array rent. The Wallet Reconciliation panel measures the gap."
          className="rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-amber-500/80"
        >
          book
        </span>
      )}
    </div>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="rounded-md border border-zinc-800 bg-zinc-900/80 p-2 text-zinc-400 transition hover:border-zinc-700 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  );
}

/** `null` renders as an em dash. Never as 0 — an unknown balance is not an empty one. */
function formatUsd(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatSol(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "— SOL";
  return `${value.toFixed(4)} SOL`;
}

export function truncateAddress(address: string): string {
  return address.length <= 12 ? address : `${address.slice(0, 4)}…${address.slice(-4)}`;
}
