// Admin page for managing users and their roles: a server page that checks first, then renders
// the interactive table kept in its own client file (users-table.tsx). The layout's check alone
// is not enough: Next.js renders the layout and the page at the same time, and the layout's
// redirect would leave with the page's content.
import { requireAdmin } from "~/server/require-admin";
import { UsersTable } from "./users-table";

export default async function AdminUsersPage() {
  await requireAdmin();
  return <UsersTable />;
}
