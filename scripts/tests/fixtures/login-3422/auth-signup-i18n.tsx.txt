"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Link, useRouter } from "~/i18n/navigation";
import { signIn } from "next-auth/react";
import { api } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { toast } from "sonner";

export default function SignUpPage() {
  const t = useTranslations("signup");
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);

  const signup = api.auth.signup.useMutation();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    try {
      await signup.mutateAsync({
        email,
        password,
        name: name || undefined,
      });

      // Auto-signin after successful signup
      const res = await signIn("credentials", {
        email,
        password,
        redirect: false,
      });
      if (res?.error) {
        toast.error(t("errorAutoSigninFailed"));
        router.push("/signin");
        return;
      }
      router.push("/dashboard");
      router.refresh();
    } catch (err) {
      // tRPC throws TRPCClientErrorLike which extends Error and exposes `message`.
      const message =
        err && typeof err === "object" && "message" in err
          ? String((err as { message: unknown }).message)
          : t("errorGeneric");
      toast.error(message);
      setPending(false);
    }
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
              <Label htmlFor="name">{t("nameLabel")}</Label>
              <Input
                id="name"
                type="text"
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="password">{t("passwordLabel")}</Label>
              <Input
                id="password"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <Button type="submit" disabled={pending} className="w-full cursor-pointer">
              {pending ? t("submitPending") : t("submit")}
            </Button>
            <div className="text-center text-sm text-muted-foreground">
              {t("alreadyHaveAccount")}{" "}
              <Link href="/signin" className="hover:text-foreground hover:underline">
                {t("signinLink")}
              </Link>
            </div>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
