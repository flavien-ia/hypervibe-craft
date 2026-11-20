import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { eq, and, isNull, gt } from "drizzle-orm";
import { createHash, randomBytes } from "crypto";
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

/**
 * What the database keeps of a reset link: the SHA-256 of its token, never the token. A token is
 * 256 random bits: it needs no slow, salted hash (that is for passwords, which people choose), and
 * a plain one is what lets the database FIND a link by its index. Hashed like a password, every
 * reset had to try the link against every link alive, of every account, one slow hash each: a
 * few hundred requests made resetting a password impossible for everyone (review of 19/11/2026).
 */
const tokenHashOf = (token: string) => createHash("sha256").update(token).digest("hex");

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

      // A second count, by account, whatever address asks (five requests in 15 minutes): nobody
      // fills a person's mailbox by asking from many addresses. Never told to the caller: beyond
      // it the answer is the same, and nothing is sent.
      const mayAsk = user ? checkRateLimit(`reset:account:${user.id}`).allowed : false;

      if (user && mayAsk) {
        const rawToken = randomBytes(32).toString("base64url");
        const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);

        // One link at a time: asking again ends the links asked before.
        await db
          .update(passwordResetTokens)
          .set({ consumedAt: new Date() })
          .where(and(eq(passwordResetTokens.userId, user.id), isNull(passwordResetTokens.consumedAt)));
        await db.insert(passwordResetTokens).values({
          userId: user.id,
          tokenHash: tokenHashOf(rawToken),
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
        // No account for this email (or too many requests for it): wait about as long
        // as a send takes, so the response time does not reveal whether the account exists.
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
      // The link is found by its hash (an index), and consumed in the SAME statement that finds
      // it: one row at most, and two requests that carry the same link cannot both pass.
      const [used] = await db
        .update(passwordResetTokens)
        .set({ consumedAt: new Date() })
        .where(
          and(
            eq(passwordResetTokens.tokenHash, tokenHashOf(input.token)),
            isNull(passwordResetTokens.consumedAt),
            gt(passwordResetTokens.expiresAt, new Date()),
          ),
        )
        .returning({ userId: passwordResetTokens.userId });
      if (!used) {
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
        .where(eq(users.id, used.userId));
      // Every other link of the account ends with the change: none outlives the password it reset.
      await db
        .update(passwordResetTokens)
        .set({ consumedAt: new Date() })
        .where(and(eq(passwordResetTokens.userId, used.userId), isNull(passwordResetTokens.consumedAt)));

      return { success: true };
    }),
});
