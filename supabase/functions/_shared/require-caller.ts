import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  AAL2_REQUIRED_CODE,
  AAL2_REQUIRED_MESSAGE,
  callerMfaSatisfied,
} from "./require-aal2.ts";

/**
 * Authentication for handlers that have no resource to authorize against
 * (#1137).
 *
 * The Gap C functions — the PDF converters, the image generator and moderator,
 * the timeline builder, the vector-store probe — spend the platform's
 * OpenAI/ConvertAPI budget on caller-supplied content. There is no tenant
 * resource in the request to check anyone against: a caller converting their
 * own HTML to PDF is not acting on a course. So "is this anyone at all" is the
 * whole rule, and it is the difference between an endpoint the internet can
 * spend money through and one only signed-in users can.
 *
 * Handlers that DO act on a tenant resource must not use this — they need
 * `course-authz.ts` and an authorization check against that resource. This is
 * deliberately the weaker gate, for the cases where the stronger one has
 * nothing to bind to.
 *
 * These handlers hold no Supabase client of their own, so this builds one
 * rather than making every caller assemble the same three lines.
 */
export async function requireCaller(
  req: Request,
): Promise<
  { ok: true; userId: string; email: string | null } | {
    ok: false;
    status: number;
    error: string;
    code?: string;
  }
> {
  const authHeader = req.headers.get("Authorization") ?? req.headers.get("authorization");
  if (!authHeader) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !supabaseServiceKey) {
    return { ok: false, status: 500, error: "Server is not configured" };
  }

  const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
    // No session to refresh on a service-role client, and leaving the refresh
    // timer on leaks an interval in the handler tests.
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const token = authHeader.replace("Bearer ", "");
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  const user = data?.user;

  if (error || !user) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }

  // RLS's aal2 enforcement never runs for these handlers (service-role
  // client), so the assurance check has to live on the resolver itself.
  if (!callerMfaSatisfied(user, token)) {
    return {
      ok: false,
      status: 403,
      error: AAL2_REQUIRED_MESSAGE,
      code: AAL2_REQUIRED_CODE,
    };
  }

  return { ok: true, userId: user.id, email: user.email ?? null };
}
