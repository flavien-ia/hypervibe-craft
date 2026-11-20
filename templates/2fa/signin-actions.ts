"use server";

import { headers } from "next/headers";
import { signIn } from "~/server/auth";
import { verifyPassword, getAdminPasswordHash } from "~/lib/password";
import {
  verifyTotp,
  isTrustedDevice,
  setTrustedDevice,
  createLoginProof,
} from "~/lib/auth-2fa";
import { consumeBackupCode } from "~/lib/auth-backup-codes";
import { checkRateLimit } from "~/lib/rate-limit";

export type LoginResult =
  | { status: "ok" }
  | { status: "bad_credentials" }
  | { status: "2fa_required" }
  | { status: "invalid_code" }
  | { status: "rate_limited"; minutes: number }
  | { status: "error" };

export async function loginAction(input: {
  username: string;
  password: string;
  code?: string;
}): Promise<LoginResult> {
  try {
    // Sans adresse (développement local), seuls les comptes par compte ci-dessous s'appliquent :
    // aucun seau commun que cinq essais de n'importe qui fermeraient pour tous.
    const forwarded = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
    const ip = forwarded === "" ? null : forwarded;
    const limited = (r: { allowed: boolean; retryAfterMs?: number }): LoginResult | null =>
      r.allowed ? null : { status: "rate_limited", minutes: Math.ceil((r.retryAfterMs ?? 0) / 60000) };
    const byAddress = ip ? limited(checkRateLimit(`login:${ip}`)) : null;
    if (byAddress) return byAddress;

    const username = input.username?.trim();
    const password = input.password;
    if (!username || !password) return { status: "bad_credentials" };

    const expectedUsername = process.env.ADMIN_USERNAME ?? "admin";
    if (username !== expectedUsername) return { status: "bad_credentials" };
    // Le compte a son propre compteur, quelle que soit l'adresse : ce qui empêche de deviner son
    // mot de passe depuis beaucoup d'adresses à la fois. Quatre compteurs de cinq, choisis par
    // l'adresse : vingt essais en 15 minutes, et une adresse ne remplit que son quart.
    let slot = 0;
    for (const ch of ip ?? "") slot = (slot * 31 + ch.charCodeAt(0)) % 4;
    const byAccount = limited(checkRateLimit(`login:account:admin:${slot}`));
    if (byAccount) return byAccount;

    const passwordOk = await verifyPassword(password, getAdminPasswordHash());
    if (!passwordOk) return { status: "bad_credentials" };

    // 2e facteur - sauf si l'appareil est déjà de confiance (< 24h).
    const trusted = await isTrustedDevice();
    if (!trusted) {
      const code = input.code?.trim();
      if (!code) return { status: "2fa_required" };
      // Le code à 6 chiffres a son compteur à lui, qui ne dépend d'aucune adresse : cinq essais
      // en 15 minutes, pour le compte. On n'arrive ici qu'avec le bon mot de passe : personne
      // d'autre ne peut le remplir.
      const byCode = limited(checkRateLimit("login:code:admin"));
      if (byCode) return byCode;
      const codeOk = verifyTotp(code) || (await consumeBackupCode(code));
      if (!codeOk) return { status: "invalid_code" };
      await setTrustedDevice();
    }

    // Émet la preuve signée puis ouvre la session NextAuth.
    const proof = createLoginProof(username);
    await signIn("credentials", { username, proof, redirect: false });

    return { status: "ok" };
  } catch {
    return { status: "error" };
  }
}
