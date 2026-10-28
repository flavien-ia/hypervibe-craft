"use client";

// useSearchParams must be inside a Suspense boundary, otherwise Next.js fails
// to prerender this page at build time (CSR-bailout error).

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { toast } from "sonner";
import { loginAction } from "./actions";

/**
 * A path of this site taken from outside (here, ?callbackUrl=), or null. Read with the browser's
 * own URL parser, never with a pattern on the raw text: the parser drops tabs and line breaks and
 * reads `\` as `/`, so `/\t/evil.com` becomes `//evil.com`, another site. A path that still starts
 * with `//` once parsed (`/.//evil.com`) is refused too: the next navigation would read it as
 * another site. A `javascript:` address has another origin: refused.
 */
function internalPath(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const origin = window.location.origin;
    const target = new URL(raw, origin);
    if (target.origin !== origin || target.pathname.startsWith("//")) return null;
    return target.pathname + target.search + target.hash;
  } catch {
    return null;
  }
}

export default function AdminSignInPage() {
  return (
    <Suspense fallback={null}>
      <SignInForm />
    </Suspense>
  );
}

function SignInForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"credentials" | "2fa">("credentials");
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    const res = await loginAction({
      username,
      password,
      code: step === "2fa" ? code : undefined,
    });
    setPending(false);

    switch (res.status) {
      case "ok": {
        // Only a path of this site. The router runs a `javascript:` address, and
        // another site's address sends the admin there: ?callbackUrl= must never be
        // taken as it comes (internalPath, above).
        const callbackUrl = internalPath(params.get("callbackUrl")) ?? "/admin";
        router.push(callbackUrl);
        router.refresh();
        return;
      }
      case "2fa_required":
        setStep("2fa");
        toast.info("Entre le code de ton appli d’authentification.");
        return;
      case "invalid_code":
        toast.error("Code incorrect. Réessaie.");
        return;
      case "bad_credentials":
        setStep("credentials");
        setCode("");
        toast.error("Identifiant ou mot de passe incorrect.");
        return;
      case "rate_limited":
        toast.error(`Trop de tentatives. Réessaie dans ${res.minutes} min.`);
        return;
      default:
        toast.error("Une erreur est survenue. Réessaie.");
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Connexion admin</CardTitle>
          <CardDescription>
            {step === "credentials"
              ? "Accès réservé à l’administrateur du site."
              : "Vérification en deux étapes."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="grid gap-4">
            {step === "credentials" ? (
              <>
                <div className="grid gap-2">
                  <Label htmlFor="username">Identifiant</Label>
                  <Input
                    id="username"
                    type="text"
                    autoComplete="username"
                    required
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="password">Mot de passe</Label>
                  <Input
                    id="password"
                    type="password"
                    autoComplete="current-password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </div>
              </>
            ) : (
              <div className="grid gap-2">
                <Label htmlFor="code">Code de vérification</Label>
                <Input
                  id="code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus
                  required
                  placeholder="123456 ou code de secours"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Code à 6 chiffres de ton appli d’authentification (ou un code de secours).
                </p>
              </div>
            )}

            <Button type="submit" disabled={pending} className="w-full cursor-pointer">
              {pending
                ? "Connexion en cours..."
                : step === "credentials"
                  ? "Se connecter"
                  : "Vérifier"}
            </Button>

            {step === "2fa" && (
              <button
                type="button"
                className="cursor-pointer text-center text-xs text-muted-foreground hover:text-foreground"
                onClick={() => {
                  setStep("credentials");
                  setCode("");
                }}
              >
                Revenir à l’identifiant
              </button>
            )}
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
