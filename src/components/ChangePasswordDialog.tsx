import { useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { verifyCurrentPassword } from "@/lib/verify-password";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Key, Loader2, Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";
import PasswordStrengthIndicator from "./PasswordStrengthIndicator";
import { MIN_PASSWORD_LENGTH, validateNewPassword } from "@/lib/password-policy";

type ChangePasswordDialogProps =
  /** Controlled mode: the built-in trigger button is not rendered. `onOpenChange`
   * is required alongside `open` — without it no close request (Escape, overlay,
   * successful submit) could ever update the controlled value. */
  | { open: boolean; onOpenChange: (open: boolean) => void }
  /** Uncontrolled mode: renders its own trigger button and manages open state. */
  | { open?: undefined; onOpenChange?: undefined };

export function ChangePasswordDialog({
  open: controlledOpen,
  onOpenChange,
}: ChangePasswordDialogProps = {}) {
  const { user, updatePassword } = useAuth();
  const isControlled = controlledOpen !== undefined;
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = isControlled ? controlledOpen : uncontrolledOpen;
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);

  const resetFields = () => {
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
  };

  const handleOpenChange = (next: boolean) => {
    if (isControlled) {
      onOpenChange?.(next);
    } else {
      setUncontrolledOpen(next);
    }
    if (!next) {
      resetFields();
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Shared mirror of the server-enforced Supabase Auth policy — the form
    // refuses what the server would refuse anyway.
    const policyError = validateNewPassword(newPassword);
    if (policyError) {
      toast.error(policyError);
      return;
    }

    if (newPassword !== confirmPassword) {
      toast.error("Passwords do not match");
      return;
    }

    if (!user?.email) {
      toast.error("Unable to verify current password");
      return;
    }

    setLoading(true);
    try {
      try {
        // Through a throwaway client: signing in on the shared client would
        // replace the session, and for an MFA-enrolled user the replacement
        // is aal1 — the app would bounce to the /auth challenge mid-dialog.
        const { error: verifyError } = await verifyCurrentPassword(
          user.email,
          currentPassword,
        );
        if (verifyError) {
          toast.error("Current password is incorrect");
          return;
        }
      } catch {
        toast.error("Failed to verify current password");
        return;
      }

      const { error } = await updatePassword(newPassword);

      if (error) throw error;

      // The password change went straight from here to GoTrue, so nothing
      // server-side of ours saw it. Tell the backend so it can email the
      // account holder and write the audit row. Best-effort on purpose: the
      // password IS changed by now, and reporting failure here would tell the
      // user otherwise and invite them to redo a change that already happened.
      try {
        const { error: notifyError } = await supabase.functions.invoke("notify-password-changed");
        if (notifyError) {
          console.error("Failed to record the password change", notifyError);
        }
      } catch (notifyError) {
        console.error("Failed to record the password change", notifyError);
      }

      toast.success("Password updated successfully");
      handleOpenChange(false);
    } catch (error: any) {
      toast.error(error.message || "Failed to update password");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {!isControlled && (
        <DialogTrigger asChild>
          <Button variant="ghost" size="sm">
            <Key className="w-4 h-4 sm:mr-2" />
            <span className="hidden sm:inline">Change Password</span>
          </Button>
        </DialogTrigger>
      )}
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Change Password</DialogTitle>
          <DialogDescription>
            Enter your current password and choose a new one
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="current-password">Current Password</Label>
            <div className="relative">
              <Input
                id="current-password"
                type={showPassword ? "text" : "password"}
                placeholder="Enter current password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                required
                autoComplete="current-password"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute right-0 top-0 h-full px-3 hover:bg-transparent"
                onClick={() => setShowPassword(!showPassword)}
              >
                {showPassword ? (
                  <EyeOff className="w-4 h-4 text-muted-foreground" />
                ) : (
                  <Eye className="w-4 h-4 text-muted-foreground" />
                )}
              </Button>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="new-password">New Password</Label>
            <div className="relative">
              <Input
                id="new-password"
                type={showPassword ? "text" : "password"}
                placeholder="Enter new password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
                minLength={MIN_PASSWORD_LENGTH}
                autoComplete="new-password"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute right-0 top-0 h-full px-3 hover:bg-transparent"
                onClick={() => setShowPassword(!showPassword)}
              >
                {showPassword ? (
                  <EyeOff className="w-4 h-4 text-muted-foreground" />
                ) : (
                  <Eye className="w-4 h-4 text-muted-foreground" />
                )}
              </Button>
            </div>
            <PasswordStrengthIndicator password={newPassword} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirm-password">Confirm Password</Label>
            <Input
              id="confirm-password"
              type={showPassword ? "text" : "password"}
              placeholder="Confirm new password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              autoComplete="new-password"
            />
          </div>
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
                Updating...
              </>
            ) : (
              "Update Password"
            )}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
