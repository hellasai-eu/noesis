import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
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
import { Loader2, Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";
import { MIN_PASSWORD_LENGTH, validateNewPassword } from "@/lib/password-policy";
import PasswordStrengthIndicator from "./PasswordStrengthIndicator";

interface ResetUserPasswordDialogProps {
  /** The auth user id whose password should be reset. */
  userId: string;
  /** Human-friendly label for the target user (name or email), shown in the dialog. */
  userLabel?: string | null;
  /** Optional custom trigger. When omitted, the dialog must be controlled via `open`/`onOpenChange`. */
  trigger?: React.ReactNode;
  /** Controlled open state (optional). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Called after a successful reset. */
  onSuccess?: () => void;
}



export function ResetUserPasswordDialog({
  userId,
  userLabel,
  trigger,
  open: controlledOpen,
  onOpenChange,
  onSuccess,
}: ResetUserPasswordDialogProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : uncontrolledOpen;

  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);

  const resetFields = () => {
    setNewPassword("");
    setConfirmPassword("");
    setShowPassword(false);
  };

  const setOpen = (next: boolean) => {
    if (!isControlled) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      resetFields();
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Shared mirror of the server-enforced Supabase Auth policy.
    const policyError = validateNewPassword(newPassword);
    if (policyError) {
      toast.error(policyError);
      return;
    }

    if (newPassword !== confirmPassword) {
      toast.error("Passwords do not match");
      return;
    }

    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("admin-set-user-password", {
        body: { userId, newPassword },
      });

      if (error) {
        // FunctionsHttpError stashes the raw Response on .context; pull the real
        // message out so we surface the function's actual error (e.g. the 403
        // reason) instead of the generic "non-2xx status code".
        let message = error.message || "Failed to reset password";
        const ctx = (error as { context?: { json?: () => Promise<unknown> } }).context;
        if (ctx && typeof ctx.json === "function") {
          try {
            const errorBody = (await ctx.json()) as { error?: string };
            if (errorBody?.error) message = errorBody.error;
          } catch {
            /* body wasn't JSON — keep the default message */
          }
        }
        throw new Error(message);
      }

      if (data?.error) {
        throw new Error(data.error);
      }

      toast.success("Password reset successfully");
      handleOpenChange(false);
      onSuccess?.();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Failed to reset password";
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Reset Password</DialogTitle>
          <DialogDescription>
            {userLabel
              ? `Set a new password for ${userLabel}.`
              : "Set a new password for this user."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="reset-new-password">New Password</Label>
            <div className="relative">
              <Input
                id="reset-new-password"
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
            <Label htmlFor="reset-confirm-password">Confirm Password</Label>
            <Input
              id="reset-confirm-password"
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
                Resetting...
              </>
            ) : (
              "Reset Password"
            )}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default ResetUserPasswordDialog;
