// ─── NextAuth tables (appended by /add-auth users mode) ───────────────
//
// 4 standard tables compatible with @auth/drizzle-adapter:
//   - users:              account records (id, email, name, image, passwordHash, passwordChangedAt)
//   - accounts:           OAuth accounts (one row per provider per user)
//   - sessions:           DB sessions (unused in jwt strategy, kept for OAuth future)
//   - verificationTokens: email verification flow
//
// `createTable` is the pgTableCreator that T3 scaffolded at the top of this file -
// it prefixes every name with the project (e.g. `myapp_user`). Imports for
// `text`, `integer`, `primaryKey`, and `AdapterAccount` are added separately by
// the setup-auth-users.mjs script (which patches the imports surgically to
// avoid duplicates with what T3 already imports).

export const users = createTable("user", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name"),
  email: text("email").unique().notNull(),
  emailVerified: timestamp("email_verified", {
    mode: "date",
    withTimezone: true,
  }).default(sql`CURRENT_TIMESTAMP`),
  image: text("image"),
  // scrypt hash for credentials login (format: `salt:hash` hex:hex).
  // Null for OAuth-only accounts (no credentials).
  passwordHash: text("password_hash"),
  // When the password last changed (a reset): a session opened before it ends (src/server/auth.ts).
  passwordChangedAt: timestamp("password_changed_at", { mode: "date", withTimezone: true }),
});

export const accounts = createTable(
  "account",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").$type<AdapterAccount["type"]>().notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (account) => ({
    compoundKey: primaryKey({
      columns: [account.provider, account.providerAccountId],
    }),
    userIdIdx: index("account_user_id_idx").on(account.userId),
  }),
);

// `expires` columns on sessions/verificationTokens MUST match the @auth/drizzle-adapter
// expected shape exactly: `timestamp("expires", { mode: "date" }).notNull()`.
// Adding `withTimezone: true` makes the adapter reject the table at compile time
// (DefaultPostgresSessionsTable type mismatch). Keep tz-naive here; use timestamptz
// only on columns we own (emailVerified, password_reset_tokens.expiresAt).
export const sessions = createTable(
  "session",
  {
    sessionToken: text("session_token").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expires: timestamp("expires", { mode: "date" }).notNull(),
  },
  (session) => ({
    userIdIdx: index("session_user_id_idx").on(session.userId),
  }),
);

export const verificationTokens = createTable(
  "verification_token",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { mode: "date" }).notNull(),
  },
  (vt) => ({
    compoundKey: primaryKey({ columns: [vt.identifier, vt.token] }),
  }),
);
