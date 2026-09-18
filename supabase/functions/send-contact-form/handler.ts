import { Resend } from "https://esm.sh/resend@2.0.0";
import { edgeBrand } from "../_shared/brand.ts";
import { logger } from "../_shared/logger.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface ContactFormRequest { name: string; email: string; subject: string; message: string; }

// Escape HTML to prevent markup/script injection into outgoing emails
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

// Simple in-memory rate limiting
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_REQUESTS_PER_WINDOW = 5; // Max 5 submissions per hour per IP/email

function isRateLimited(key: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(key);

  if (!entry || now > entry.resetTime) {
    rateLimitMap.set(key, { count: 1, resetTime: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }

  if (entry.count >= MAX_REQUESTS_PER_WINDOW) {
    return true;
  }

  entry.count++;
  return false;
}

// Clean up old entries periodically
function cleanupRateLimitMap() {
  const now = Date.now();
  for (const [key, entry] of rateLimitMap.entries()) {
    if (now > entry.resetTime) {
      rateLimitMap.delete(key);
    }
  }
}

/** Exported for testing — allows resetting rate limit state between tests */
export function resetRateLimits(): void {
  rateLimitMap.clear();
}

export const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    // Clean up old rate limit entries
    cleanupRateLimitMap();

    const { name, email, subject, message }: ContactFormRequest = await req.json();

    // Validate required fields
    if (!name || !email || !subject || !message) {
      return new Response(
        JSON.stringify({ error: "All fields are required" }),
        { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return new Response(
        JSON.stringify({ error: "Invalid email format" }),
        { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Get client IP for rate limiting
    const clientIP = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
                     req.headers.get("x-real-ip") ||
                     "unknown";

    // Rate limit by both IP and email to prevent abuse
    const ipKey = `ip:${clientIP}`;
    const emailKey = `email:${email.toLowerCase()}`;

    if (isRateLimited(ipKey)) {
      logger.warn("Rate limited by IP", { clientIP });
      return new Response(
        JSON.stringify({ error: "Too many requests. Please try again later." }),
        { status: 429, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    if (isRateLimited(emailKey)) {
      logger.warn("Rate limited by email", { email });
      return new Response(
        JSON.stringify({ error: "Too many requests from this email. Please try again later." }),
        { status: 429, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    logger.info("Contact form submission", { email, subject, clientIP });

    const safeName = escapeHtml(name);
    const safeEmail = escapeHtml(email);
    const safeSubject = escapeHtml(subject);
    const safeMessage = escapeHtml(message);
    // Strip CR/LF to prevent SMTP header injection in the Subject line
    const headerSafeSubject = subject.replace(/[\r\n]+/g, " ");

    const brand = edgeBrand();
    if (!brand.from || !brand.contactRecipient) {
      // Nothing to send as, or nowhere to send it. Accepting the message and
      // silently dropping it would be worse than saying so: the sender is
      // waiting for a reply that would never come.
      logger.error("Contact form is not configured", {
        hasFrom: Boolean(brand.from),
        hasRecipient: Boolean(brand.contactRecipient),
      });
      return new Response(
        JSON.stringify({ error: "Contact form is not configured for this deployment" }),
        { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    const resend = new Resend(Deno.env.get("RESEND_API_KEY"));

    const endAdminTimer = logger.startTimer("send-admin-email");
    await resend.emails.send({
      from: brand.from,
      to: [brand.contactRecipient],
      subject: `[${brand.name} Contact] ${headerSafeSubject}`,
      html: `<h2>New Contact Form Submission</h2><p><strong>From:</strong> ${safeName} (${safeEmail})</p><p><strong>Subject:</strong> ${safeSubject}</p><p><strong>IP:</strong> ${escapeHtml(clientIP)}</p><hr /><h3>Message:</h3><p style="white-space: pre-wrap;">${safeMessage}</p>`
    });
    endAdminTimer();

    const endUserTimer = logger.startTimer("send-user-email");
    await resend.emails.send({
      from: brand.from,
      to: [email],
      subject: `We received your message - ${brand.name}`,
      html: `<h2>Thank you for contacting us, ${safeName}!</h2><p>We have received your message and will get back to you as soon as possible.</p><hr /><p><strong>Your message:</strong></p><p style="white-space: pre-wrap; background: #f5f5f5; padding: 16px; border-radius: 8px;">${safeMessage}</p>`
    });
    endUserTimer();

    logger.info("Emails sent successfully");
    return new Response(JSON.stringify({ success: true }), { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } });
  } catch (error: any) {
    logger.exception(error, "Error in send-contact-form");
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } });
  }
};
