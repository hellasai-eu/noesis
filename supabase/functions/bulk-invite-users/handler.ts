import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Resend } from "https://esm.sh/resend@2.0.0";
import { logger } from "../_shared/logger.ts";
import { resolveOrCreateGradeLevel } from "../_shared/grade-levels.ts";
import { recordAudit } from "../_shared/audit.ts";
import {
  AAL2_REQUIRED_CODE,
  AAL2_REQUIRED_MESSAGE,
  callerMfaSatisfied,
} from "../_shared/require-aal2.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isNonEmptyGradeLevel(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

interface BulkRow {
  email: string;
  firstName?: string;
  lastName?: string;
  fullName?: string;
  fatherName?: string;
  dateOfBirth?: string;
  sectionName?: string;
  gradeLevels?: string[];
}

interface BulkRequest {
  institutionId: string;
  role: "student" | "instructor";
  gradeLevel?: string;
  sectionStrategy?: "same" | "per-row";
  sharedSectionName?: string;
  rows: BulkRow[];
  institutionName: string;
  inviterName: string;
}

interface RowResult {
  email: string;
  status: "invited" | "skipped" | "failed";
  reason?: string;
  invitationId?: string;
}

const generateEmailHtml = (
  invitedName: string | undefined,
  inviterName: string,
  institutionName: string,
  inviteLink: string,
) => {
  const safeName = invitedName ? escapeHtml(invitedName) : undefined;
  const safeInviter = escapeHtml(inviterName);
  const safeInstitution = escapeHtml(institutionName);
  return `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin: 0; padding: 0; background-color: #f8f9fa; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background-color: #f8f9fa; padding: 40px 20px;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width: 560px; background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 24px rgba(0,0,0,0.08);">
        <tr><td style="background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f0f23 100%); padding: 48px 40px; text-align: center;">
          <div style="width: 64px; height: 64px; background: linear-gradient(135deg, #d4af37 0%, #f4d03f 50%, #d4af37 100%); border-radius: 16px; margin: 0 auto 20px; display: flex; align-items: center; justify-content: center;">
            <span style="font-size: 32px; color: #1a1a2e; font-weight: bold;">ν</span>
          </div>
          <h1 style="color: #ffffff; margin: 0; font-size: 28px; font-weight: 700;">Noesis</h1>
          <p style="color: #a0a0b0; margin: 8px 0 0; font-size: 14px;">AI-Powered Learning Platform</p>
        </td></tr>
        <tr><td style="padding: 48px 40px;">
          <h2 style="color: #1a1a2e; margin: 0 0 8px; font-size: 24px; font-weight: 600;">
            ${safeName ? `Hello ${safeName}!` : "You're Invited!"}
          </h2>
          <p style="color: #6b7280; margin: 0 0 32px; font-size: 16px; line-height: 1.6;">
            You've been invited to join a learning community.
          </p>
          <div style="background: linear-gradient(135deg, #f8f9fa 0%, #f1f5f9 100%); border-radius: 12px; padding: 24px; margin-bottom: 32px; border-left: 4px solid #d4af37;">
            <p style="color: #6b7280; margin: 0 0 8px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600;">Invited by</p>
            <p style="color: #1a1a2e; margin: 0 0 16px; font-size: 18px; font-weight: 600;">${safeInviter}</p>
            <p style="color: #6b7280; margin: 0 0 8px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600;">Institution</p>
            <p style="color: #1a1a2e; margin: 0; font-size: 18px; font-weight: 600;">${safeInstitution}</p>
          </div>
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr><td align="center">
            <a href="${inviteLink}" style="display: inline-block; background: linear-gradient(135deg, #d4af37 0%, #c9a227 100%); color: #1a1a2e; text-decoration: none; padding: 16px 48px; border-radius: 10px; font-weight: 700; font-size: 16px;">
              Accept Invitation
            </a>
          </td></tr></table>
        </td></tr>
        <tr><td style="background: #f8f9fa; padding: 24px 40px; text-align: center; border-top: 1px solid #e5e7eb;">
          <p style="color: #9ca3af; margin: 0; font-size: 12px;">© ${new Date().getFullYear()} Noesis. Empowering education with AI.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
};

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function buildFullName(row: BulkRow): string | null {
  if (row.fullName && row.fullName.trim()) return row.fullName.trim();
  const parts = [row.firstName, row.lastName].filter((p) => p && p.trim()).map((p) => p!.trim());
  return parts.length > 0 ? parts.join(" ") : null;
}

export const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const payload = (await req.json()) as BulkRequest;
    const { institutionId, role, gradeLevel, sectionStrategy, sharedSectionName, rows, institutionName, inviterName } = payload;

    if (!institutionId) {
      return new Response(JSON.stringify({ error: "institutionId is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (role !== "student" && role !== "instructor") {
      return new Response(JSON.stringify({ error: "role must be 'student' or 'instructor'" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!Array.isArray(rows) || rows.length === 0) {
      return new Response(JSON.stringify({ error: "rows must be a non-empty array" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (rows.length > 500) {
      return new Response(JSON.stringify({ error: "Maximum 500 rows per batch" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (role === "student") {
      if (!isNonEmptyGradeLevel(gradeLevel)) {
        return new Response(JSON.stringify({ error: "Valid gradeLevel is required for student bulk import" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (sectionStrategy !== "same" && sectionStrategy !== "per-row") {
        return new Response(JSON.stringify({ error: "sectionStrategy must be 'same' or 'per-row' for students" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (sectionStrategy === "same" && (!sharedSectionName || !sharedSectionName.trim())) {
        return new Response(JSON.stringify({ error: "sharedSectionName is required when sectionStrategy is 'same'" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { autoRefreshToken: false, persistSession: false } },
    );

    // Authorize caller
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const token = authHeader.replace("Bearer ", "");
    const { data: { user: caller }, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !caller) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Service-role client, so RLS's aal2 enforcement never runs here — refuse
    // an MFA-enrolled caller whose token is still aal1.
    if (!callerMfaSatisfied(caller, token)) {
      return new Response(JSON.stringify({ error: AAL2_REQUIRED_MESSAGE, code: AAL2_REQUIRED_CODE }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: isSuperAdmin } = await supabaseAdmin.rpc("is_super_admin", { _user_id: caller.id });
    let authorized = !!isSuperAdmin;
    if (!authorized) {
      const { data: isAdmin } = await supabaseAdmin.rpc("is_institution_admin", {
        _user_id: caller.id,
        _institution_id: institutionId,
      });
      authorized = !!isAdmin;
    }
    if (!authorized) {
      logger.warn("Non-admin attempted bulk invite", { callerId: caller.id, institutionId });
      return new Response(JSON.stringify({ error: "Only institution admins or super admins can bulk-invite users" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    logger.info("Bulk invite started", {
      institutionId,
      role,
      rowCount: rows.length,
      sectionStrategy: sectionStrategy ?? "none",
    });

    // Resolve the shared grade_level_id once for the batch (student invites
    // only — instructor invites don't carry invited_grade_level). Dual-write
    // failure just leaves the FK null; the TEXT column stays canonical until
    // the read cutover (#798).
    let sharedGradeLevelId: string | null = null;
    if (role === "student" && gradeLevel) {
      try {
        sharedGradeLevelId = await resolveOrCreateGradeLevel(supabaseAdmin, {
          institutionId,
          code: gradeLevel,
        });
      } catch (e) {
        logger.warn("Failed to resolve grade_level_id for bulk invite", {
          error: e instanceof Error ? e.message : String(e),
          institutionId,
          gradeLevel,
        });
      }
    }

    // Load sections for student grade resolution — FK identity match on
    // grade_level_id (the TEXT column no longer exists after #799).
    const sectionIdsByName = new Map<string, string>();
    if (role === "student") {
      if (!sharedGradeLevelId) {
        logger.error("Failed to resolve grade_level_id for student bulk invite");
        return new Response(
          JSON.stringify({ error: "Could not resolve the selected grade level" }),
          {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }
      const { data: classRows, error: classError } = await supabaseAdmin
        .from("classes")
        .select("id, section_name")
        .eq("institution_id", institutionId)
        .eq("grade_level_id", sharedGradeLevelId);
      if (classError) {
        logger.error("Failed to load classes", { error: classError.message });
        return new Response(JSON.stringify({ error: "Failed to load classes for the chosen grade level" }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      for (const c of classRows ?? []) {
        if (c.section_name) sectionIdsByName.set(c.section_name, c.id);
      }
    }

    // Load existing institution members and pending invitations to detect duplicates
    const emailsInBatch = new Set<string>();
    const normalizedRows = rows.map((r) => ({ ...r, _normEmail: normalizeEmail(r.email ?? "") }));

    const { data: existingProfiles } = await supabaseAdmin
      .from("user_institutions")
      .select("user_id, profiles!inner(email)")
      .eq("institution_id", institutionId);
    const existingMemberEmails = new Set<string>();
    for (const row of (existingProfiles ?? []) as unknown as Array<{
      profiles: { email: string | null } | { email: string | null }[] | null;
    }>) {
      const profiles = Array.isArray(row.profiles) ? row.profiles : row.profiles ? [row.profiles] : [];
      for (const p of profiles) {
        if (p?.email) existingMemberEmails.add(p.email.toLowerCase());
      }
    }

    const { data: existingInvitations } = await supabaseAdmin
      .from("invitations")
      .select("email, status")
      .eq("institution_id", institutionId)
      .in("status", ["pending", "accepted"]);
    const existingInviteEmails = new Set<string>();
    for (const inv of existingInvitations ?? []) {
      if (inv.email) existingInviteEmails.add(inv.email.toLowerCase());
    }

    const resendKey = Deno.env.get("RESEND_API_KEY");
    const resend = resendKey ? new Resend(resendKey) : null;
    const baseUrl = req.headers.get("origin") || "https://dianoisis.net";

    const results: RowResult[] = [];

    for (const row of normalizedRows) {
      const email = row._normEmail;

      if (!email || !EMAIL_REGEX.test(email)) {
        results.push({ email: row.email ?? "", status: "failed", reason: "Invalid email format" });
        continue;
      }
      if (emailsInBatch.has(email)) {
        results.push({ email, status: "failed", reason: "Duplicate email within batch" });
        continue;
      }
      emailsInBatch.add(email);

      if (existingMemberEmails.has(email)) {
        results.push({ email, status: "skipped", reason: "Already a member of this institution" });
        continue;
      }
      if (existingInviteEmails.has(email)) {
        results.push({ email, status: "skipped", reason: "Existing invitation for this email" });
        continue;
      }

      let invitedClassId: string | null = null;

      if (role === "student") {
        const sectionName = sectionStrategy === "same" ? sharedSectionName! : (row.sectionName ?? "").trim();
        if (!sectionName) {
          results.push({ email, status: "failed", reason: "Missing section_name for per-row mode" });
          continue;
        }
        const classId = sectionIdsByName.get(sectionName);
        if (!classId) {
          results.push({
            email,
            status: "failed",
            reason: `Unknown section "${sectionName}" for the selected grade level`,
          });
          continue;
        }
        invitedClassId = classId;
      } else {
        if (row.gradeLevels && row.gradeLevels.length > 0) {
          const invalid = row.gradeLevels.filter((g) => !isNonEmptyGradeLevel(g));
          if (invalid.length > 0) {
            results.push({
              email,
              status: "failed",
              reason: `Empty grade_levels are not allowed`,
            });
            continue;
          }
        }
      }

      const invitedName = buildFullName(row);

      const { data: invitation, error: insertError } = await supabaseAdmin
        .from("invitations")
        .insert({
          email,
          invited_name: invitedName,
          institution_id: institutionId,
          invited_by: caller.id,
          role,
          invited_class_id: invitedClassId,
          invited_grade_level_id: role === "student" ? sharedGradeLevelId : null,
        })
        .select("id")
        .single();

      if (insertError || !invitation) {
        logger.error("Failed to insert invitation", { email, error: insertError?.message });
        results.push({
          email,
          status: "failed",
          reason: insertError?.message || "Failed to create invitation",
        });
        continue;
      }

      // Send email via Resend (best-effort — invitation is still created)
      if (resend) {
        try {
          const inviteLink = `${baseUrl}/auth?invitation=${invitation.id}&email=${encodeURIComponent(email)}`;
          const html = generateEmailHtml(invitedName ?? undefined, inviterName, institutionName, inviteLink);
          await resend.emails.send({
            from: "Noesis <me@dianoisis.net>",
            to: [email],
            subject: `${inviterName} invited you to join ${institutionName} on Noesis`,
            html,
          });
        } catch (emailErr) {
          logger.warn("Failed to send bulk invite email", {
            email,
            error: emailErr instanceof Error ? emailErr.message : String(emailErr),
          });
          // Invitation row exists, so the admin can resend later; mark as invited.
        }
      }

      results.push({ email, status: "invited", invitationId: invitation.id });
    }

    const summary = {
      invited: results.filter((r) => r.status === "invited").length,
      skipped: results.filter((r) => r.status === "skipped").length,
      failed: results.filter((r) => r.status === "failed").length,
    };

    logger.info("Bulk invite complete", { institutionId, role, ...summary });

    // Durable audit trail — one summary row for the batch. Metadata is
    // aggregate counts only; individual invitee emails are not recorded here.
    await recordAudit({
      action: "user.bulk_invite",
      actorUserId: caller.id,
      actorEmail: caller.email ?? null,
      targetEntityType: "institution",
      targetEntityId: institutionId,
      institutionId,
      metadata: {
        role,
        row_count: rows.length,
        invited: summary.invited,
        skipped: summary.skipped,
        failed: summary.failed,
      },
    });

    return new Response(JSON.stringify({ success: true, results, summary }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    logger.exception(error as Error, "Error in bulk-invite-users");
    const message = error instanceof Error ? error.message : "Unexpected error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
};
