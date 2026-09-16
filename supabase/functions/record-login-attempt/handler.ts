import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { logger } from "../_shared/logger.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * The reasons the sign-in form can distinguish. Anything else is folded into
 * "other" rather than stored verbatim, so a future GoTrue error string cannot
 * turn this column into an uncontrolled sink for upstream text.
 */
const KNOWN_REASONS = new Set(["invalid_credentials", "user_banned", "other"]);

/** Emails longer than this are not real; truncate rather than store the blob. */
const MAX_EMAIL_LENGTH = 320; // RFC 3696 practical maximum
const MAX_USER_AGENT_LENGTH = 500;

/** Matches no row. Keeps the membership lookup unconditional — see below. */
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Volume bound, in two layers.
 *
 * The per-IP cap gives granularity for honest traffic, but its key comes from a
 * request header, and a header is whatever the caller says it is. An attacker
 * who rotates that value gets a fresh bucket every request, so the per-IP cap
 * ALONE bounds nothing on an unauthenticated endpoint.
 *
 * `MAX_TOTAL_PER_WINDOW` is therefore the actual guarantee: one counter for the
 * whole isolate that no header manipulation can escape. The per-IP cap sits in
 * front of it so a single noisy source cannot consume the global budget.
 *
 * Neither throttles per email — a distributed attack on one account is exactly
 * the signal worth keeping, and capping by email would erase it. Suppressed
 * attempts are logged rather than dropped silently, so the edge logs still show
 * a burst even when no row is written.
 *
 * Caveat: this state is per-isolate, like `send-contact-form`'s. Supabase runs
 * several isolates and recycles them freely, so the true ceiling is the cap
 * times the live isolate count — a bound, but not a precise one.
 */
const MAX_ATTEMPTS_PER_WINDOW = 50;
const MAX_TOTAL_PER_WINDOW = 500;
/** Stops key rotation growing the map without limit. */
const MAX_TRACKED_IPS = 1000;

const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
let globalWindow = { count: 0, resetTime: 0 };

/** Exported for testing — allows resetting rate limit state between tests. */
export function resetRateLimits(): void {
  rateLimitMap.clear();
  globalWindow = { count: 0, resetTime: 0 };
}

/** The isolate-wide cap. Checked first: it is the one that actually holds. */
function isGloballyRateLimited(now: number): boolean {
  if (now > globalWindow.resetTime) {
    globalWindow = { count: 1, resetTime: now + RATE_LIMIT_WINDOW_MS };
    return false;
  }
  if (globalWindow.count >= MAX_TOTAL_PER_WINDOW) return true;

  globalWindow.count++;
  return false;
}

function isRateLimited(ip: string, now: number): boolean {
  const entry = rateLimitMap.get(ip);

  if (!entry || now > entry.resetTime) {
    // Bound the map. Rotating the header key is cheap for a caller, so without
    // this an attacker could grow it until the isolate runs out of memory.
    if (rateLimitMap.size >= MAX_TRACKED_IPS) {
      for (const [key, value] of rateLimitMap) {
        if (now > value.resetTime) rateLimitMap.delete(key);
      }
      // Still full — every entry is live. Drop the oldest rather than grow.
      if (rateLimitMap.size >= MAX_TRACKED_IPS) {
        const oldest = rateLimitMap.keys().next();
        if (!oldest.done) rateLimitMap.delete(oldest.value);
      }
    }
    rateLimitMap.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }
  if (entry.count >= MAX_ATTEMPTS_PER_WINDOW) return true;

  entry.count++;
  return false;
}

/**
 * Best-effort client IP.
 *
 * ⚠️ NOT trustworthy, and nothing security-relevant may depend on it — see
 * `MAX_TOTAL_PER_WINDOW` above for the bound that does not.
 *
 * `x-forwarded-for` is a chain, and each proxy APPENDS the peer it saw. A
 * caller can prepend anything, so the LEFTMOST entry is attacker-controlled;
 * the rightmost is the one our own infrastructure observed. We take the
 * rightmost: it is the least forgeable of the options, though behind an extra
 * CDN hop it can be a shared egress address rather than the end user.
 *
 * This is still better than `login_history.ip_address`, which the browser
 * fetches from api.ipify.org and is wholly client-chosen — but "better" is not
 * "trusted".
 */
function getClientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const hops = forwarded.split(",").map((h) => h.trim()).filter(Boolean);
    if (hops.length > 0) return hops[hops.length - 1];
  }
  return req.headers.get("x-real-ip") ||
         req.headers.get("cf-connecting-ip") ||
         "unknown";
}

/**
 * Records one failed sign-in attempt.
 *
 * ⚠️ This endpoint is INTENTIONALLY not an oracle. It answers identically
 * whether or not the address belongs to an account, whether or not the insert
 * succeeded, and whether or not the attempt was rate limited — an
 * unauthenticated caller must not be able to probe which addresses exist. Every
 * path below returns the same `{ ok: true }` with status 200.
 *
 * It is also NOT a security control, and the data it writes is unverified in
 * both directions: our own UI is the only caller so anyone posting straight to
 * GoTrue never appears here, and because this endpoint cannot be authenticated
 * (it runs when authentication just failed, and GoTrue issues no signed proof
 * of a failed attempt) anyone who can reach it can submit any address and have
 * a row attributed to that user. The per-IP cap bounds the volume of forged
 * rows; it does not make them true. See the migration header.
 */
export const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // The single response every path returns. Built once so no branch can
  // accidentally differ in status, body or timing-relevant work.
  const ok = () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    let body: { email?: unknown; reason?: unknown };
    try {
      body = await req.json();
    } catch {
      logger.warn("record-login-attempt: body was not JSON");
      return ok();
    }

    const rawEmail = typeof body.email === "string" ? body.email.trim() : "";
    if (!rawEmail) {
      // Nothing to attribute the attempt to. Still not an error to the caller.
      logger.warn("record-login-attempt: no email supplied");
      return ok();
    }
    const email = rawEmail.slice(0, MAX_EMAIL_LENGTH).toLowerCase();

    const rawReason = typeof body.reason === "string" ? body.reason : "";
    const reason = KNOWN_REASONS.has(rawReason) ? rawReason : "other";

    const ip = getClientIp(req);
    const userAgent = (req.headers.get("user-agent") || "").slice(0, MAX_USER_AGENT_LENGTH);

    const now = Date.now();

    // Per-source first so one noisy caller cannot eat the global budget, then
    // the isolate-wide cap, which is the bound a rotating header cannot escape.
    if (isRateLimited(ip, now)) {
      // Keep the signal in the edge logs even though no row is written —
      // a burst past the cap is itself worth seeing.
      logger.warn("Failed-login reports rate limited for IP", {
        ip_address: ip,
        window_ms: RATE_LIMIT_WINDOW_MS,
        cap: MAX_ATTEMPTS_PER_WINDOW,
      });
      return ok();
    }

    if (isGloballyRateLimited(now)) {
      logger.warn("Failed-login reports hit the isolate-wide cap", {
        window_ms: RATE_LIMIT_WINDOW_MS,
        cap: MAX_TOTAL_PER_WINDOW,
      });
      return ok();
    }

    // `autoRefreshToken: false` matters here, not just for tidiness: the
    // default starts a token-refresh interval per client, and this handler
    // builds one per request. Under a burst that leaves an interval running
    // for every attempt in the isolate. A service-role key has no session to
    // refresh, so both flags are off — same as send-invitation / delete-user.
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { autoRefreshToken: false, persistSession: false } },
    );

    // Attribute the attempt when the address maps to a real account, so an
    // institution admin can be shown their own tenant's attempts. A miss is
    // normal and is itself the interesting case (an address nobody holds).
    let userId: string | null = null;
    let institutionId: string | null = null;

    // Plain equality, not ILIKE: `email` is already lowercased above and
    // profiles.email is GoTrue-normalized, so the lookup stays
    // case-insensitive while using the btree index on profiles(email) — and
    // ILIKE would treat % and _ in caller input as wildcards.
    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("user_id")
      .eq("email", email)
      .maybeSingle();

    if (profileError) {
      // Attribution is best-effort; an unattributed row still records the
      // attempt, which is the point. Do not abort.
      logger.warn("record-login-attempt: profile lookup failed", {
        error: profileError.message,
      });
    } else if (profile?.user_id) {
      userId = profile.user_id;
    }

    // The membership lookup runs UNCONDITIONALLY, even when no profile matched.
    //
    // Returning an identical status and body for a known and an unknown address
    // is not enough on its own: if only the matching branch made this second
    // round trip, an unauthenticated caller could tell the two apart by response
    // latency and use the endpoint to enumerate which addresses hold accounts.
    // Issuing the same queries either way keeps the I/O path free of any branch
    // on account existence. NIL_UUID matches no row, so the miss case does the
    // same work and gets the same nothing.
    const { data: membership, error: membershipError } = await supabase
      .from("user_institutions")
      .select("institution_id")
      .eq("user_id", userId ?? NIL_UUID)
      .limit(1)
      .maybeSingle();

    if (membershipError) {
      logger.warn("record-login-attempt: institution lookup failed", {
        error: membershipError.message,
      });
    } else if (userId) {
      institutionId = membership?.institution_id ?? null;
    }

    const { error: insertError } = await supabase
      .from("failed_login_attempts")
      .insert({
        email_attempted: email,
        user_id: userId,
        institution_id: institutionId,
        ip_address: ip,
        user_agent: userAgent || null,
        reason,
      });

    if (insertError) {
      // The row is the durable record; losing it means losing the only
      // brute-force signal the product has. Error, not warn.
      logger.error("Failed to record login attempt", { error: insertError.message });
    } else {
      logger.info("Recorded failed login attempt", {
        reason,
        ip_address: ip,
        attributed: !!userId,
      });
    }

    return ok();
  } catch (error) {
    logger.exception(error as Error, "record-login-attempt failed");
    // Still the same response — a thrown error must not become a signal either.
    return ok();
  }
};
