/**
 * Security notification for password changes.
 *
 * A password change is the single event that hands over an account, so the
 * account holder must be told out-of-band — the notice is what turns a silent
 * takeover into a detectable one. Both change paths use this: an admin reset
 * (`admin-set-user-password`) and a self-service change
 * (`notify-password-changed`).
 *
 * Delivery is BEST-EFFORT and never throws into the caller. By the time this
 * runs the password has already been changed; failing the request would report
 * a change that did in fact happen as an error, and would invite the caller to
 * retry a write that is already done. Callers record the outcome in the audit
 * row's metadata instead, so a missing notice is visible in the trail.
 */

import { Resend } from "https://esm.sh/resend@2.0.0";
import { logger } from "./logger.ts";
import { edgeBrand, emailFooterText, monogram } from "./brand.ts";

/** Which path changed the password — drives the copy the user reads. */
export type PasswordChangeKind = "self_service" | "admin_reset";

export interface PasswordChangeNotice {
  /** Recipient — the account whose password changed, never the actor. */
  email: string;
  /** For the greeting. Omitted when unknown; the copy degrades gracefully. */
  fullName?: string | null;
  kind: PasswordChangeKind;
}

/**
 * The sender and the sign-in link come from `BRAND_*` environment variables
 * (`_shared/brand.ts`), and emphatically NOT from the request's `Origin`
 * (#1232 review).
 *
 * `Origin` is a request header: the browser sets it honestly, but a direct
 * HTTP call sets it to anything. This is a security email — the one message a
 * user is most primed to click — and its recipient is the account holder, who
 * for an admin reset is NOT the caller. Building the button from request
 * metadata would let an institution admin mail a genuine, correctly-branded
 * security notice to any of their members with the link pointing at a site of
 * their choosing.
 *
 * An operator-set environment variable is not request metadata: only whoever
 * deploys the project can set it, which is the same trust level as the code.
 * So `BRAND_APP_URL` is safe here where `Origin` is not — and when it is
 * unset the button is dropped rather than pointed anywhere.
 */

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const generateEmailHtml = (
  greetingName: string | null,
  kind: PasswordChangeKind,
  signInLink: string | null,
  brandName: string,
  footer: string,
) => {
  const headline = kind === "admin_reset"
    ? "Your password was reset by an administrator"
    : "Your password was changed";

  const lead = kind === "admin_reset"
    ? `An administrator at your institution set a new password for your ${brandName} account. Use the new password the next time you sign in.`
    : `The password for your ${brandName} account was just changed.`;

  const warning = kind === "admin_reset"
    ? "If you were not expecting this, contact your institution administrator immediately."
    : "If you did not make this change, your account may be compromised. Reset your password immediately and contact your institution administrator.";

  const button = signInLink
    ? `<table role="presentation" cellpadding="0" cellspacing="0" width="100%">
                <tr>
                  <td align="center">
                    <a href="${escapeHtml(signInLink)}" style="display: inline-block; background: linear-gradient(135deg, #d4af37 0%, #c9a227 100%); color: #1a1a2e; text-decoration: none; padding: 14px 40px; border-radius: 10px; font-weight: 700; font-size: 16px;">
                      Go to ${escapeHtml(brandName)} &rarr;
                    </a>
                  </td>
                </tr>
              </table>`
    : "";

  return `
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
            <td style="background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f0f23 100%); padding: 40px; text-align: center;">
              <div style="width: 64px; height: 64px; background: linear-gradient(135deg, #d4af37 0%, #f4d03f 50%, #d4af37 100%); border-radius: 16px; margin: 0 auto 20px;">
                <span style="font-size: 32px; color: #1a1a2e; font-weight: bold; line-height: 64px;">${escapeHtml(monogram(brandName))}</span>
              </div>
              <h1 style="color: #ffffff; margin: 0; font-size: 28px; font-weight: 700; letter-spacing: -0.5px;">${escapeHtml(brandName)}</h1>
              <p style="color: #a0a0b0; margin: 8px 0 0; font-size: 14px;">Security notification</p>
            </td>
          </tr>

          <!-- Content -->
          <tr>
            <td style="padding: 40px;">
              <h2 style="color: #1a1a2e; margin: 0 0 8px; font-size: 22px; font-weight: 600;">
                ${greetingName ? `Hello ${escapeHtml(greetingName)},` : "Hello,"}
              </h2>
              <p style="color: #4b5563; margin: 0 0 24px; font-size: 16px; line-height: 1.6;">
                ${headline}. ${lead}
              </p>

              <div style="background: #fff7ed; border-radius: 12px; padding: 20px; margin-bottom: 28px; border-left: 4px solid #d4af37;">
                <p style="color: #7c2d12; margin: 0; font-size: 14px; line-height: 1.6;">
                  ${warning}
                </p>
              </div>

              ${button}

              <p style="color: #9ca3af; margin: 28px 0 0; font-size: 13px; text-align: center; line-height: 1.6;">
                For your security this message contains no password details.
                ${escapeHtml(brandName)} will never ask you for your password by email.
              </p>
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
};

/**
 * Send the notice. Resolves `true` only when Resend accepted the message.
 *
 * Resend reports API-level failures (unverified domain, invalid recipient,
 * rate limit, …) in the result object WITHOUT throwing — see `send-invitation`
 * — so the `error` field is checked as well as the throw path.
 */
export async function sendPasswordChangeNotice(
  notice: PasswordChangeNotice,
): Promise<boolean> {
  try {
    const apiKey = Deno.env.get("RESEND_API_KEY");
    if (!apiKey) {
      logger.warn("RESEND_API_KEY not configured, skipping password change notice");
      return false;
    }

    const brand = edgeBrand();
    if (!brand.from) {
      // No verified sending address configured. Sending as another
      // deployment's domain is worse than not sending, and this notice is
      // best-effort by design — the caller records the outcome either way.
      logger.warn("BRAND_FROM_EMAIL not configured, skipping password change notice");
      return false;
    }

    if (!notice.email) {
      logger.warn("No recipient address for password change notice", { kind: notice.kind });
      return false;
    }

    const subject = notice.kind === "admin_reset"
      ? `Your ${brand.name} password was reset by an administrator`
      : `Your ${brand.name} password was changed`;

    const resend = new Resend(apiKey);
    const endTimer = logger.startTimer("password-change-notice-email");
    const response = await resend.emails.send({
      from: brand.from,
      to: [notice.email],
      subject,
      html: generateEmailHtml(
        notice.fullName ?? null,
        notice.kind,
        brand.signInUrl,
        brand.name,
        emailFooterText(brand),
      ),
    });
    endTimer();

    if (response.error) {
      logger.error("Resend returned an error sending the password change notice", {
        kind: notice.kind,
        error: response.error.message ?? String(response.error),
      });
      return false;
    }

    logger.info("Password change notice sent", { kind: notice.kind, emailId: response.data?.id });
    return true;
  } catch (error) {
    // Never fail an already-completed password change because the notice failed.
    logger.error("Error sending password change notice", {
      kind: notice.kind,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
