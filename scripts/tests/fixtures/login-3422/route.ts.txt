import { type NextRequest, NextResponse } from "next/server";
import { handlers } from "~/server/auth";
import { checkRateLimit } from "~/lib/rate-limit";

export const GET = handlers.GET;

/**
 * NextAuth POST handler with IP-based rate limiting on the credentials callback.
 * Other NextAuth POST endpoints (CSRF token, signout, etc.) bypass the limiter.
 */
export async function POST(req: NextRequest) {
  const url = new URL(req.url);
  if (url.pathname.includes("/callback/credentials")) {
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    const { allowed, retryAfterMs } = checkRateLimit(ip);
    if (!allowed) {
      return NextResponse.json(
        { error: "Trop de tentatives. Réessaie dans quelques minutes." },
        {
          status: 429,
          headers: { "Retry-After": String(Math.ceil((retryAfterMs ?? 0) / 1000)) },
        },
      );
    }
  }
  return handlers.POST(req);
}
