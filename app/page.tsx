import { redirect } from "next/navigation";
import { auth, signIn } from "@/auth";

export default async function HomePage() {
  const session = await auth();
  if (session?.userId) redirect("/dashboard");

  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <div className="max-w-md w-full bg-white rounded-2xl shadow-sm border border-slate-200 p-8 text-center">
        <h1 className="text-2xl font-semibold text-slate-900">Transaction Tracker</h1>
        <p className="mt-2 text-sm text-slate-600">
          A private dashboard for your credit-card transactions.
          Reads bank alert emails from your Gmail, groups them by card,
          and stores nothing beyond what you can see here.
        </p>

        <form
          action={async () => {
            "use server";
            await signIn("google", { redirectTo: "/dashboard" });
          }}
          className="mt-6"
        >
          <button
            type="submit"
            className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-brand-600 hover:bg-brand-700 text-white font-medium px-4 py-3 transition"
          >
            Sign in with Google
          </button>
        </form>

        <p className="mt-5 text-xs text-slate-500">
          Grants read-only access to Gmail. No sending, no modifying.
          Revoke anytime at{" "}
          <a
            href="https://myaccount.google.com/permissions"
            target="_blank"
            rel="noreferrer"
            className="text-brand-600 underline"
          >
            myaccount.google.com/permissions
          </a>
          .
        </p>
      </div>
    </main>
  );
}
