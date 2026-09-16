import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { Loader2, ShieldCheck, ShieldOff, Copy } from "lucide-react";
import { toast } from "sonner";

interface VerifiedFactor {
  id: string;
  friendlyName?: string;
  createdAt: string;
}

interface PendingEnrollment {
  factorId: string;
  qrCode: string;
  secret: string;
}

type MfaSettingsDialogProps =
  /** Controlled mode: the built-in trigger button is not rendered. `onOpenChange`
   * is required alongside `open` — without it no close request (Escape, overlay,
   * load failure) could ever update the controlled value. */
  | { open: boolean; onOpenChange: (open: boolean) => void }
  /** Uncontrolled mode: renders its own trigger button and manages open state. */
  | { open?: undefined; onOpenChange?: undefined };

export function MfaSettingsDialog({
  open: controlledOpen,
  onOpenChange,
}: MfaSettingsDialogProps = {}) {
  const isControlled = controlledOpen !== undefined;
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = isControlled ? controlledOpen : uncontrolledOpen;
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [verifiedFactor, setVerifiedFactor] = useState<VerifiedFactor | null>(null);
  const [enrollment, setEnrollment] = useState<PendingEnrollment | null>(null);
  const [code, setCode] = useState("");

  const loadFactors = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase.auth.mfa.listFactors();
      if (error) throw error;
      const factor = data.totp.find((f) => f.status === "verified");
      setVerifiedFactor(
        factor
          ? { id: factor.id, friendlyName: factor.friendly_name, createdAt: factor.created_at }
          : null
      );
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Failed to load two-factor settings");
      handleOpenChange(false);
    } finally {
      setLoading(false);
    }
  };

  // Factors load on open via this effect (not in handleOpenChange) so that a
  // parent flipping the controlled `open` prop — which does not go through
  // Radix's onOpenChange — still triggers the load.
  useEffect(() => {
    if (open) {
      void loadFactors();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleOpenChange = (next: boolean) => {
    if (isControlled) {
      onOpenChange?.(next);
    } else {
      setUncontrolledOpen(next);
    }
    if (!next) {
      // An enrollment abandoned mid-way leaves an unverified factor behind;
      // discard it so the next attempt starts clean (and a duplicate friendly
      // name doesn't make that attempt fail).
      if (enrollment) {
        void supabase.auth.mfa.unenroll({ factorId: enrollment.factorId });
      }
      setEnrollment(null);
      setCode("");
      setVerifiedFactor(null);
    }
  };

  const startEnrollment = async () => {
    setSubmitting(true);
    try {
      // Clear unverified leftovers from previously abandoned attempts.
      const { data: existing } = await supabase.auth.mfa.listFactors();
      for (const factor of existing?.all ?? []) {
        if (factor.status === "unverified") {
          await supabase.auth.mfa.unenroll({ factorId: factor.id });
        }
      }

      const { data, error } = await supabase.auth.mfa.enroll({
        factorType: "totp",
        friendlyName: "Authenticator app",
      });
      if (error) throw error;

      setEnrollment({
        factorId: data.id,
        qrCode: data.totp.qr_code,
        secret: data.totp.secret,
      });
      setCode("");
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Failed to start enrollment");
    } finally {
      setSubmitting(false);
    }
  };

  const handleVerifyEnrollment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!enrollment || code.length !== 6) return;
    setSubmitting(true);
    try {
      const { error } = await supabase.auth.mfa.challengeAndVerify({
        factorId: enrollment.factorId,
        code,
      });
      if (error) {
        toast.error("Invalid or expired code. Please try again.");
        setCode("");
        return;
      }
      toast.success("Two-factor authentication enabled");
      setEnrollment(null);
      setCode("");
      await loadFactors();
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancelEnrollment = async () => {
    if (enrollment) {
      await supabase.auth.mfa.unenroll({ factorId: enrollment.factorId });
    }
    setEnrollment(null);
    setCode("");
  };

  const handleRemoveFactor = async () => {
    if (!verifiedFactor) return;
    setSubmitting(true);
    try {
      const { error } = await supabase.auth.mfa.unenroll({ factorId: verifiedFactor.id });
      if (error) throw error;
      toast.success("Two-factor authentication disabled");
      await loadFactors();
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Failed to remove authenticator");
    } finally {
      setSubmitting(false);
    }
  };

  const copySecret = async () => {
    if (!enrollment) return;
    try {
      await navigator.clipboard.writeText(enrollment.secret);
      toast.success("Secret copied to clipboard");
    } catch {
      toast.error("Could not copy to clipboard");
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {!isControlled && (
        <DialogTrigger asChild>
          <Button variant="ghost" size="sm">
            <ShieldCheck className="w-4 h-4 sm:mr-2" />
            <span className="hidden sm:inline">Two-Factor Auth</span>
          </Button>
        </DialogTrigger>
      )}
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Two-Factor Authentication</DialogTitle>
          <DialogDescription>
            {enrollment
              ? "Scan the QR code with your authenticator app, then enter the 6-digit code to activate"
              : "Protect your account with a code from an authenticator app at sign-in"}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : enrollment ? (
          <form onSubmit={handleVerifyEnrollment} className="space-y-4">
            <div className="flex justify-center">
              <img
                src={enrollment.qrCode}
                alt="QR code for authenticator app enrollment"
                className="w-44 h-44 rounded-md border bg-white p-2"
              />
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">
                Can't scan? Enter this key manually:
              </p>
              <div className="flex items-center gap-2">
                <code className="text-xs bg-muted rounded px-2 py-1 break-all flex-1" data-testid="mfa-secret">
                  {enrollment.secret}
                </code>
                <Button type="button" variant="ghost" size="icon" onClick={copySecret} aria-label="Copy secret">
                  <Copy className="w-4 h-4" />
                </Button>
              </div>
            </div>
            <div className="flex justify-center">
              <InputOTP maxLength={6} value={code} onChange={setCode} data-testid="mfa-enroll-code-input">
                <InputOTPGroup>
                  <InputOTPSlot index={0} />
                  <InputOTPSlot index={1} />
                  <InputOTPSlot index={2} />
                  <InputOTPSlot index={3} />
                  <InputOTPSlot index={4} />
                  <InputOTPSlot index={5} />
                </InputOTPGroup>
              </InputOTP>
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                className="flex-1"
                onClick={handleCancelEnrollment}
                disabled={submitting}
              >
                Cancel
              </Button>
              <Button type="submit" className="flex-1" disabled={submitting || code.length !== 6}>
                {submitting ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin mr-2" />
                    Verifying...
                  </>
                ) : (
                  "Activate"
                )}
              </Button>
            </div>
          </form>
        ) : verifiedFactor ? (
          <div className="space-y-4">
            <div className="flex items-center gap-3 rounded-lg border p-4">
              <ShieldCheck className="w-5 h-5 text-primary shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">{verifiedFactor.friendlyName || "Authenticator app"}</p>
                <p className="text-xs text-muted-foreground">
                  Enabled {new Date(verifiedFactor.createdAt).toLocaleDateString()}
                </p>
              </div>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="outline" size="sm" disabled={submitting}>
                    <ShieldOff className="w-4 h-4 mr-2" />
                    Remove
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Disable two-factor authentication?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Your account will no longer require a code from your authenticator app at
                      sign-in. You can re-enable it at any time.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Keep enabled</AlertDialogCancel>
                    <AlertDialogAction onClick={handleRemoveFactor}>Disable</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
            <p className="text-xs text-muted-foreground">
              You'll be asked for a code from your authenticator app every time you sign in.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Add an extra layer of security: after entering your password, you'll also enter a
              one-time code from an authenticator app such as Google Authenticator or 1Password.
            </p>
            <Button className="w-full" onClick={startEnrollment} disabled={submitting}>
              {submitting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  Preparing...
                </>
              ) : (
                <>
                  <ShieldCheck className="w-4 h-4 mr-2" />
                  Set up authenticator app
                </>
              )}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
