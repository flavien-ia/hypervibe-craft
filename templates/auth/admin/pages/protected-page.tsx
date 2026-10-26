import { isAdmin, signOut } from "~/server/auth";
import { requireAdmin } from "~/server/require-admin";
import { Button } from "~/components/ui/button";

// Every page of admin/(protected)/ starts with `await requireAdmin()`, before reading anything: the
// layout's check is not enough (Next.js renders the layout and the page at the same time, and the
// layout's redirect leaves with the page's content). Every "use server" action checks for itself.
export default async function AdminHomePage() {
  await requireAdmin();
  return (
    <main className="mx-auto max-w-3xl px-4 py-12">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-semibold">Espace admin</h1>
        <form
          action={async () => {
            "use server";
            if (!(await isAdmin())) return;
            await signOut({ redirectTo: "/admin/signin" });
          }}
        >
          <Button variant="outline" type="submit" className="cursor-pointer">
            Se déconnecter
          </Button>
        </form>
      </div>
      <p className="mt-6 text-muted-foreground">
        Bienvenue dans ton espace admin. C’est ici que tu géreras les contenus
        de ton site. Demande à Claude d’ajouter les pages dont tu as besoin
        (par exemple : « ajoute une page pour gérer les réservations »).
      </p>
    </main>
  );
}
