"use client";

// useSearchParams must be inside a Suspense boundary, otherwise Next.js fails
// to prerender this page at build time (CSR-bailout error). The fix is to wrap
// the form in a Suspense - the page itself renders fine without search params
// during prerender, then hydrates with the real values client-side.

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { signIn } from "next-auth/react";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { toast } from "sonner";

export default function SignInPage() {
  return (
    <Suspense fallback={null}>
      <SignInForm />
    </Suspense>
  );
}

function SignInForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    const res = await signIn("credentials", {
      email,
      password,
      redirect: false,
    });
    setPending(false);

    if (res?.error) {
      toast.error("Email ou mot de passe incorrect.");
      return;
    }
    // Only accept a same-origin relative path - block open redirects such as
    // ?callbackUrl=https://evil.com or //evil.com.
    const rawCallback = params.get("callbackUrl");
    const callbackUrl = rawCallback && /^\/(?![/\\])/.test(rawCallback) ? rawCallback : "/dashboard";
    router.push(callbackUrl);
    router.refresh();
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Connexion</CardTitle>
          <CardDescription>Entre tes identifiants pour accéder à ton compte.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
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
              {pending ? "Connexion en cours…" : "Se connecter"}
            </Button>
            <div className="flex items-center justify-between text-sm">
              <Link href="/signup" className="text-muted-foreground hover:text-foreground hover:underline">
                Créer un compte
              </Link>
              {{FORGOT_PASSWORD_LINK}}
            </div>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
