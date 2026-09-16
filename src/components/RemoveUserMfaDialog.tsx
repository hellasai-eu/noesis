import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

interface RemoveUserMfaDialogProps {
  /** The auth user id whose MFA factors should be removed. */
  userId: string;
  /** Human-friendly label for the target user (name or email), shown in the dialog. */
  userLabel?: string | null;
  /** True when the admin is removing MFA from their own account. */
  isSelf?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful removal. */
  onSuccess?: () => void;
}

export function RemoveUserMfaDialog({
  userId,
  userLabel,
  isSelf,
  open,
  onOpenChange,
  onSuccess,
}: RemoveUserMfaDialogProps) {
  const [loading, setLoading] = useState(false);

  const handleConfirm = async (e: React.MouseEvent) => {
    // Keep the dialog open while the request runs; close it ourselves after.
    e.preventDefault();

    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("admin-reset-user-mfa", {
        body: { userId },
      });

      if (error) {
        // FunctionsHttpError stashes the raw Response on .context; pull the real
        // message out so we surface the function's actual error (e.g. the 403
        // reason) instead of the generic "non-2xx status code".
        let message = error.message || "Failed to remove two-factor authentication";
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

      if ((data?.removed ?? 0) > 0) {
        toast.success(
          isSelf
            ? "Two-factor authentication removed. You have been signed out of all sessions, including this one — sign in again with your password."
            : "Two-factor authentication removed. The user has been signed out of all sessions.",
        );
      } else {
        toast.info("This user has no two-factor authentication enrolled.");
      }
      onOpenChange(false);
      onSuccess?.();
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Failed to remove two-factor authentication";
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={(next) => !loading && onOpenChange(next)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove two-factor authentication?</AlertDialogTitle>
          <AlertDialogDescription>
            {userLabel
              ? `This removes the authenticator-app requirement from ${userLabel}'s account.`
              : "This removes the authenticator-app requirement from this account."}{" "}
            {isSelf
              ? "You will be signed out of ALL sessions — including this one — and can then sign in with just your password."
              : "The user will be signed out of all sessions, can then sign in with just their password, and will be notified by email."}{" "}
            Two-factor authentication can be re-enabled from account settings at any time. Use this
            when {isSelf ? "you have" : "a user has"} lost access to the authenticator app.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={loading}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={handleConfirm} disabled={loading}>
            {loading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
                Removing...
              </>
            ) : (
              "Remove"
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export default RemoveUserMfaDialog;
