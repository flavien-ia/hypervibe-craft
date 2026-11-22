/**
 * Sending through Brevo with the project's own sending application (Hypervibe 3.4.34): a client id
 * and a secret that can only send mail (`transactional.email:write`), never a key that opens the
 * whole Brevo account. A token is asked for when the first mail leaves, kept in memory until a
 * minute before it expires, and asked for again then, or once when Brevo answers 401. The token
 * and the secret are never written to a log nor put into an error.
 *
 * Nothing is read when this module loads: every router that sends mail imports it, and a project
 * whose credentials are not set yet must keep the rest of its API. What is missing is said by the
 * send itself (the same rule as Resend's, Hypervibe 3.4.11).
 *
 * A project whose sending application could not be made (Brevo's route refused) holds instead a key
 * a person made in Brevo's dashboard, BREVO_API_KEY: it is used only when the application's two
 * credentials are not both there.
 */
const BREVO = "https://api.brevo.com";
const SCOPE = "transactional.email:write";

type Credentials = { clientId: string; clientSecret: string } | { apiKey: string };

function credentials(): Credentials {
  const clientId = process.env.BREVO_CLIENT_ID?.trim();
  const clientSecret = process.env.BREVO_CLIENT_SECRET?.trim();
  if (clientId && clientSecret) return { clientId, clientSecret };
  const apiKey = process.env.BREVO_API_KEY?.trim();
  if (apiKey) return { apiKey };
  throw new Error("sendMail: BREVO_CLIENT_ID and BREVO_CLIENT_SECRET are not both set, email is not configured for this project yet.");
}

let token: { value: string; expiresAt: number } | null = null;
let asking: Promise<string> | null = null;

/** A token for the project's application, asked once at a time, its scope always named. */
async function accessToken(clientId: string, clientSecret: string): Promise<string> {
  if (token && Date.now() < token.expiresAt - 60_000) return token.value;
  asking ??= (async () => {
    try {
      const res = await fetch(`${BREVO}/realms/partner/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret, scope: SCOPE }).toString(),
      });
      const body = (await res.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown; error?: unknown; error_description?: unknown } | null;
      if (!res.ok || typeof body?.access_token !== "string" || !body.access_token) {
        const said = typeof body?.error_description === "string" ? body.error_description : typeof body?.error === "string" ? body.error : `HTTP ${res.status}`;
        throw new Error(`sendMail: Brevo refused the project's sending application a token (${res.status}: ${said}). Check BREVO_CLIENT_ID and BREVO_CLIENT_SECRET.`);
      }
      const seconds = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 3600;
      token = { value: body.access_token, expiresAt: Date.now() + seconds * 1000 };
      return token.value;
    } finally {
      asking = null;
    }
  })();
  return asking;
}

/** One call to Brevo's transactional API, with the application's token (asked again once on a 401)
 *  or, failing the application, the key a person made. */
async function send(payload: unknown): Promise<{ messageId?: string }> {
  const how = credentials();
  const post = (auth: Record<string, string>) =>
    fetch(`${BREVO}/v3/smtp/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", ...auth },
      body: JSON.stringify(payload),
    });
  let res: Response;
  if ("apiKey" in how) {
    res = await post({ "api-key": how.apiKey });
  } else {
    res = await post({ Authorization: `Bearer ${await accessToken(how.clientId, how.clientSecret)}` });
    if (res.status === 401) {
      token = null;
      res = await post({ Authorization: `Bearer ${await accessToken(how.clientId, how.clientSecret)}` });
    }
  }
  const body = (await res.json().catch(() => null)) as { messageId?: string; code?: unknown; message?: unknown } | null;
  if (!res.ok) {
    const said = typeof body?.message === "string" ? body.message : `HTTP ${res.status}`;
    throw new Error(`sendMail: Brevo refused the message (${res.status}${typeof body?.code === "string" ? ` ${body.code}` : ""}: ${said}).`);
  }
  return body ?? {};
}

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
 * `htmlContent`. For `textContent`, at minimum split every pair of braces
 * (`.replace(/\{(?=\{)/g, "{ ")`: `{{{` gives `{ { {`, where `.replace(/\{\{/g, "{ {")` left `{ {{`).
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
  return send({
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
