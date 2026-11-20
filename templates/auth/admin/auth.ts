import NextAuth, { CredentialsSignin, type DefaultSession } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { verifyPassword, getAdminPasswordHash } from "~/lib/password";
import { checkRateLimit } from "~/lib/rate-limit";

// Module augmentation: NextAuth's default Session.User has `id?: string`. We
// know `id` is always set (we set it in the jwt → session callbacks below),
// so we narrow the type to make `session.user.id` non-nullable.
declare module "next-auth" {
  interface Session extends DefaultSession {
    user: {
      id: string;
    } & DefaultSession["user"];
  }
}

/**
 * Too many sign-in attempts: from one address (at most 5 in 15 minutes, ~/lib/rate-limit), or on
 * the account from every address together (at most 20 in 15 minutes: a second count, which does
 * not depend on the address). A request that carries no address is counted on the account only,
 * never in a count shared by everyone, which five attempts of anyone would close for all.
 * Thrown by authorize(): Auth.js answers the sign-in form as it answers a wrong
 * password, with `code: "too_many_attempts"`, and the form says so. The limit lives
 * here and not in the API route: a 429 sent by the route broke next-auth's client
 * signIn() and froze the form (reported on 02/11/2026).
 */
class TooManyAttempts extends CredentialsSignin {
  code = "too_many_attempts";
}

// hypervibe:auth-modes admin
export const { auth, handlers, signIn, signOut } = NextAuth({
  session: { strategy: "jwt" },
  providers: [
    Credentials({
      credentials: {
        username: { label: "Username", type: "text" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials, request) {
        const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
        const ip = forwarded === "" ? null : forwarded;
        if (ip && !checkRateLimit(`login:${ip}`).allowed) throw new TooManyAttempts();

        const username = credentials?.username as string | undefined;
        const password = credentials?.password as string | undefined;
        if (!username || !password) return null;

        // Always run the password verification (even on a username mismatch) so
        // the response time does not reveal whether the username was correct.
        const expectedUsername = process.env.ADMIN_USERNAME ?? "admin";
        // The account's own count, whatever address asks: what stops its password being guessed
        // from many addresses at once. Four counts of five, chosen by the address: twenty tries in
        // 15 minutes, and one address fills only its own quarter. Only the one name that can sign
        // in is counted.
        let slot = 0;
        for (const ch of ip ?? "") slot = (slot * 31 + ch.charCodeAt(0)) % 4;
        if (username === expectedUsername && !checkRateLimit(`login:account:admin:${slot}`).allowed) throw new TooManyAttempts();
        const hash = getAdminPasswordHash();
        const ok = await verifyPassword(password, hash);
        if (username !== expectedUsername || !ok) return null;

        return { id: "admin", name: "Admin" };
      },
    }),
  ],
  callbacks: {
    // Persist the user id in the JWT - required with the jwt session strategy
    // because NextAuth's default callbacks drop custom fields like `id`.
    // Without this, isAdmin() always returns false and gates redirect-loop the
    // user back to /admin/signin even after a successful login.
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
    signIn: "/admin/signin",
  },
});

/** True iff the current session is the hardcoded admin account. */
export async function isAdmin(): Promise<boolean> {
  const session = await auth();
  return session?.user?.id === "admin";
}
