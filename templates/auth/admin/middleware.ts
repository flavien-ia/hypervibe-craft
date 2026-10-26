// hypervibe:admin-gate
import { NextResponse, type NextRequest } from "next/server";

/**
 * The first barrier of the admin space, never the only one: a request for an admin page that
 * carries no session cookie goes to the sign-in page before anything is rendered. A cookie is not
 * a proof: it only lets the request through to the real checks, `requireAdmin()` on the first
 * line of every page of admin/(protected)/, and the admin check of every procedure and every
 * "use server" action.
 *
 * Next.js 15 reads this file as src/middleware.ts, Next.js 16 as src/proxy.ts: same content.
 */
export default function adminGate(request: NextRequest) {
  const hasSession = request.cookies
    .getAll()
    .some(({ name }) => /^(__Secure-)?authjs\.session-token(\.\d+)?$/.test(name));
  if (hasSession) return NextResponse.next();

  const url = request.nextUrl.clone();
  url.pathname = "/admin/signin";
  url.search = "?callbackUrl=/admin";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/admin", "/admin/((?!signin).*)"],
};
