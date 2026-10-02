# Transaction Tracker — Web (Vercel)

A private dashboard that reads credit-card alert emails from your Gmail and
groups transactions by card. Deploys free to Vercel. No local toolchain needed.

```
Gmail inbox ──(OAuth)──▶ Vercel (Next.js) ──▶ Turso (SQLite)
                                      │
                                      ▼
                                 Your browser
```

- **Zero cost** on Vercel Hobby + Turso Starter + Google Cloud free tier.
- **Privacy-first:** read-only Gmail scope, no data leaves your Vercel + Turso.
- **Dedupe built-in:** re-syncing the same inbox is idempotent (unique index on `(userId, sourceHash)`).

---

## Deploy — 30 min, all in the browser

### Step 1 — Push code to GitHub (5 min)

1. Create a new **private** GitHub repo (e.g. `txn-tracker-web`).
2. Upload every file from this project (including hidden `.github` if any).
3. Commit.

### Step 2 — Create a Turso database (5 min)

1. Go to [turso.tech](https://turso.tech) → sign up with GitHub.
2. **Create database** → name it `txn-tracker` → pick the region closest to your Vercel region (default `iad` for Vercel US).
3. Open the database → **Generate database token** → copy it (you'll paste it into Vercel).
4. From the database overview page, copy the **Database URL** (looks like `libsql://txn-tracker-you.turso.io`).

### Step 3 — Create Google OAuth credentials (10 min)

1. Go to [console.cloud.google.com](https://console.cloud.google.com).
2. Create a new project called `txn-tracker` (top-left project dropdown → New Project).
3. In the search bar, type **"Gmail API"** → open it → click **Enable**.
4. Left sidebar → **APIs & Services → OAuth consent screen**:
   - **User Type:** External → Create
   - **App name:** Transaction Tracker (your name) · **User support email:** your Gmail · **Developer email:** your Gmail
   - **Scopes:** click **Add or Remove Scopes** → paste `https://www.googleapis.com/auth/gmail.readonly` → tick → Update → Save & Continue
   - **Test users:** add your own Gmail address → Save & Continue
   - (Leave in **Testing** mode. "Publishing" needs Google review which is a 2-week process; for personal use, Testing is fine. The only cost: refresh tokens expire every 7 days so you re-login weekly.)
5. Left sidebar → **APIs & Services → Credentials**:
   - **Create Credentials → OAuth client ID**
   - Application type: **Web application**
   - Name: `txn-tracker-web`
   - **Authorized JavaScript origins:** add `https://<your-vercel-url>.vercel.app` (you'll know this after Step 4) AND `http://localhost:3000`
   - **Authorized redirect URIs:** add `https://<your-vercel-url>.vercel.app/api/auth/callback/google` AND `http://localhost:3000/api/auth/callback/google`
   - Create → copy the **Client ID** and **Client Secret**

> You can create the OAuth client first with just `localhost` URIs, deploy to Vercel to find out your URL, then come back to add the Vercel URIs. The redirect must match exactly.

### Step 4 — Deploy to Vercel (10 min)

1. Go to [vercel.com](https://vercel.com) → **Sign up with GitHub**.
2. **Add New Project** → import your `txn-tracker-web` repo.
3. Framework preset: **Next.js** (auto-detected). Leave build settings default.
4. **Environment Variables** — add all of these before clicking Deploy:

   | Name | Value |
   |---|---|
   | `NEXTAUTH_SECRET` | Any random 32-char string. Generate at [generate-secret.vercel.app/32](https://generate-secret.vercel.app/32). |
   | `GOOGLE_CLIENT_ID` | From Step 3 |
   | `GOOGLE_CLIENT_SECRET` | From Step 3 |
   | `TURSO_DATABASE_URL` | From Step 2 |
   | `TURSO_AUTH_TOKEN` | From Step 2 |
   | `AUTH_TRUST_HOST` | `true` *(required on Vercel for Auth.js v5)* |

5. Click **Deploy**. First build takes ~3 min.
6. Your app is live at `https://<project-name>.vercel.app`.
7. Go back to Google Cloud Console (Step 3) and add this URL to both the Authorized origins and the Authorized redirect URI if you didn't already.

### Step 5 — Initialize the database schema (2 min, one-time)

Vercel doesn't run migrations automatically. Easiest: use Turso's web shell.

1. [turso.tech](https://turso.tech) → your database → **SQL Shell** tab.
2. Paste this and press Run:

```sql
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_sync_at INTEGER
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_hash TEXT NOT NULL,
  gmail_message_id TEXT NOT NULL,
  bank_name TEXT,
  card_last4 TEXT NOT NULL,
  amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'INR',
  merchant TEXT,
  txn_type TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  email_subject TEXT,
  raw_snippet TEXT,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_user_source ON transactions(user_id, source_hash);
CREATE INDEX IF NOT EXISTS by_user_card ON transactions(user_id, card_last4);
CREATE INDEX IF NOT EXISTS by_user_time ON transactions(user_id, timestamp);
```

Done. Open your Vercel URL, sign in, click Sync.

---

## Using it

1. **Sign in** with the same Google account you added as a test user.
2. Click **Sync** (top right) — pulls last 30 days of bank alert emails. First sync may take ~30s.
3. Cards appear grouped by last-4. Tap one for the full transaction list.
4. Click Sync again anytime — only new emails are fetched (we track `lastSyncAt`).

---

## How it works

- **OAuth scope:** `gmail.readonly` only. Can list and read emails, cannot send, modify, or delete. Revoke at [myaccount.google.com/permissions](https://myaccount.google.com/permissions).
- **Email search query:** `from:(<known-bank-domains>) subject:(spent OR debited OR charged OR …) after:<lastSync>`. Narrow by design so we fetch ~100 messages, not 10k.
- **Parser:** TypeScript port of the Android app's regex engine. Same test corpus (`lib/parser.ts`). Validated against HDFC/ICICI/SBI/Axis/Kotak formats.
- **Dedupe:** `sourceHash = SHA-256(userId || gmailMessageId)`, UNIQUE index. Re-syncing is idempotent.
- **Session:** JWT in a httpOnly cookie, encrypted with `NEXTAUTH_SECRET`. Access token is refreshed server-side using the refresh token when it expires.

---

## Extending

**Add a bank:** edit `lib/gmail.ts` (`buildSearchQuery`) to add the sender address, and `lib/parser.ts` (`BANK_SIGNATURES`) to detect its name in the body.

**Longer history:** change `newer_than:30d` in `buildSearchQuery` to `newer_than:365d` for first sync. Note the 60-sec Vercel function timeout — split into pages (iterate `nextPageToken` from `listMessages`).

**Nightly auto-sync:** add a cron in `vercel.json`:
```json
{
  "crons": [{ "path": "/api/sync", "schedule": "0 3 * * *" }]
}
```
Vercel Hobby allows 2 cron jobs. The sync endpoint currently requires a user session, so you'd need a cron-specific token header to work.

**PDF statements:** add a `pdf-parse` dependency; detect messages with PDF attachments; download, unlock with user-provided password, extract transactions. Separate feature, keep in a `/api/sync-statements` route.

**Export CSV:** add `/api/export?format=csv` returning all rows for the signed-in user.

---

## Known limitations

1. **Testing-mode OAuth:** refresh tokens expire every 7 days. You re-login weekly. Verify the app with Google (free, requires privacy policy and ~2-week review) to lift this.
2. **Email format drift:** banks occasionally change their email templates. The parser is deterministic, so when it misses, it misses silently. Spot-check for a few weeks after deployment.
3. **No historical statements:** this reads *alert emails*, not monthly statements. For statement parsing, add the PDF path above.
4. **UPI not covered:** PhonePe/GPay emails have different formats and typically debit bank account, not credit card. Out of scope for v1.
5. **Single-region Turso:** fine for personal use; for teams add Turso embedded replicas or move to Vercel Postgres.

---

## Local development (optional)

Only needed if you want to tweak the UI. Vercel builds from GitHub directly, so you don't *have* to run locally.

```bash
npm install
cp .env.example .env.local   # fill in all values
npm run dev
# open http://localhost:3000
```

Note: Google OAuth redirect URIs must include `http://localhost:3000/api/auth/callback/google` for local dev to work.
