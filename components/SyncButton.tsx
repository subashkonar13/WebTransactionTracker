"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type Status =
  | { kind: "idle" }
  | { kind: "syncing" }
  | { kind: "ok"; summary: string }
  | { kind: "err"; message: string };

export default function SyncButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  async function run() {
    setStatus({ kind: "syncing" });
    try {
      const res = await fetch("/api/sync", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setStatus({ kind: "err", message: data.error ?? "sync failed" });
        return;
      }
      const summary = `Scanned ${data.scanned}, added ${data.inserted}`;
      setStatus({ kind: "ok", summary });
      // Refresh the server component tree to pick up new rows.
      startTransition(() => router.refresh());
      // Auto-dismiss toast after 4s.
      setTimeout(() => setStatus({ kind: "idle" }), 4000);
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
