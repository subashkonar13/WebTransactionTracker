import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { db, schema } from "@/lib/db";
import { eq } from "drizzle-orm";

/**
 * Auth.js v5 config.
 *
 * We request the Gmail READONLY scope. Nothing more. That means we can list
 * and read emails, but cannot send, modify, delete, or alter labels. Users
 * can revoke access any time at myaccount.google.com/permissions.
 *
 * Access tokens are stored in the JWT session (encrypted by NEXTAUTH_SECRET).
 * We also persist a refresh token in the JWT so we can get a fresh access
 * token after the 1-hour expiry without re-prompting the user.
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      authorization: {
        params: {
          scope: [
            "openid",
            "email",
            "profile",
            "https://www.googleapis.com/auth/gmail.readonly",
          ].join(" "),
          access_type: "offline",   // required to get refresh_token
          prompt: "consent",        // force refresh_token on every re-login
        },
      },
    }),
  ],
  session: { strategy: "jwt" },
  callbacks: {
    async jwt({ token, account, profile }) {
      // On first sign-in, persist the Google tokens on the JWT.
      if (account && profile) {
        token.accessToken = account.access_token;
        token.refreshToken = account.refresh_token;
        token.accessTokenExpires = (account.expires_at ?? 0) * 1000;
        token.sub = (profile as { sub?: string }).sub ?? token.sub;

        // Upsert the user row so transactions can FK to it.
        if (token.sub && profile.email) {
          await db
            .insert(schema.users)
            .values({ id: token.sub, email: profile.email })
            .onConflictDoNothing();
        }
        return token;
      }

      // Still valid? reuse it.
      if (token.accessTokenExpires && Date.now() < (token.accessTokenExpires as number) - 60_000) {
        return token;
      }

      // Expired — try to refresh.
      return refreshAccessToken(token);
    },
    async session({ session, token }) {
      session.userId = token.sub as string;
      session.accessToken = token.accessToken as string | undefined;
      session.error = token.error as string | undefined;
      return session;
    },
  },
  pages: { signIn: "/" },
});

async function refreshAccessToken(token: Record<string, unknown>) {
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID!,
        client_secret: process.env.GOOGLE_CLIENT_SECRET!,
        grant_type: "refresh_token",
        refresh_token: token.refreshToken as string,
      }),
    });
    const refreshed = await res.json();
    if (!res.ok) throw refreshed;
    return {
      ...token,
      accessToken: refreshed.access_token,
      accessTokenExpires: Date.now() + refreshed.expires_in * 1000,
      refreshToken: refreshed.refresh_token ?? token.refreshToken,
    };
  } catch (err) {
    console.error("Failed to refresh access token", err);
    return { ...token, error: "RefreshAccessTokenError" };
  }
}

// Augment the NextAuth session type.
declare module "next-auth" {
  interface Session {
    userId?: string;
    accessToken?: string;
    error?: string;
  }
}
