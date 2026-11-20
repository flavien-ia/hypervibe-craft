// ─── Password reset tokens (appended by /add-auth when email is configured) ──
//
// Stores hashed reset tokens, never the raw ones: the SHA-256 of a token of 256 random bits (no
// slow, salted hash: that is for passwords, and it would keep the index below from finding a
// link). Tokens expire 1h after creation. One use only: `consumedAt` is set by the statement
// that finds the link, and on every other link of the account when its password changes or when
// a new link is asked.

export const passwordResetTokens = createTable(
  "password_reset_token",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
    consumedAt: timestamp("consumed_at", {
      mode: "date",
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", {
      mode: "date",
      withTimezone: true,
    })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => ({
    userIdIdx: index("password_reset_user_id_idx").on(t.userId),
    tokenHashIdx: index("password_reset_token_hash_idx").on(t.tokenHash),
  }),
);
