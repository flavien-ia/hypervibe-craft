#!/usr/bin/env node
// test-email-templates.mjs - Two promises of the email templates (3.4.11, review of the lot 8):
//   - Resend's client is built at the first send, never when the module loads: the SDK refuses to
//     be built without a key, and every router that sends mail imports this module, so a project
//     without its key yet lost its whole API;
//   - a password reset request never tells the caller that the email failed (that would say the
//     account exists), and an unknown address waits about as long as a send takes.
// Reads the templates as text: they are TypeScript, copied into a project, never run here.
//
//   node scripts/tests/test-email-templates.mjs

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...p) => readFileSync(join(ROOT, "templates", ...p), "utf8");

let checks = 0;
let failures = 0;
function check(label, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "OK  " : "FAIL"} ${label}${ok || !detail ? "" : `   (${detail})`}`);
}

/** The lines of a module that run when it loads: outside any function, class or object body. */
function topLevel(text) {
  let depth = 0;
  const out = [];
  for (const line of text.split("\n")) {
    if (depth === 0) out.push(line);
    for (const c of line) {
      if (c === "{") depth += 1;
      if (c === "}") depth = Math.max(0, depth - 1);
    }
  }
  return out.join("\n");
}

console.log("── Resend : le client se construit au premier envoi ──");
const mail = read("email", "resend", "mail.ts");
check("aucun « new Resend( » ne s'exécute au chargement du module", !/new Resend\(/.test(topLevel(mail)) && /new Resend\(process\.env\.RESEND_API_KEY\)/.test(mail));
check("sans clé, l'envoi dit pourquoi au lieu de faire tomber le module", /if \(!process\.env\.RESEND_API_KEY\)\s*\{\s*throw new Error\(/.test(mail));
check("l'envoi passe par le client construit à la demande", /await resend\(\)\.emails\.send\(/.test(mail) && !/await resend\.emails\.send\(/.test(mail));
check("témoin : l'ancien module serait vu", /new Resend\(/.test(topLevel('import { Resend } from "resend";\nconst resend = new Resend(process.env.RESEND_API_KEY);\n')));

console.log("\n── Mot de passe oublié : la même réponse, que le compte existe ou non ──");
for (const v of ["resend", "brevo"]) {
  const t = read("auth", "users", `auth-router-with-reset-${v}.ts`);
  const start = t.indexOf("requestPasswordReset:");
  const body = t.slice(start, t.indexOf("return { success: true };", start));
  const tryAt = body.indexOf("try {");
  const sendAt = body.indexOf("await sendMail(");
  const catchAt = body.indexOf("} catch (e) {");
  check(`${v} : l'envoi est dans un try, son échec reste côté serveur`, tryAt > 0 && tryAt < sendAt && sendAt < catchAt && /console\.error\("\[auth\] password reset email not sent:"/.test(body), `${tryAt} ${sendAt} ${catchAt}`);
  check(`${v} : le catch ne relance rien et ne répond rien d'autre`, !/throw\b/.test(body.slice(catchAt, body.indexOf("} else {", catchAt))) && !/return\b/.test(body.slice(catchAt)));
  check(`${v} : une adresse inconnue attend à peu près le temps d'un envoi`, /await new Promise\(\(resolve\) => setTimeout\(resolve, 250 \+ Math\.floor\(Math\.random\(\) \* 400\)\)\);/.test(body.slice(body.indexOf("} else {"))));
}

console.log("\n── Un lien de réinitialisation se retrouve par son empreinte et ne sert qu'une fois (3.4.33) ──");
{
  const { createHash } = await import("node:crypto");
  for (const v of ["resend", "brevo"]) {
    const t = read("auth", "users", `auth-router-with-reset-${v}.ts`).replace(/\r\n/g, "\n");
    const ask = t.slice(t.indexOf("requestPasswordReset:"), t.indexOf("resetPassword:"));
    const reset = t.slice(t.indexOf("resetPassword:"));
    // The function the router keeps a link by, run: the SHA-256 of the token, in hexadecimal.
    const fn = /const tokenHashOf = \(token: string\) => (createHash\("sha256"\)\.update\(token\)\.digest\("hex"\));/.exec(t)?.[1];
    const run = fn ? new Function("createHash", "token", `return ${fn};`) : null;
    check(`${v} : l'empreinte gardée d'un lien est son SHA-256, calculable sans rien lire en base`, Boolean(run) && run(createHash, "jeton") === createHash("sha256").update("jeton").digest("hex") && /import \{ createHash, randomBytes \} from "crypto";/.test(t));
    check(`${v} : la réinitialisation ne lit plus tous les liens vivants, et ne hache plus le lien contre chacun`, !/findMany\(/.test(reset) && !/verifyPassword\(input\.token/.test(reset) && !/for \(const c of candidates\)/.test(reset));
    const consume = /await db\s*\.update\(passwordResetTokens\)\s*\.set\(\{ consumedAt: new Date\(\) \}\)\s*\.where\(\s*and\(\s*eq\(passwordResetTokens\.tokenHash, tokenHashOf\(input\.token\)\),\s*isNull\(passwordResetTokens\.consumedAt\),\s*gt\(passwordResetTokens\.expiresAt, new Date\(\)\),\s*\),\s*\)\s*\.returning\(\{ userId: passwordResetTokens\.userId \}\);/.exec(reset);
    check(`${v} : le lien est trouvé par son empreinte et consommé dans la même instruction (deux demandes simultanées ne passent pas toutes les deux)`, Boolean(consume) && reset.indexOf("if (!used) {") > consume.index && reset.indexOf("await hashPassword(input.newPassword)") > reset.indexOf("if (!used) {"));
    const changed = reset.indexOf("passwordChangedAt: new Date()");
    const others = reset.indexOf("and(eq(passwordResetTokens.userId, used.userId), isNull(passwordResetTokens.consumedAt))");
    check(`${v} : une fois le mot de passe changé, les autres liens du compte sont consommés`, changed > 0 && others > changed);
    const end = ask.indexOf("and(eq(passwordResetTokens.userId, user.id), isNull(passwordResetTokens.consumedAt))");
    const insert = ask.indexOf("db.insert(passwordResetTokens)");
    check(`${v} : demander un lien met fin aux liens demandés avant, et garde l'empreinte, jamais le jeton`, end > 0 && insert > end && /tokenHash: tokenHashOf\(rawToken\),/.test(ask) && !/hashPassword\(rawToken\)/.test(ask));
    const count = ask.indexOf("const mayAsk = user ? checkRateLimit(`reset:account:${user.id}`).allowed : false;");
    check(`${v} : une limite par compte sur la demande : au-delà, la même réponse et rien n'est envoyé`, count > 0 && ask.indexOf("if (user && mayAsk) {") > count && ask.indexOf("} else {") > ask.indexOf("await sendMail("));
  }
  const schema = read("auth", "users", "schema-additions-reset-tokens.ts");
  check("le schéma garde l'index sur l'empreinte, et dit qu'elle n'est pas un hachage lent", /tokenHashIdx: index\("password_reset_token_hash_idx"\)\.on\(t\.tokenHash\)/.test(schema) && /SHA-256/.test(schema) && !/hash via scrypt/.test(schema));
}

console.log("\n── Un message de contact qui cite une adresse locale arrive quand même (3.4.33) ──");
for (const v of ["resend", "brevo"]) {
  const mail = read("email", v, "mail.ts");
  const contact = read("email", v, "contact-router.ts");
  const reset = read("auth", "users", `auth-router-with-reset-${v}.ts`);
  const send = contact.slice(contact.indexOf("await sendMail("));
  check(`${v} : le refus des liens vers le poste ne lit pas un mail qui porte les mots d'un visiteur`, /if \(options\.allowLocalLinks !== true\) refuseLocalLinks\(/.test(mail) && !/^\s*refuseLocalLinks\(options\./m.test(mail) && /allowLocalLinks\?: boolean;/.test(mail));
  check(`${v} : le formulaire de contact le dit, à son envoi`, /allowLocalLinks: true,/.test(send.slice(0, send.indexOf("});"))));
  check(`${v} : le mail de réinitialisation, lui, reste refusé s'il porte un lien vers le poste`, !reset.includes("allowLocalLinks"));
}

console.log(`\n${checks - failures}/${checks} checks`);
process.exitCode = failures ? 1 : 0;
