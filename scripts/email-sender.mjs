// email-sender.mjs - Which sender variables /add-email pushes for a project (3.4.11): only those
// the project lacks. A sender already set (verified by the person, written by the domain's own
// sub-skill, or set by the organisation's administrator) is kept. Until 3.4.11 it was replaced by
// Resend's test address, which only delivers to the account's owner, or by the Brevo sender typed
// during /add-email (review of the lot 8). Read by setup-email.mjs; nothing here reads a file.

/** The sender a provider needs, with the value /add-email would give it: Resend's official test
 *  sender (it works at once, but only towards the account's owner), or the Brevo sender typed. */
function wanted({ provider, brevoSender, brevoSenderName }) {
  return provider === "resend"
    ? [["RESEND_FROM_EMAIL", "onboarding@resend.dev"]]
    : [
        ["BREVO_SENDER_EMAIL", brevoSender],
        ["BREVO_SENDER_NAME", brevoSenderName],
      ];
}

/** Whether setup-email.mjs writes the contact router (3.4.13): {write, reason}. Not when the need is
 *  not a contact form (`skip`, from --no-contact-router), and not when the project's tRPC has no
 *  `rateLimitedProcedure`: the router uses it, and until 3.4.13 it was written anyway, with a
 *  warning, then broke the build. `only` (--contact-router-only, the contact page asking for it
 *  later) has nothing else to do: there, a missing rateLimitedProcedure is a refusal, said by the
 *  script. `trpc`: the text of src/server/api/trpc.ts, or null when the file is not there. */
export function contactRouterPlan({ skip = false, only = false, trpc = null }) {
  if (skip && !only) return { write: false, reason: "asked" };
  if (trpc === null) return { write: false, reason: "no-trpc" };
  if (!trpc.includes("rateLimitedProcedure")) return { write: false, reason: "no-rate-limit" };
  return { write: true, reason: null };
}

/** {kept, pushed}: the variables already set (kept as they are), and the KEY=value lines to push.
 *  `inPlace` maps a variable to the value the project has now (null or absent: none). */
export function senderPlan({ provider, inPlace = {}, brevoSender = null, brevoSenderName = null }) {
  const list = wanted({ provider, brevoSender, brevoSenderName });
  return {
    kept: list.filter(([key]) => inPlace[key]).map(([key]) => key),
    pushed: list.filter(([key]) => !inPlace[key]).map(([key, value]) => `${key}=${value}`),
  };
}
