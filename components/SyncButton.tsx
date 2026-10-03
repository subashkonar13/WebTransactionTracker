"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type Status =
  | { kind: "idle" }
  | { kind: "syncing"; round: number }
  | { kind: "ok"; summary: string }
  | { kind: "err"; message: string };

/**
 * A full-year backfill can take several "pages" of Gmail results, each
 * capped by Vercel's 60s function timeout. Rather than making the user
 * click Sync repeatedly, we auto-chain calls to /api/sync as long as the
 * server reports `done: false`, showing a running total as we go.
 */
export default function SyncButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  async function run() {
    let round = 1;
    let totalScanned = 0;
    let totalInserted = 0;
    setStatus({ kind: "syncing", round });

    try {
      while (true) {
        const res = await fetch("/api/sync", { method: "POST" });
        const data = await res.json();

        if (!res.ok) {
          setStatus({ kind: "err", message: data.error ?? "sync failed" });
          return;
        }

        totalScanned += data.scanned ?? 0;
        totalInserted += data.inserted ?? 0;

        if (data.done) {
          const summary =
            totalScanned === 0
              ? "No new transactions"
              : `Scanned ${totalScanned}, added ${totalInserted}`;
          setStatus({ kind: "ok", summary });
          startTransition(() => router.refresh());
          setTimeout(() => setStatus({ kind: "idle" }), 5000);
          return;
        }

        // More pages remain — continue automatically.
        round++;
        setStatus({ kind: "syncing", round });
        // Refresh the dashboard between rounds so long backfills feel alive.
        startTransition(() => router.refresh());
      }
    } catch (e) {
      setStatus({ kind: "err", message: (e as Error).message });
    }
  }

  const busy = status.kind === "syncing" || pending;

  return (
    <div className="flex items-center gap-2">
      {status.kind === "ok" && (
        <span className="text-xs text-emerald-700 bg-emerald-50 px-2 py-1 rounded">
          {status.summary}
        </span>
      )}
      {status.kind === "err" && (
        <span className="text-xs text-rose-700 bg-rose-50 px-2 py-1 rounded">
          {status.message}
        </span>
      )}
      {status.kind === "syncing" && status.round > 1 && (
        <span className="text-xs text-slate-500">
          Fetching more ({status.round})…
        </span>
      )}
      <button
        onClick={run}
        disabled={busy}
        className="text-sm font-medium px-3 py-1.5 rounded-md bg-brand-600 hover:bg-brand-700 disabled:bg-slate-300 text-white transition"
      >
        {busy ? "Syncing…" : "Sync"}
      </button>
    </div>
  );
}
