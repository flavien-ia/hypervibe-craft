import NextAuth, { CredentialsSignin, type DefaultSession } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { eq } from "drizzle-orm";
import { db } from "~/server/db";
import { users, accounts, sessions, verificationTokens } from "~/server/db/schema";
import { verifyPassword } from "~/lib/password";
import { checkRateLimit } from "~/lib/rate-limit";

// Module augmentation: NextAuth's default Session.User has `id?: string`. We
// know `id` is always set (we set it in the jwt → session callbacks below),
// so we narrow the type to make `session.user.id` non-nullable in `protectedProcedure`.
declare module "next-auth" {
  interface Session extends DefaultSession {
    user: {
      id: string;
    } & DefaultSession["user"];
  }
}

/**
 * Too many sign-in attempts from one address (at most 5 in 15 minutes, ~/lib/rate-limit).
 * Thrown by authorize(): Auth.js answers the sign-in form as it answers a wrong
 * password, with `code: "too_many_attempts"`, and the form says so. The limit lives
 * here and not in the API route: a 429 sent by the route broke next-auth's client
 * signIn() and froze the form (reported on 02/11/2026).
 */
class TooManyAttempts extends CredentialsSignin {
  code = "too_many_attempts";
}

// hypervibe:auth-modes users
//
// Drizzle adapter is wired even though session strategy is "jwt" (NextAuth doesn't
// write to the sessions table in JWT mode). Reason: it lets /add-google-auth or
// /add-github-auth plug an OAuth provider in later without schema migration -
// OAuth needs the accounts/sessions tables.
export const { auth, handlers, signIn, signOut } = NextAuth({
  adapter: DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  }),
  session: { strategy: "jwt" },
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials, request) {
        const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
        if (!checkRateLimit(`login:${ip}`).allowed) throw new TooManyAttempts();

        const email = credentials?.email as string | undefined;
        const password = credentials?.password as string | undefined;
        if (!email || !password) return null;

        const user = await db.query.users.findFirst({ where: eq(users.email, email) });
        if (!user || !user.passwordHash) return null;

        const ok = await verifyPassword(password, user.passwordHash);
        if (!ok) return null;

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          image: user.image,
        };
      },
    }),
  ],
  callbacks: {
    // Persist the user id in the JWT - needed because we use jwt strategy without
    // the sessions table; the default callback drops `id` otherwise.
    jwt({ token, user }) {
      if (user) token.id = user.id;
      return token;
    },
    session({ session, token }) {
      if (token.id && session.user) session.user.id = token.id as string;
      return session;
    },
  },
  pages: {
    signIn: "/signin",
  },
});
