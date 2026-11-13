"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { SessionProvider, useSession, signOut } from "next-auth/react";
import { api } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
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
  const { data: session, status } = useSession();
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  // The current password, asked again to delete the account and checked on the server.
  const [password, setPassword] = useState("");

  const deleteAccount = api.auth.deleteAccount.useMutation({
    onSuccess: async () => {
      toast.success("Compte supprimé.");
      await signOut({ redirect: false });
      router.push("/");
      router.refresh();
    },
    onError: (err: { message: string }) => {
      toast.error(err.message);
    },
  });

  if (status === "loading") {
    return (
      <main className="container mx-auto max-w-3xl px-4 py-12">
        <p className="text-muted-foreground">Chargement…</p>
      </main>
    );
  }

  if (!session?.user) {
    router.push("/signin?callbackUrl=/account");
    return null;
  }

  return (
    <main className="container mx-auto max-w-3xl px-4 py-12">
      <h1 className="mb-8 text-3xl font-semibold tracking-tight">Mon compte</h1>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Informations</CardTitle>
          <CardDescription>Tes informations personnelles.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm">
          <div>
            <span className="text-muted-foreground">Email :</span>{" "}
            <span className="font-medium">{session.user.email}</span>
          </div>
          {session.user.name && (
            <div>
              <span className="text-muted-foreground">Nom :</span>{" "}
              <span className="font-medium">{session.user.name}</span>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Session</CardTitle>
          <CardDescription>Déconnecte-toi de cet appareil.</CardDescription>
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
            Se déconnecter
          </Button>
        </CardContent>
      </Card>

      <Card className="border-destructive/50">
        <CardHeader>
          <CardTitle className="text-destructive">Zone de danger</CardTitle>
          <CardDescription>
            La suppression du compte est définitive. Toutes tes données seront effacées.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {/* shadcn v3+ uses base-ui (no asChild). We control the dialog open state
              manually via a plain Button click + Dialog's `open`/`onOpenChange` props. */}
          <Button
            variant="destructive"
            className="cursor-pointer"
            onClick={() => setConfirming(true)}
          >
            Supprimer mon compte
          </Button>
          <Dialog
            open={confirming}
            onOpenChange={(open) => {
              setConfirming(open);
              if (!open) setPassword("");
            }}
          >
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Supprimer ton compte ?</DialogTitle>
                <DialogDescription>
                  Cette action est irréversible. Toutes tes données seront effacées.
                </DialogDescription>
              </DialogHeader>
              <div className="grid gap-2">
                <Label htmlFor="delete-password">Ton mot de passe actuel</Label>
                <Input
                  id="delete-password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  className="cursor-pointer"
                  onClick={() => setConfirming(false)}
                >
                  Annuler
                </Button>
                <Button
                  variant="destructive"
                  className="cursor-pointer"
                  disabled={deleteAccount.isPending || !password}
                  onClick={() => deleteAccount.mutate({ password })}
                >
                  {deleteAccount.isPending ? "Suppression…" : "Confirmer la suppression"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </CardContent>
      </Card>
    </main>
  );
}
