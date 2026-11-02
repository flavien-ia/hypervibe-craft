import NextAuth, { type DefaultSession } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { verifyLoginProof } from "~/lib/auth-2fa";

// Module augmentation: NextAuth's default Session.User has `id?: string`. We
// know `id` is always set (we set it in the jwt → session callbacks below).
declare module "next-auth" {
  interface Session extends DefaultSession {
    user: {
      id: string;
    } & DefaultSession["user"];
  }
}

// hypervibe:auth-modes admin
export const { auth, handlers, signIn, signOut } = NextAuth({
  // Session courte (filet de sécurité). La déconnexion après inactivité est
  // gérée côté client (composant IdleTimeout).
  session: { strategy: "jwt", maxAge: 60 * 60 * 8 },
  providers: [
    Credentials({
      credentials: {
        username: { label: "Username", type: "text" },
        // `proof` est une preuve signée par le serveur (HMAC AUTH_SECRET),
        // émise par loginAction APRÈS vérification du mot de passe + du 2FA.
        // NextAuth ne re-vérifie donc pas le mot de passe ici : c'est la
        // server action qui est l'unique porte d'entrée de la connexion.
        proof: { label: "Proof", type: "text" },
      },
      async authorize(credentials) {
        const username = credentials?.username as string | undefined;
        const proof = credentials?.proof as string | undefined;
        if (!username || !proof) return null;

        const expectedUsername = process.env.ADMIN_USERNAME ?? "admin";
        if (username !== expectedUsername) return null;

        if (!verifyLoginProof(username, proof)) return null;

        return { id: "admin", name: "Admin" };
      },
    }),
  ],
  callbacks: {
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
