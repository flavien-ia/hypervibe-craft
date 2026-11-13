import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { eq, and, isNull, gt } from "drizzle-orm";
import { randomBytes } from "crypto";
import {
  createTRPCRouter,
  protectedProcedure,
  rateLimitedProcedure,
} from "~/server/api/trpc";
import { db } from "~/server/db";
import { users, passwordResetTokens } from "~/server/db/schema";
import { hashPassword, verifyPassword } from "~/lib/password";
import { checkRateLimit } from "~/lib/rate-limit";
import { sendMail, escapeForBrevo } from "~/server/mail";

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1h

export const authRouter = createTRPCRouter({
  signup: rateLimitedProcedure
    .input(
      z.object({
        email: z.string().email(),
        password: z.string().min(8).max(200),
        name: z.string().min(1).max(100).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const existing = await db.query.users.findFirst({
        columns: { id: true },
        where: eq(users.email, input.email),
      });
      if (existing) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Impossible de créer ce compte.",
        });
      }
      const passwordHash = await hashPassword(input.password);
      const [user] = await db
        .insert(users)
        .values({
          email: input.email,
          name: input.name ?? null,
          passwordHash,
        })
        .returning({ id: users.id, email: users.email });
      return { id: user!.id, email: user!.email };
    }),

  /**
   * Delete the current user's account. Requires authentication AND the current password,
   * checked here: a session alone (an unlocked computer, a stolen cookie) must not be enough to
   * erase an account. Limited in attempts per account, as a password check is. An account without
   * a password (signed in through an outside provider only) is refused, with what to do.
   * Cascades to accounts/sessions via the FK on userId.
   */
  deleteAccount: protectedProcedure
    .input(z.object({ password: z.string().min(1).max(200) }))
    .mutation(async ({ ctx, input }) => {
      if (!checkRateLimit(`delete-account:${ctx.session.user.id}`).allowed) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: "Trop de tentatives. Réessaie dans quelques minutes.",
        });
      }
      const account = await db.query.users.findFirst({
        columns: { passwordHash: true },
        where: eq(users.id, ctx.session.user.id),
      });
      if (!account?.passwordHash) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Ce compte n’a pas de mot de passe : choisis-en un (« Mot de passe oublié ? »), puis supprime le compte.",
        });
      }
      if (!(await verifyPassword(input.password, account.passwordHash))) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Mot de passe incorrect." });
      }
      await db.delete(users).where(eq(users.id, ctx.session.user.id));
      return { success: true };
    }),

  requestPasswordReset: rateLimitedProcedure
    .input(z.object({ email: z.string().email() }))
    .mutation(async ({ input }) => {
      const user = await db.query.users.findFirst({
        columns: { id: true, email: true, name: true },
        where: eq(users.email, input.email),
      });

      if (user) {
        const rawToken = randomBytes(32).toString("base64url");
        const tokenHash = await hashPassword(rawToken);
        const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);

        await db.insert(passwordResetTokens).values({
          userId: user.id,
          tokenHash,
          expiresAt,
        });

        const resetUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"}/reset-password?token=${rawToken}`;
        const safeUrl = escapeForBrevo(resetUrl);

        try {
          await sendMail({
            to: [{ email: user.email, name: user.name ?? undefined }],
            subject: "Réinitialisation de ton mot de passe",
            htmlContent: `<p>Pour choisir un nouveau mot de passe, clique sur ce lien :</p><p><a href="${safeUrl}">${safeUrl}</a></p><p>Le lien expire dans 1 heure et ne peut être utilisé qu'une fois. Si tu n'as pas demandé cette réinitialisation, ignore cet email.</p>`,
            textContent: `Pour choisir un nouveau mot de passe, ouvre ce lien : ${resetUrl}\n\nLe lien expire dans 1 heure et ne peut être utilisé qu'une fois. Si tu n'as pas demandé cette réinitialisation, ignore cet email.`.replace(
              /\{\{/g,
              "{ {",
            ),
          });
        } catch (e) {
          // Never told to the caller: an error here would say the account exists.
          // Logged on the server, for whoever runs the project (Hypervibe 3.4.11).
          console.error("[auth] password reset email not sent:", e instanceof Error ? e.message : String(e));
        }
      } else {
        // No account for this email. Do equivalent CPU work (a throwaway hash),
        // then wait about as long as a send takes, so the response time does not
        // reveal whether the account exists.
        await hashPassword(randomBytes(32).toString("base64url"));
        await new Promise((resolve) => setTimeout(resolve, 250 + Math.floor(Math.random() * 400)));
      }

      return { success: true };
    }),

  resetPassword: rateLimitedProcedure
    .input(
      z.object({
        token: z.string().min(1).max(200),
        newPassword: z.string().min(8).max(200),
      }),
    )
    .mutation(async ({ input }) => {
      const candidates = await db.query.passwordResetTokens.findMany({
        columns: { id: true, userId: true, tokenHash: true },
        where: and(
          isNull(passwordResetTokens.consumedAt),
          gt(passwordResetTokens.expiresAt, new Date()),
        ),
      });

      let matched: (typeof candidates)[number] | null = null;
      for (const c of candidates) {
        if (await verifyPassword(input.token, c.tokenHash)) {
          matched = c;
          break;
        }
      }
      if (!matched) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Lien invalide ou expiré.",
        });
      }

      const newHash = await hashPassword(input.newPassword);
      await db
        .update(users)
        // The time of the change ends every session opened before it (src/server/auth.ts).
        .set({ passwordHash: newHash, passwordChangedAt: new Date() })
        .where(eq(users.id, matched.userId));
      await db
        .update(passwordResetTokens)
        .set({ consumedAt: new Date() })
        .where(eq(passwordResetTokens.id, matched.id));

      return { success: true };
    }),
});
