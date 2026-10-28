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
    // Only accept a same-origin relative path. The router runs a `javascript:`
    // address, and an `https://` or `//` one sends the admin to another site:
    // ?callbackUrl= must never be taken as it comes.
    const rawCallback = params.get("callbackUrl");
    const callbackUrl = rawCallback && /^\/(?![/\\])/.test(rawCallback) ? rawCallback : "/admin";
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
