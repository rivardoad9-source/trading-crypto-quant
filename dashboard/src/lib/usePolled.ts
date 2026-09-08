"use client";

import { useEffect, useRef, useState } from "react";

/**
 * How often the self-fetching panels re-read.
 *
 * Deliberately slower than the page's 10s trade poll. Neither of these panels moves on
 * that clock: the screener writes a funnel row every 30 minutes and reconciliation only
 * changes when a live position closes, which the 60s fast monitor is what notices. One
 * minute is the fastest either can produce new information.
 */
export const PANEL_POLL_MS = 60_000;

export interface Polled<T> {
  data: T | null;
  /** True only while NOTHING has ever loaded — the panel hides rather than showing an error. */
  failed: boolean;
}

/**
 * Polls one read-only endpoint on its own clock, for panels that fetch for themselves.
 *
 * `ScanFunnel` and `Reconciliation` stay outside the page's `Promise.all` on purpose:
 * their routes may be absent on an older engine, and a 404 inside that batch would take
 * the whole dashboard's refresh down with it. The cost of that independence was that
 * both fetched ONCE on mount and never again — a funnel panel titled "why nothing
 * opened" answering with the cycle that happened to be latest when the tab was opened,
 * and a reconciliation panel that stays absent through the first live close because it
 * asked before there was anything to measure. On a command centre left open all day
 * that is a stale claim with nothing on screen saying it is stale.
 *
 * Two rules here mirror the page loop:
 *
 *  - A failure AFTER a success keeps the last good data on screen instead of hiding the
 *    panel. `failed` means "this endpoint has never answered" — one dropped poll must
 *    not make a working panel blink out, and the poll loop in `page.tsx` already owns
 *    reporting a connection outage.
 *  - Polling stops while the tab is hidden and resumes on focus, so background tabs do
 *    not keep hitting the engine.
 */
export function usePolled<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  intervalMs: number = PANEL_POLL_MS,
): Polled<T> {
  const [data, setData] = useState<T | null>(null);
  const [failed, setFailed] = useState(false);

  /*
   * The fetcher is typically an inline arrow, so a new identity every render. Holding it
   * in a ref keeps it out of the effect's dependencies — otherwise the interval would be
   * torn down and rebuilt on every render and effectively never fire.
   */
  const fetcherRef = useRef(fetcher);
  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  useEffect(() => {
    const controller = new AbortController();
    let loadedOnce = false;

    const read = () => {
      void fetcherRef
        .current(controller.signal)
        .then((next) => {
          if (controller.signal.aborted) return;
          loadedOnce = true;
          setData(next);
          setFailed(false);
        })
        .catch(() => {
          // Only a panel that has never loaded hides. See the note above.
          if (!controller.signal.aborted && !loadedOnce) setFailed(true);
        });
    };

    read();

    const id = setInterval(() => {
      if (document.visibilityState === "visible") read();
    }, intervalMs);

    const onVisible = () => {
      if (document.visibilityState === "visible") read();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      controller.abort();
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [intervalMs]);

  return { data, failed };
}

/**
 * "3h ago" for a stored UTC timestamp.
 *
 * The funnel panel needs this because the alternative to a visible age is an invisible
 * one: a cycle from this morning renders identically to one from a minute ago, and the
 * panel's whole job is to say why the engine has not traded *lately*.
 */
export function formatAge(from: Date, now: number = Date.now()): string {
  const seconds = Math.floor((now - from.getTime()) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 90) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 90) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
