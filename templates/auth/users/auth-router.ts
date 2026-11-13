import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import {
  createTRPCRouter,
  protectedProcedure,
  rateLimitedProcedure,
} from "~/server/api/trpc";
import { db } from "~/server/db";
import { users } from "~/server/db/schema";
import { hashPassword, verifyPassword } from "~/lib/password";
import { checkRateLimit } from "~/lib/rate-limit";

export const authRouter = createTRPCRouter({
  /**
   * Create a new user account. Public - anyone can signup.
   * Rate-limited per IP to mitigate enumeration attacks.
   */
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
        // Don't disclose whether the email is taken (anti-enumeration).
        // Generic error matches the message we'd return for any 4xx.
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
          message: "Ce compte n’a pas de mot de passe : demande au site de le supprimer pour toi.",
        });
      }
      if (!(await verifyPassword(input.password, account.passwordHash))) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Mot de passe incorrect." });
      }
      await db.delete(users).where(eq(users.id, ctx.session.user.id));
      return { success: true };
    }),
});
