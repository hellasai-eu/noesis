/**
 * Security notification for an admin removing a user's two-factor
 * authentication (`admin-reset-user-mfa`).
 *
 * Sibling of `password-change-notice.ts`, and the same reasoning applies:
 * removing the second factor weakens the account, and from the holder's side
 * it is indistinguishable from the first step of a takeover, so they must be
 * told out-of-band. Delivery is BEST-EFFORT and never throws into the caller —
 * by the time this runs the factors are already gone, and the caller records
 * the outcome in the audit row's metadata instead.
 */

import { Resend } from "https://esm.sh/resend@2.0.0";
import { logger } from "./logger.ts";

export interface MfaResetNotice {
  /** Recipient — the account whose MFA was removed, never the actor. */
  email: string;
  /** For the greeting. Omitted when unknown; the copy degrades gracefully. */
  fullName?: string | null;
}

const FROM = "Noesis <me@dianoisis.net>";

/**
 * Hard-coded, NOT derived from the request's `Origin` — same reasoning as
 * `password-change-notice.ts` (#1232): this is a security email whose
 * recipient is not the caller, so no request metadata may choose its link.
 */
const SIGN_IN_LINK = "https://dianoisis.net/auth";

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const generateEmailHtml = (greetingName: string | null, signInLink: string) => `
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
                <span style="font-size: 32px; color: #1a1a2e; font-weight: bold; line-height: 64px;">&nu;</span>
              </div>
              <h1 style="color: #ffffff; margin: 0; font-size: 28px; font-weight: 700; letter-spacing: -0.5px;">Noesis</h1>
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
                Two-factor authentication was removed from your account. An administrator at your
                institution removed the authenticator-app requirement from your Noesis account.
                You can now sign in with just your password, and you were signed out of any active
                sessions. You can re-enable two-factor authentication from your account settings
                at any time.
              </p>

              <div style="background: #fff7ed; border-radius: 12px; padding: 20px; margin-bottom: 28px; border-left: 4px solid #d4af37;">
                <p style="color: #7c2d12; margin: 0; font-size: 14px; line-height: 1.6;">
                  If you were not expecting this, contact your institution administrator immediately.
                </p>
              </div>

              <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
                <tr>
                  <td align="center">
                    <a href="${escapeHtml(signInLink)}" style="display: inline-block; background: linear-gradient(135deg, #d4af37 0%, #c9a227 100%); color: #1a1a2e; text-decoration: none; padding: 14px 40px; border-radius: 10px; font-weight: 700; font-size: 16px;">
                      Go to Noesis &rarr;
                    </a>
                  </td>
                </tr>
              </table>

              <p style="color: #9ca3af; margin: 28px 0 0; font-size: 13px; text-align: center; line-height: 1.6;">
                For your security this message contains no account details.
                Noesis will never ask you for your password by email.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background: #f8f9fa; padding: 24px 40px; text-align: center; border-top: 1px solid #e5e7eb;">
              <p style="color: #9ca3af; margin: 0; font-size: 12px;">
                &copy; ${new Date().getFullYear()} Noesis. Empowering education with AI.
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

/**
 * Send the notice. Resolves `true` only when Resend accepted the message.
 * Resend reports API-level failures in the result object without throwing, so
 * the `error` field is checked as well as the throw path.
 */
export async function sendMfaResetNotice(notice: MfaResetNotice): Promise<boolean> {
  try {
    const apiKey = Deno.env.get("RESEND_API_KEY");
    if (!apiKey) {
      logger.warn("RESEND_API_KEY not configured, skipping MFA reset notice");
      return false;
    }

    if (!notice.email) {
      logger.warn("No recipient address for MFA reset notice");
      return false;
    }

    const resend = new Resend(apiKey);
    const endTimer = logger.startTimer("mfa-reset-notice-email");
    const response = await resend.emails.send({
      from: FROM,
      to: [notice.email],
      subject: "Two-factor authentication was removed from your Noesis account",
      html: generateEmailHtml(notice.fullName ?? null, SIGN_IN_LINK),
    });
    endTimer();

    if (response.error) {
      logger.error("Resend returned an error sending the MFA reset notice", {
        error: response.error.message ?? String(response.error),
      });
      return false;
    }

    logger.info("MFA reset notice sent", { emailId: response.data?.id });
    return true;
  } catch (error) {
    // Never fail an already-completed MFA reset because the notice failed.
    logger.error("Error sending MFA reset notice", {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
