import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldAlert, ShieldCheck, X } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { MfaSettingsDialog } from "@/components/MfaSettingsDialog";

interface EnrollmentStatus {
  required: boolean;
  recommended: boolean;
  deadline: string | null;
}

const BANNER_DISMISSED_KEY = "mfa-recommendation-dismissed";

/**
 * Global MFA mandate surface (mounted once in App.tsx, like NewVersionBanner):
 *
 * - `required` (super-admins now; institution admins once the
 *   security_policies deadline passes): a full-screen, non-dismissible
 *   overlay. The server already refuses these sessions admin authority
 *   (is_super_admin / is_institution_admin demand aal2 outright), so this
 *   screen is the path back to a working account, not the enforcement.
 * - `recommended` (institution admins before the deadline): a dismissible
 *   corner banner naming the date.
 *
 * Who decides is the `mfa_enrollment_status` RPC — the client never infers
 * roles itself. Completing enrollment elevates the session to aal2, so a
 * refetch after the dialog closes is what clears the gate; role-derived
 * caches (is-super-admin) are invalidated then too, since they may hold a
 * pre-enrollment "false".
 */
export function MfaEnrollmentGate() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(
    () => sessionStorage.getItem(BANNER_DISMISSED_KEY) === "1",
  );

  const { data: status, refetch } = useQuery({
    queryKey: ["mfa-enrollment-status", user?.id],
    enabled: !!user,
    staleTime: 60_000,
    queryFn: async (): Promise<EnrollmentStatus> => {
      const { data, error } = await supabase.rpc("mfa_enrollment_status");
      if (error) throw error;
      return data as unknown as EnrollmentStatus;
    },
  });

  if (!user || !status) return null;

  const handleDialogChange = (open: boolean) => {
    setDialogOpen(open);
    if (!open) {
      // Enrollment (if completed) elevated the session to aal2; re-ask the
      // server, and drop role caches that answered "false" pre-enrollment.
      void refetch();
      void queryClient.invalidateQueries({ queryKey: ["is-super-admin"] });
    }
  };

  // The deadline is a UTC instant; format its UTC date so viewers west of
  // UTC don't see the previous day.
  const deadlineLabel = status.deadline
    ? new Date(status.deadline).toLocaleDateString(undefined, {
        year: "numeric",
        month: "long",
        day: "numeric",
        timeZone: "UTC",
      })
    : null;

  if (status.required) {
    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-background/95 p-4"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="mfa-gate-title"
        data-testid="mfa-enrollment-gate"
      >
        <div className="w-full max-w-md space-y-4 rounded-lg border border-border bg-background p-6 shadow-lg">
          <div className="flex items-center gap-3">
            <ShieldAlert className="h-6 w-6 shrink-0 text-destructive" aria-hidden="true" />
            <h2 id="mfa-gate-title" className="text-lg font-semibold">
              Two-factor authentication required
            </h2>
          </div>
          <p className="text-sm text-muted-foreground">
            Your account's role requires two-factor authentication. Set up an
            authenticator app to continue — it takes about a minute.
          </p>
          <div className="flex flex-col gap-2">
            <Button onClick={() => setDialogOpen(true)} data-testid="mfa-gate-setup">
              <ShieldCheck className="mr-2 h-4 w-4" aria-hidden="true" />
              Set up authenticator app
            </Button>
            <Button variant="ghost" onClick={() => void supabase.auth.signOut()}>
              Sign out
            </Button>
          </div>
        </div>
        <MfaSettingsDialog open={dialogOpen} onOpenChange={handleDialogChange} />
      </div>
    );
  }

  if (status.recommended && !bannerDismissed) {
    return (
      <>
        <div
          role="status"
          className="fixed bottom-16 right-4 z-50 flex max-w-sm items-center gap-3 rounded-lg border border-border bg-background p-4 shadow-lg"
          data-testid="mfa-recommendation-banner"
        >
          <ShieldAlert className="h-5 w-5 shrink-0 text-amber-500" aria-hidden="true" />
          <div className="flex flex-col">
            <span className="text-sm font-semibold text-foreground">
              Two-factor authentication
            </span>
            <span className="text-xs text-muted-foreground">
              {deadlineLabel
                ? `Required for admin accounts from ${deadlineLabel}. Set it up now to stay ahead.`
                : "Will soon be required for admin accounts. Set it up now to stay ahead."}
            </span>
          </div>
          <Button size="sm" className="shrink-0" onClick={() => setDialogOpen(true)}>
            Set up
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0"
            aria-label="Dismiss"
            onClick={() => {
              sessionStorage.setItem(BANNER_DISMISSED_KEY, "1");
              setBannerDismissed(true);
            }}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
        <MfaSettingsDialog open={dialogOpen} onOpenChange={handleDialogChange} />
      </>
    );
  }

  return null;
}
