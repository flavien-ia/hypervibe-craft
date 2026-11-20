import { Resend } from "resend";

/**
 * The client is built at the first send, not when this module loads: Resend's SDK refuses to be
 * built without a key, and every router that sends mail imports this module. Built at load, a
 * project whose key is not set yet (a collaborator's project before the administrator branches
 * the organisation's key) lost its whole API, every route and not only email (Hypervibe 3.4.11).
 */
let client: Resend | null = null;
function resend(): Resend {
  if (!process.env.RESEND_API_KEY) {
    throw new Error("sendMail: RESEND_API_KEY is not set, email is not configured for this project yet.");
  }
  client ??= new Resend(process.env.RESEND_API_KEY);
  return client;
}

/**
 * Escape HTML special characters to prevent injection in email templates.
 * MUST be applied to all user-provided data before inserting into HTML emails.
 */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

interface SendMailOptions {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  from?: string;
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
  if (options.allowLocalLinks !== true) refuseLocalLinks(options.subject, options.html, options.text);
  const { data, error } = await resend().emails.send({
    from: options.from ?? process.env.RESEND_FROM_EMAIL!,
    to: options.to,
    subject: options.subject,
    html: options.html,
    text: options.text,
  });

  if (error) {
    throw new Error(`Failed to send email: ${error.message}`);
  }

  return data;
}
