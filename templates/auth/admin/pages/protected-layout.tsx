import { requireAdmin } from "~/server/require-admin";

// This check is never the barrier on its own: Next.js renders this layout and the page at the same
// time, and a redirect from here would leave with the page's content already rendered. Every
// page.tsx of this folder calls requireAdmin() itself, on its first line; this one stays as well.
export default async function AdminProtectedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireAdmin();
  return <>{children}</>;
}
