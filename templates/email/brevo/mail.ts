import { BrevoClient } from "@getbrevo/brevo";

const client = new BrevoClient({ apiKey: process.env.BREVO_API_KEY! });

/**
 * Escape user-provided data before inserting it into an email body.
 *
 * Handles two concerns at once:
 *   1. Standard HTML injection (`<`, `>`, `&`, `"`, `'`)
 *   2. Brevo implicit templating: Brevo runs a Mustache-style templating pass
 *      on htmlContent AND textContent at send time. Any `{{` in the body
 *      (e.g. a stack trace, malformed-JSON error, or user-supplied text)
 *      raises an async parse failure - the SDK call has already returned 201
 *      by then, so the try/catch sees nothing and the email is silently dropped.
 *      Escape `{` and `}` to defuse this.
 *
 * MUST be applied to every user-provided or error-derived field inserted into
 * `htmlContent`. For `textContent`, at minimum split `{{` (e.g. `.replace(/\{\{/g, "{ {")`).
 */
export function escapeForBrevo(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/\{/g, "&#123;")
    .replace(/\}/g, "&#125;");
}

interface SendMailOptions {
  to: { email: string; name?: string }[];
  subject: string;
  htmlContent: string;
  textContent?: string;
  sender?: { email: string; name: string };
  /**
   * This mail carries what a VISITOR wrote, and no link of the site's own (the contact form): the
   * refusal of links to the development machine does not read it. A visitor who quotes such an
   * address ("your link points to http://localhost:3000") must reach the site's owner, where the
   * refusal turned their message into an error and lost it.
   */
  allowLocalLinks?: boolean;
}

/**
 * A link to the development machine has no place in an email: nobody can open
 * it. It happens when a script that sends mail runs on a workstation with a
 * `.env` whose public URL is `http://localhost:3000`, and it reached real
 * recipients once (Hypervibe 3.1.5 announcement, 2026-09-13). The send is
 * refused with an error that names the cause. `MAIL_ALLOW_LOCAL_LINKS=1`, set
 * by a person in the environment, lifts the refusal for a test bench. It reads the
 * site's own mails only: one that carries a visitor's words says so (allowLocalLinks).
 */
const LOCAL_LINK = /https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?/i;

function refuseLocalLinks(subject: string, ...bodies: (string | undefined)[]): void {
  if (process.env.MAIL_ALLOW_LOCAL_LINKS === "1") return;
  if (bodies.some((body) => body !== undefined && LOCAL_LINK.test(body))) {
    throw new Error(
      `sendMail refused: "${subject}" contains a link to localhost. Send from production, or set MAIL_ALLOW_LOCAL_LINKS=1 for a test bench.`,
    );
  }
}

export async function sendMail(options: SendMailOptions) {
  if (options.allowLocalLinks !== true) refuseLocalLinks(options.subject, options.htmlContent, options.textContent);
  return client.transactionalEmails.sendTransacEmail({
    to: options.to,
    subject: options.subject,
    htmlContent: options.htmlContent,
    textContent: options.textContent,
    sender: options.sender ?? {
      email: process.env.BREVO_SENDER_EMAIL!,
      name: process.env.BREVO_SENDER_NAME ?? "App",
    },
  });
}
