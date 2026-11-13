"use client";

import { signOut } from "next-auth/react";
import { Button } from "~/components/ui/button";

// The sign-out goes through Auth.js's own route (/api/auth/signout), from the browser, then a full
// page load to the sign-in page: the session cookie is gone when that page asks for it. The server
// action it replaces (`await signOut({ redirectTo })` in a "use server" form) answered 303 and left
// the session open on a real site (next-auth 5.0.0-beta.32, Next.js 15.5, report of 12/11/2026).
export function SignOutButton() {
  return (
    <Button
      variant="outline"
      type="button"
      className="cursor-pointer"
      onClick={() => void signOut({ redirectTo: "/admin/signin" })}
    >
      Se déconnecter
    </Button>
  );
}
