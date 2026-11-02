"use client";

// useSearchParams must be inside a Suspense boundary, otherwise Next.js fails
// to prerender this page at build time (CSR-bailout error). The fix is to wrap
// the form in a Suspense - the page itself renders fine without search params
// during prerender, then hydrates with the real values client-side.

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { toast } from "sonner";

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
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    const res = await signIn("credentials", {
      username,
      password,
      redirect: false,
    });
    setPending(false);

    if (res?.error) {
      toast.error("Identifiant ou mot de passe incorrect.");
      return;
    }
    // Only a path of this site. The router runs a `javascript:` address, and
    // another site's address sends the admin there: ?callbackUrl= must never be
    // taken as it comes (internalPath, above).
    const callbackUrl = internalPath(params.get("callbackUrl")) ?? "/admin";
    router.push(callbackUrl);
    router.refresh();
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Connexion admin</CardTitle>
          <CardDescription>Accès réservé à l’administrateur du site.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="grid gap-4">
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
            <Button type="submit" disabled={pending} className="w-full cursor-pointer">
              {pending ? "Connexion en cours..." : "Se connecter"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
