import NextAuth, { CredentialsSignin, type DefaultSession } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { verifyLoginProof } from "~/lib/auth-2fa";
import { checkRateLimit } from "~/lib/rate-limit";

// Module augmentation: NextAuth's default Session.User has `id?: string`. We
// know `id` is always set (we set it in the jwt → session callbacks below).
declare module "next-auth" {
  interface Session extends DefaultSession {
    user: {
      id: string;
    } & DefaultSession["user"];
  }
}

/**
 * Trop de tentatives de connexion depuis une même adresse (5 au plus en 15 minutes,
 * ~/lib/rate-limit). Levée par authorize() quand une requête arrive sans preuve
 * valide : Auth.js répond alors `code: "too_many_attempts"`. La limite vit ici et
 * dans loginAction, plus dans la route d'API : un 429 renvoyé par la route cassait
 * le signIn() client de next-auth (signalé le 02/11/2026).
 */
class TooManyAttempts extends CredentialsSignin {
  code = "too_many_attempts";
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
      async authorize(credentials, request) {
        const username = credentials?.username as string | undefined;
        const proof = credentials?.proof as string | undefined;
        const expectedUsername = process.env.ADMIN_USERNAME ?? "admin";
        if (username && proof && username === expectedUsername && verifyLoginProof(username, proof)) {
          return { id: "admin", name: "Admin" };
        }

        // Pas de preuve valide : ce n'est pas loginAction (qui a déjà compté cette
        // tentative, clé `login:<ip>`), mais une requête envoyée droit à la route
        // d'API. Elle compte sur la même clé : une fausse preuve n'achète aucune
        // tentative de plus, et une vraie n'est jamais comptée deux fois.
        const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
        if (!checkRateLimit(`login:${ip}`).allowed) throw new TooManyAttempts();
        return null;
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
