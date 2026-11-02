import { handlers } from "~/server/auth";

// NextAuth's own handlers, as they come. The limit on sign-in attempts lives in
// authorize() (src/server/auth.ts), not here: a route that answered the sixth
// attempt itself, with a 429 in JSON, broke next-auth's client signIn(), which
// reads the `url` of every answer. The sign-in button stayed frozen and no
// message appeared (reported on 02/11/2026). Thrown from authorize(), the
// refusal comes back to the form as `code: "too_many_attempts"`.
export const { GET, POST } = handlers;
