import { requireAdmin } from "~/server/require-admin";
import { SignOutButton } from "./sign-out-button";

// Every page of admin/(protected)/ starts with `await requireAdmin()`, before reading anything: the
// layout's check is not enough (Next.js renders the layout and the page at the same time, and the
// layout's redirect leaves with the page's content). Every "use server" action checks for itself.
// The sign-out is a client component (sign-out-button.tsx), never a server action: that one left
// the session open.
export default async function AdminHomePage() {
  await requireAdmin();
  return (
    <main className="mx-auto max-w-3xl px-4 py-12">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-semibold">Espace admin</h1>
        <SignOutButton />
      </div>
      <p className="mt-6 text-muted-foreground">
        Bienvenue dans ton espace admin. C’est ici que tu géreras les contenus
        de ton site. Demande à Claude d’ajouter les pages dont tu as besoin
        (par exemple : « ajoute une page pour gérer les réservations »).
      </p>
    </main>
  );
}
