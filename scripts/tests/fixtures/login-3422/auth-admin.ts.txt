import NextAuth, { type DefaultSession } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { verifyPassword, getAdminPasswordHash } from "~/lib/password";

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

// hypervibe:auth-modes admin
export const { auth, handlers, signIn, signOut } = NextAuth({
  session: { strategy: "jwt" },
  providers: [
    Credentials({
      credentials: {
        username: { label: "Username", type: "text" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const username = credentials?.username as string | undefined;
        const password = credentials?.password as string | undefined;
        if (!username || !password) return null;

        // Always run the password verification (even on a username mismatch) so
        // the response time does not reveal whether the username was correct.
        const expectedUsername = process.env.ADMIN_USERNAME ?? "admin";
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
