import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Resend } from "https://esm.sh/resend@2.0.0";
import { logger } from "../_shared/logger.ts";
import { recordAudit } from "../_shared/audit.ts";
import { edgeBrand, emailFooterText, monogram } from "../_shared/brand.ts";
import {
  AAL2_REQUIRED_CODE,
  AAL2_REQUIRED_MESSAGE,
  callerMfaSatisfied,
} from "../_shared/require-aal2.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

interface InvitationRequest {
  email: string;
  invitedName?: string;
  institutionId: string;
  institutionName: string;
  inviterName: string;
}

/**
 * Every interpolated value here is escaped.
 *
 * `inviterName` and `institutionName` are operator- and user-supplied strings
 * that reach this template unmodified, so raw interpolation let a name
 * containing markup rewrite the email — the sibling `bulk-invite-users`
 * template has escaped them all along, and this one did not.
 */
const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const generateEmailHtml = (
  invitedName: string | undefined,
  inviterName: string,
  institutionName: string,
  inviteLink: string,
  brandName: string,
  brandTagline: string | null,
  footer: string,
) => `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #f8f9fa; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background-color: #f8f9fa; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width: 560px; background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 24px rgba(0,0,0,0.08);">

          <!-- Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f0f23 100%); padding: 48px 40px; text-align: center;">
              <div style="width: 64px; height: 64px; background: linear-gradient(135deg, #d4af37 0%, #f4d03f 50%, #d4af37 100%); border-radius: 16px; margin: 0 auto 20px; display: flex; align-items: center; justify-content: center;">
                <span style="font-size: 32px; color: #1a1a2e; font-weight: bold;">${escapeHtml(monogram(brandName))}</span>
              </div>
              <h1 style="color: #ffffff; margin: 0; font-size: 28px; font-weight: 700; letter-spacing: -0.5px;">${escapeHtml(brandName)}</h1>
              ${
  brandTagline
    ? `<p style="color: #a0a0b0; margin: 8px 0 0; font-size: 14px;">${escapeHtml(brandTagline)}</p>`
    : ""
}
            </td>
          </tr>

          <!-- Content -->
          <tr>
            <td style="padding: 48px 40px;">
              <h2 style="color: #1a1a2e; margin: 0 0 8px; font-size: 24px; font-weight: 600;">
                ${invitedName ? `Hello ${escapeHtml(invitedName)}! 👋` : "You're Invited! 🎉"}
              </h2>
              <p style="color: #6b7280; margin: 0 0 32px; font-size: 16px; line-height: 1.6;">
                Great news! You've been invited to join a learning community.
              </p>

              <!-- Invitation Card -->
              <div style="background: linear-gradient(135deg, #f8f9fa 0%, #f1f5f9 100%); border-radius: 12px; padding: 24px; margin-bottom: 32px; border-left: 4px solid #d4af37;">
                <p style="color: #6b7280; margin: 0 0 8px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600;">Invited by</p>
                <p style="color: #1a1a2e; margin: 0 0 16px; font-size: 18px; font-weight: 600;">${escapeHtml(inviterName)}</p>
                <p style="color: #6b7280; margin: 0 0 8px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600;">Institution</p>
                <p style="color: #1a1a2e; margin: 0; font-size: 18px; font-weight: 600;">${escapeHtml(institutionName)}</p>
              </div>

              <!-- CTA Button -->
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
                <tr>
                  <td align="center">
                    <a href="${escapeHtml(inviteLink)}" style="display: inline-block; background: linear-gradient(135deg, #d4af37 0%, #c9a227 100%); color: #1a1a2e; text-decoration: none; padding: 16px 48px; border-radius: 10px; font-weight: 700; font-size: 16px; box-shadow: 0 4px 14px rgba(212, 175, 55, 0.4); transition: transform 0.2s;">
                      Accept Invitation →
                    </a>
                  </td>
                </tr>
              </table>

              <p style="color: #9ca3af; margin: 32px 0 0; font-size: 13px; text-align: center; line-height: 1.6;">
                If you didn't expect this invitation, you can safely ignore this email.
              </p>
            </td>
          </tr>

          <!-- Features Section -->
          <tr>
            <td style="padding: 0 40px 40px;">
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
                <tr>
                  <td style="background: #fafbfc; border-radius: 12px; padding: 24px;">
                    <p style="color: #1a1a2e; margin: 0 0 16px; font-size: 14px; font-weight: 600;">What you'll get access to:</p>
                    <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
                      <tr>
                        <td style="padding: 6px 0; color: #4b5563; font-size: 14px;">✨ AI-powered tutoring sessions</td>
                      </tr>
                      <tr>
                        <td style="padding: 6px 0; color: #4b5563; font-size: 14px;">📚 Interactive study materials</td>
                      </tr>
                      <tr>
                        <td style="padding: 6px 0; color: #4b5563; font-size: 14px;">🎯 Personalized practice questions</td>
                      </tr>
                      <tr>
                        <td style="padding: 6px 0; color: #4b5563; font-size: 14px;">📊 Progress tracking & insights</td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background: #f8f9fa; padding: 24px 40px; text-align: center; border-top: 1px solid #e5e7eb;">
              <p style="color: #9ca3af; margin: 0; font-size: 12px;">
                ${escapeHtml(footer)}
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`;

export const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { email, invitedName, institutionId, institutionName, inviterName }: InvitationRequest = await req.json();
    logger.info("Sending invitation", { email, institutionName, inviterName });

    // ── Caller gate (#1136) ───────────────────────────────────────────────
    // This same computation already existed, but only to decide whether to
    // write an audit row — the branded invitation was sent either way, to any
    // address. That is the shape of #926: authenticating for the audit trail is
    // not a gate. Unauthenticated, it made the platform's own domain and Resend
    // quota available for phishing.
    //
    // `is_institution_admin` ORs in `is_super_admin` and excludes suspended
    // members (#1082), so it is the whole rule and the separate super-admin
    // round-trip that used to sit above it is gone.
    if (!institutionId) {
      return json({ error: "institutionId is required" }, 400);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !supabaseServiceKey) {
      logger.error("Supabase credentials are not configured");
      return json({ error: "Server is not configured" }, 500);
    }

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return json({ error: "Unauthorized" }, 401);
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const token = authHeader.replace("Bearer ", "");
    const { data: { user: callerUser }, error: authError } = await supabaseAdmin.auth
      .getUser(token);
    if (authError || !callerUser) {
      return json({ error: "Unauthorized" }, 401);
    }

    // Service-role client, so RLS's aal2 enforcement never runs here — refuse
    // an MFA-enrolled caller whose token is still aal1.
    if (!callerMfaSatisfied(callerUser, token)) {
      return json({ error: AAL2_REQUIRED_MESSAGE, code: AAL2_REQUIRED_CODE }, 403);
    }

    const { data: isInstAdmin, error: authorizationError } = await supabaseAdmin.rpc(
      "is_institution_admin",
      { _user_id: callerUser.id, _institution_id: institutionId },
    );

    // A failed check is not a denied one. Discarding the error would report a
    // database or network fault as "not authorized" — a misleading 403 to the
    // caller, and a log line accusing a real admin of not being one.
    if (authorizationError) {
      logger.error("Failed to check institution admin status", {
        callerId: callerUser.id,
        institutionId,
        error: authorizationError.message,
      });
      return json({ error: "Failed to check authorization" }, 500);
    }

    if (!isInstAdmin) {
      logger.warn("Refused an invitation from a non-admin of the institution", {
        callerId: callerUser.id,
        institutionId,
      });
      return json({ error: "Not authorized for this institution" }, 403);
    }

    // Past the gate, so the audit row is no longer forgeable by construction.
    const actorUserId: string | null = callerUser.id;
    const actorEmail: string | null = callerUser.email ?? null;
    const actorAuthorized = true;

    const brand = edgeBrand();
    if (!brand.from) {
      // Unlike the best-effort security notices, an invitation that is not
      // delivered is the whole operation failing — so this is an error the
      // caller sees, not a warning in a log.
      logger.error("BRAND_FROM_EMAIL is not configured; cannot send invitations");
      return json(
        { error: "Email sending is not configured for this deployment" },
        500,
      );
    }

    // `Origin` is preferred so an invitation opens on the host the admin is
    // actually using (a deployment may serve several), and BRAND_APP_URL is
    // the fallback for a direct call with no Origin. Unlike the security
    // notices, this link is not a credential path and the recipient is the
    // person the caller chose to invite either way.
    const baseUrl = req.headers.get("origin") || brand.appUrl;
    if (!baseUrl) {
      logger.error("No Origin header and BRAND_APP_URL is not configured");
      return json(
        { error: "Application URL is not configured for this deployment" },
        500,
      );
    }
    const inviteLink = `${baseUrl}/auth?invitation=${institutionId}&email=${encodeURIComponent(email)}`;

    const emailHtml = generateEmailHtml(
      invitedName,
      inviterName,
      institutionName,
      inviteLink,
      brand.name,
      brand.tagline,
      emailFooterText(brand),
    );

    const resend = new Resend(Deno.env.get("RESEND_API_KEY"));
    const endEmailTimer = logger.startTimer("send-invitation-email");
    const emailResponse = await resend.emails.send({
      from: brand.from,
      to: [email],
      subject: `${inviterName} invited you to join ${institutionName} on ${brand.name}`,
      html: emailHtml,
    });
    endEmailTimer();

    if (emailResponse.error) {
      // Resend reports API-level failures (unverified domain, invalid
      // recipient, rate limit, …) in the result object WITHOUT throwing. Treat
      // that as a failed send: return an error and fall through WITHOUT
      // recording a `user.invite` audit row, so the durable trail never claims
      // an invitation was sent when it was not.
      logger.error("Resend returned an error sending the invitation", {
        error: emailResponse.error,
      });
      return new Response(
        JSON.stringify({
          success: false,
          error: emailResponse.error.message ?? "Failed to send invitation email",
        }),
        {
          status: 502,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        },
      );
    }

    logger.info("Invitation email sent", { emailId: emailResponse.data?.id });

    // Durable audit trail — ONLY for an authenticated, authorized admin, so an
    // unauthenticated/unauthorized caller cannot forge a durable record that
    // falsely claims an authorized invitation. The invitee email is the entity
    // acted upon; it is recorded here (an invitation, not an erasure).
    if (actorAuthorized) {
      await recordAudit({
        action: "user.invite",
        actorUserId,
        actorEmail,
        targetEntityType: "invitation",
        targetEntityId: email,
        institutionId: institutionId ?? null,
        metadata: {
          invited_email: email,
        },
      });
    }

    return new Response(JSON.stringify({ success: true, data: emailResponse }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  } catch (error: any) {
    logger.exception(error, "Error in send-invitation");
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
};
