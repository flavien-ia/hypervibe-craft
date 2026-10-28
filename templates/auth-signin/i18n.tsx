"use client";

// useSearchParams must be inside a Suspense boundary, otherwise Next.js fails
// to prerender this page at build time (CSR-bailout error). The fix is to wrap
// the form in a Suspense - the page itself renders fine without search params
// during prerender, then hydrates with the real values client-side.

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Link } from "~/i18n/navigation";
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

export default function SignInPage() {
  return (
    <Suspense fallback={null}>
      <SignInForm />
    </Suspense>
  );
}

function SignInForm() {
  const t = useTranslations("signin");
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
      toast.error(t("errorInvalidCredentials"));
      return;
    }
    // Only a path of this site - no open redirect through ?callbackUrl=https://evil.com,
    // //evil.com or /%09/evil.com (internalPath, above).
    const callbackUrl = internalPath(params.get("callbackUrl")) ?? "/dashboard";
    router.push(callbackUrl);
    router.refresh();
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
          <CardDescription>{t("description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="email">{t("emailLabel")}</Label>
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
              <Label htmlFor="password">{t("passwordLabel")}</Label>
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
              {pending ? t("submitPending") : t("submit")}
            </Button>
            <div className="flex items-center justify-between text-sm">
              <Link href="/signup" className="text-muted-foreground hover:text-foreground hover:underline">
                {t("createAccountLink")}
              </Link>
              {{FORGOT_PASSWORD_LINK}}
            </div>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
