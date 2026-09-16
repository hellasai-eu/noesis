import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { ArrowLeft, Eye, EyeOff, Lock, Loader2, ShieldCheck } from "lucide-react";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import PasswordStrengthIndicator from "@/components/PasswordStrengthIndicator";
import { validateNewPassword } from "@/lib/password-policy";
import { isMfaPending } from "@/lib/mfa";
import { AuthApiError } from "@supabase/supabase-js";

const ResetPassword = () => {
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);
  const [hasValidSession, setHasValidSession] = useState(false);
  // A recovery link yields an aal1 session. For an MFA-enrolled user GoTrue
  // refuses the password update at aal1 (401 insufficient_aal), so the TOTP
  // challenge must run first — verifying elevates this same session to aal2.
  const [mfaPending, setMfaPending] = useState(false);
  const [mfaCode, setMfaCode] = useState("");
  const [verifyingMfa, setVerifyingMfa] = useState(false);

  const formatAuthError = (err: unknown): string => {
    if (err instanceof AuthApiError) {
      // Common password reset/update errors
      switch (err.code) {
        case "weak_password":
          return "Password is too weak for this project's policy. Try a longer password with a mix of letters, numbers, and symbols.";
        case "same_password":
          return "New password must be different from your current password.";
        case "reauthentication_needed":
          return "Please open the reset link again (it may have expired) and retry.";
        case "insufficient_aal":
          // Backstop only: the challenge step above should have run first.
          return "Enter the code from your authenticator app before setting a new password.";
        default:
          return err.message || "Failed to update password.";
      }
    }

    if (typeof err === "object" && err && "message" in err && typeof (err as any).message === "string") {
      return (err as any).message;
    }

    return "Failed to update password.";
  };

  useEffect(() => {
    const checkRecoverySession = async () => {
      try {
        const {
          data: { session },
          error,
        } = await supabase.auth.getSession();

        if (error) {
          console.error("Error checking session:", error);
          toast.error("Invalid or expired reset link");
          navigate("/auth");
          return;
        }

        if (session) {
          setHasValidSession(true);
          setMfaPending(isMfaPending(session));
        } else {
          toast.error("Invalid or expired reset link. Please request a new one.");
          navigate("/auth");
        }
      } catch (err) {
        console.error("Error:", err);
        toast.error("Something went wrong");
        navigate("/auth");
      } finally {
        setCheckingSession(false);
      }
    };

    // Listen for PASSWORD_RECOVERY event. isMfaPending decodes the session
    // locally — safe inside onAuthStateChange, unlike supabase.auth calls
    // (see src/lib/mfa.ts).
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY") {
        setHasValidSession(true);
        setMfaPending(isMfaPending(session));
        setCheckingSession(false);
      }
    });

    checkRecoverySession();

    return () => {
      subscription.unsubscribe();
    };
  }, [navigate]);

  // Mirrors Auth.tsx's handleVerifyMfa: a code identifies its factor only by
  // verifying against it, so try each TOTP factor rather than silently
  // challenging the first.
  const handleVerifyMfa = async (e: React.FormEvent) => {
    e.preventDefault();
    if (mfaCode.length !== 6) return;
    setVerifyingMfa(true);

    try {
      const { data: factorData, error: factorError } = await supabase.auth.mfa.listFactors();
      const factors = factorData?.totp ?? [];
      if (factorError || factors.length === 0) {
        toast.error("Could not load your authenticator settings. Please open the reset link again.");
        return;
      }

      let verified = false;
      for (const factor of factors) {
        const { error } = await supabase.auth.mfa.challengeAndVerify({
          factorId: factor.id,
          code: mfaCode,
        });
        if (!error) {
          verified = true;
          break;
        }
      }

      if (!verified) {
        toast.error("Invalid or expired code. Please try again.");
        setMfaCode("");
        return;
      }

      // The session is aal2 now; the password form can proceed.
      setMfaPending(false);
    } finally {
      setVerifyingMfa(false);
    }
  };

  // Shared by the challenge's "back" action and the post-update redirect. A
  // failed sign-out must not LOOK like a completed one: the recovery session
  // would still be live in this browser's storage, which matters on a shared
  // machine.
  const signOutAndReturnToAuth = async () => {
    const { error } = await supabase.auth.signOut();
    if (error) {
      console.error("Error signing out of the recovery session:", error);
      toast.error(
        "Sign-out did not complete. If this is a shared device, close this browser tab."
      );
    }
    navigate("/auth");
  };

  const handleCancelMfa = async () => {
    await signOutAndReturnToAuth();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (password !== confirmPassword) {
      toast.error("Passwords do not match");
      return;
    }

    // Shared mirror of the server-enforced Supabase Auth policy.
    const policyError = validateNewPassword(password);
    if (policyError) {
      toast.error(policyError);
      return;
    }

    setLoading(true);
    try {
      const { error } = await supabase.auth.updateUser({
        password,
      });

      if (error) throw error;

      toast.success("Password updated successfully! Please sign in with your new password.");

      // Force a fresh login with the new credentials
      await signOutAndReturnToAuth();
    } catch (error: unknown) {
      console.error("Error updating password:", error);
      toast.error(formatAuthError(error));
    } finally {
      setLoading(false);
    }
  };

  if (checkingSession) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-muted-foreground">Verifying reset link...</p>
        </div>
      </div>
    );
  }

  if (!hasValidSession) {
    return null;
  }

  if (mfaPending) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
              <ShieldCheck className="h-6 w-6 text-primary" />
            </div>
            <CardTitle className="text-2xl">Two-Factor Authentication</CardTitle>
            <CardDescription>
              Enter the 6-digit code from your authenticator app to continue resetting your
              password
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleVerifyMfa} className="space-y-6">
              <div className="flex justify-center">
                <InputOTP
                  maxLength={6}
                  value={mfaCode}
                  onChange={setMfaCode}
                  autoFocus
                  data-testid="mfa-code-input"
                >
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
              <Button
                type="submit"
                className="w-full"
                size="lg"
                disabled={verifyingMfa || mfaCode.length !== 6}
              >
                {verifyingMfa ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Verifying...
                  </>
                ) : (
                  "Verify"
                )}
              </Button>
              <button
                type="button"
                onClick={handleCancelMfa}
                className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mx-auto"
              >
                <ArrowLeft className="w-4 h-4" />
                Back to sign in
              </button>
            </form>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
            <Lock className="h-6 w-6 text-primary" />
          </div>
          <CardTitle className="text-2xl">Set New Password</CardTitle>
          <CardDescription>
            Enter your new password below
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="password">New Password</Label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter new password"
                  required
                  minLength={8}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute right-0 top-0 h-full px-3 hover:bg-transparent"
                  onClick={() => setShowPassword(!showPassword)}
                >
                  {showPassword ? (
                    <EyeOff className="h-4 w-4 text-muted-foreground" />
                  ) : (
                    <Eye className="h-4 w-4 text-muted-foreground" />
                  )}
                </Button>
              </div>
              <PasswordStrengthIndicator password={password} />
            </div>

            <div className="space-y-2">
              <Label htmlFor="confirmPassword">Confirm Password</Label>
              <div className="relative">
                <Input
                  id="confirmPassword"
                  type={showConfirmPassword ? "text" : "password"}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Confirm new password"
                  required
                  minLength={8}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute right-0 top-0 h-full px-3 hover:bg-transparent"
                  onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                >
                  {showConfirmPassword ? (
                    <EyeOff className="h-4 w-4 text-muted-foreground" />
                  ) : (
                    <Eye className="h-4 w-4 text-muted-foreground" />
                  )}
                </Button>
              </div>
              {confirmPassword && password !== confirmPassword && (
                <p className="text-sm text-destructive">Passwords do not match</p>
              )}
            </div>

            <Button
              type="submit"
              className="w-full"
              disabled={loading || password !== confirmPassword || password.length < 8}
            >
              {loading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Updating...
                </>
              ) : (
                "Update Password"
              )}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
};

export default ResetPassword;
