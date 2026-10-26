import "server-only";
import { redirect } from "next/navigation";
import { isAdmin } from "~/server/auth";

/**
 * The gate of an admin page: call it on the FIRST line of every page.tsx of admin/(protected)/,
 * before any data is read (`await requireAdmin();`).
 *
 * The check of the group's layout is not enough: Next.js renders the layout and the page at the
 * same time, and when the layout redirects a visitor without a session, the page it has already
 * rendered leaves in the body of that redirect, readable with a plain `curl`. The layout keeps its
 * own check as well, and every "use server" action starts with `if (!(await isAdmin())) return;`.
 */
export async function requireAdmin(): Promise<void> {
  if (!(await isAdmin())) {
    redirect("/admin/signin?callbackUrl=/admin");
  }
}
