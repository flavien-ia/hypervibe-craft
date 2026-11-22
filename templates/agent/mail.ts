// agent/mail.ts - Minimal email helper for the agent worker.
//
// The agent runs in a separate Render Background Worker process (apps/agent/),
// SO it can't directly import the main app's mail wrapper. We re-implement a
// thin wrapper here using the same provider configured in the main app
// (Brevo or Resend). Env vars are passed at deploy time.
//
// Auto-detects which provider based on which env vars are present:
//   - If BREVO_CLIENT_ID and BREVO_CLIENT_SECRET are set → Brevo, through the project's sending
//     application (Hypervibe 3.4.34): a token of an hour asked with the sending scope, kept until a
//     minute before it expires, asked again once on a 401, never logged
//   - Else if BREVO_API_KEY is set → Brevo, with the key a person made (a project of before, or
//     whose application Brevo did not make)
//   - Else if RESEND_API_KEY       → uses Resend
//   - Else                          → throws (no email provider configured)

import type { ToolName } from "./tools/index.js";

// ─── Types ────────────────────────────────────────────────────────────
export interface SendMailOptions {
  to: { email: string; name?: string }[];
  subject: string;
  htmlContent: string;
  textContent?: string;
  replyTo?: { email: string; name?: string };
}

// ─── Provider detection + send ────────────────────────────────────────
/**
 * A link to the development machine has no place in an email: nobody can open
 * it. It happens when a script that sends mail runs on a workstation with a
 * `.env` whose public URL is `http://localhost:3000`, and it reached real
 * recipients once (Hypervibe 3.1.5 announcement, 2026-09-13). The send is
 * refused with an error that names the cause. `MAIL_ALLOW_LOCAL_LINKS=1`, set
 * by a person in the environment, lifts the refusal for a test bench.
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

export async function sendMail(opts: SendMailOptions): Promise<void> {
  refuseLocalLinks(opts.subject, opts.htmlContent, opts.textContent);
  // Strip empty names (Brevo rejects name: "" with HTTP 400 - known footgun).
  const cleanTo = opts.to.map((r) => (r.name?.trim() ? r : { email: r.email }));
  const cleanReplyTo = opts.replyTo?.name?.trim() ? opts.replyTo : opts.replyTo ? { email: opts.replyTo.email } : undefined;

  if ((process.env.BREVO_CLIENT_ID && process.env.BREVO_CLIENT_SECRET) || process.env.BREVO_API_KEY) {
    return sendViaBrevo({ ...opts, to: cleanTo, replyTo: cleanReplyTo });
  }
  if (process.env.RESEND_API_KEY) {
    return sendViaResend({ ...opts, to: cleanTo, replyTo: cleanReplyTo });
  }
  throw new Error("No email provider configured (BREVO_CLIENT_ID and BREVO_CLIENT_SECRET, BREVO_API_KEY or RESEND_API_KEY missing)");
}

let brevoToken: { value: string; expiresAt: number } | null = null;

/** A token for the project's sending application, its scope always named. */
async function brevoAccessToken(): Promise<string> {
  if (brevoToken && Date.now() < brevoToken.expiresAt - 60_000) return brevoToken.value;
  const res = await fetch("https://api.brevo.com/realms/partner/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.BREVO_CLIENT_ID!,
      client_secret: process.env.BREVO_CLIENT_SECRET!,
      scope: "transactional.email:write",
    }).toString(),
  });
  const body = (await res.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown } | null;
  if (!res.ok || typeof body?.access_token !== "string") {
    throw new Error(`Brevo refused the project's sending application a token (HTTP ${res.status})`);
  }
  const seconds = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 3600;
  brevoToken = { value: body.access_token, expiresAt: Date.now() + seconds * 1000 };
  return brevoToken.value;
}

async function sendViaBrevo(opts: SendMailOptions): Promise<void> {
  const app = Boolean(process.env.BREVO_CLIENT_ID && process.env.BREVO_CLIENT_SECRET);
  const auth = async (): Promise<Record<string, string>> =>
    app ? { Authorization: `Bearer ${await brevoAccessToken()}` } : { "api-key": process.env.BREVO_API_KEY! };
  let res = await postToBrevo(opts, await auth());
  if (app && res.status === 401) {
    brevoToken = null;
    res = await postToBrevo(opts, await auth());
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Brevo API error (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
}

function postToBrevo(opts: SendMailOptions, auth: Record<string, string>): Promise<Response> {
  return fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      ...auth,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      sender: {
        email: process.env.BREVO_SENDER_EMAIL!,
        ...(process.env.BREVO_SENDER_NAME ? { name: process.env.BREVO_SENDER_NAME } : {}),
      },
      to: opts.to,
      subject: opts.subject,
      htmlContent: opts.htmlContent,
      ...(opts.textContent ? { textContent: opts.textContent } : {}),
      ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
    }),
  });
}

async function sendViaResend(opts: SendMailOptions): Promise<void> {
  const from = process.env.RESEND_FROM_EMAIL ?? "onboarding@resend.dev";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY!}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: opts.to.map((r) => r.email),
      subject: opts.subject,
      html: opts.htmlContent,
      ...(opts.textContent ? { text: opts.textContent } : {}),
      ...(opts.replyTo ? { reply_to: opts.replyTo.email } : {}),
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Resend API error (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
}

// ─── Failure notification ─────────────────────────────────────────────
export async function sendAgentFailureEmail(opts: {
  agentName: string;
  invocationId: string;
  reason: string;
}): Promise<void> {
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail) {
    console.warn("[agent] sendAgentFailureEmail: ADMIN_EMAIL not set, skipping notification");
    return;
  }
  const dashboardUrl = process.env.NEXT_PUBLIC_SITE_URL
    ? `${process.env.NEXT_PUBLIC_SITE_URL}/agents/${opts.agentName}/invocations/${opts.invocationId}`
    : null;
  const html = `
    <div style="font-family:-apple-system,sans-serif;font-size:15px;line-height:1.6;max-width:600px;">
      <h2 style="color:#1A1410;">⚠️ Ton agent <code>${escape(opts.agentName)}</code> a un problème</h2>
      <p><strong>Raison :</strong> ${escape(opts.reason)}</p>
      <p><strong>Invocation :</strong> <code>${escape(opts.invocationId)}</code></p>
      ${dashboardUrl ? `<p><a href="${escape(dashboardUrl)}" style="color:#8B5CF6;">Voir le détail dans le dashboard →</a></p>` : ""}
      <p style="color:#7A7168;font-size:13px;margin-top:24px;">Cet email vient de ton agent Hypervibe. Si l'erreur est due au plafond budgétaire, l'agent reste en pause jusqu'au prochain cycle (jour ou mois selon le plafond touché).</p>
    </div>
  `;
  try {
    await sendMail({
      to: [{ email: adminEmail }],
      subject: `[Agent ${opts.agentName}] Erreur ou plafond atteint`,
      htmlContent: html,
    });
  } catch (e) {
    console.error("[agent] Failed to send failure email:", e);
  }
}

// The braces too: Brevo reads "{{ ... }}" in a message as its own template syntax, and a
// message it cannot render is dropped AFTER the API said yes, without any error here. A
// failure reason often quotes a provider's raw text, so it can carry "{{".
function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\{/g, "&#123;")
    .replace(/\}/g, "&#125;");
}

// Re-export ToolName so loop.ts can access it via this module too.
export type { ToolName };
