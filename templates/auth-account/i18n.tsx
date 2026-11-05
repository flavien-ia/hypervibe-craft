"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { SessionProvider, useSession, signOut } from "next-auth/react";
import { api } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { toast } from "sonner";

// The page brings its own SessionProvider: useSession() needs one, and nothing else in the project
// is sure to provide it (the header's user menu, which brought it, is only added when the site has a
// header). Without it, `next build` failed prerendering /account (bench of the solo harness, 04/11/2026).
export default function AccountPage() {
  return (
    <SessionProvider>
      <AccountContent />
    </SessionProvider>
  );
}

function AccountContent() {
  const t = useTranslations("account");
  const { data: session, status } = useSession();
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);

  const deleteAccount = api.auth.deleteAccount.useMutation({
    onSuccess: async () => {
      toast.success(t("toastDeleted"));
      await signOut({ redirect: false });
      router.push("/");
      router.refresh();
    },
    onError: (err: { message: string }) => {
      toast.error(err.message);
      setConfirming(false);
    },
  });

  if (status === "loading") {
    return (
      <main className="container mx-auto max-w-3xl px-4 py-12">
        <p className="text-muted-foreground">{t("loading")}</p>
      </main>
    );
  }

  if (!session?.user) {
    router.push("/signin?callbackUrl=/account");
    return null;
  }

  return (
    <main className="container mx-auto max-w-3xl px-4 py-12">
      <h1 className="mb-8 text-3xl font-semibold tracking-tight">{t("pageTitle")}</h1>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>{t("infoCardTitle")}</CardTitle>
          <CardDescription>{t("infoCardDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm">
          <div>
            <span className="text-muted-foreground">{t("emailLabel")}</span>{" "}
            <span className="font-medium">{session.user.email}</span>
          </div>
          {session.user.name && (
            <div>
              <span className="text-muted-foreground">{t("nameLabel")}</span>{" "}
              <span className="font-medium">{session.user.name}</span>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>{t("sessionCardTitle")}</CardTitle>
          <CardDescription>{t("sessionCardDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            variant="outline"
            className="cursor-pointer"
            onClick={async () => {
              await signOut({ redirect: false });
              router.push("/");
              router.refresh();
            }}
          >
            {t("signoutButton")}
          </Button>
        </CardContent>
      </Card>

      <Card className="border-destructive/50">
        <CardHeader>
          <CardTitle className="text-destructive">{t("dangerCardTitle")}</CardTitle>
          <CardDescription>{t("dangerCardDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          {/* shadcn v3+ uses base-ui (no asChild). We control the dialog open state
              manually via a plain Button click + Dialog's `open`/`onOpenChange` props. */}
          <Button
            variant="destructive"
            className="cursor-pointer"
            onClick={() => setConfirming(true)}
          >
            {t("deleteButton")}
          </Button>
          <Dialog open={confirming} onOpenChange={setConfirming}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{t("deleteDialogTitle")}</DialogTitle>
                <DialogDescription>{t("deleteDialogDescription")}</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button
                  variant="outline"
                  className="cursor-pointer"
                  onClick={() => setConfirming(false)}
                >
                  {t("cancel")}
                </Button>
                <Button
                  variant="destructive"
                  className="cursor-pointer"
                  disabled={deleteAccount.isPending}
                  onClick={() => deleteAccount.mutate()}
                >
                  {deleteAccount.isPending ? t("deletePending") : t("confirmDelete")}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </CardContent>
      </Card>
    </main>
  );
}
