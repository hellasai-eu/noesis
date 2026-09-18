import { useState, useEffect } from "react";
import { useNavigate, Link, useSearchParams } from "react-router-dom";
import { useAuth, SIGNOUT_REASON_STORAGE_KEY } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { SignupAgreement } from "@/components/SignupAgreement";
import { Loader2, Lock, ArrowLeft, Mail, ShieldCheck } from "lucide-react";
import { BrandMark } from "@/components/BrandMark";
import { brand } from "@/deployment";
import { toast } from "sonner";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";
import { checkVersionAndNavigate } from "@/lib/versionCheck";
import PasswordStrengthIndicator from "@/components/PasswordStrengthIndicator";
import { setSelectedInstitutionId } from "@/lib/selected-institution";
import { newPasswordSchema } from "@/lib/password-policy";

const emailSchema = z.string().email("Please enter a valid email address");
// Sign-in only checks presence: accounts created before the stricter policy
// may hold shorter passwords, and the server is the judge of a login anyway.
// New passwords go through the shared policy mirror in lib/password-policy.
const signInPasswordSchema = z.string().min(1, "Please enter your password");

/**
 * The "express interest" mailto, built once from the configured address.
 *
 * `null` when the overlay supplies none, which hides the button — the address
 * used to be a literal in the markup, which meant every deployment of this
 * repository pointed prospective schools at one particular operator's inbox.
 */
const interestMailto = brand.contactEmail
  ? `mailto:${brand.contactEmail}` +
    `?subject=${encodeURIComponent(`Interest in ${brand.name}`)}` +
    `&body=${encodeURIComponent(
      `Hello,\n\nI am interested in learning more about ${brand.name} for my institution.\n\nName: \nInstitution: \nRole: \n\nThank you!`,
    )}`
  : null;

interface InvitationData {
  id: string;
  email: string;
  institution_id: string;
  institution_name: string;
  role: string;
  invited_name: string | null;
}

const Auth = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user, signIn, signUp, signOut, loading, mfaChallengeRequired } = useAuth();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [mfaCode, setMfaCode] = useState("");
  const [invitationData, setInvitationData] = useState<InvitationData | null>(null);
  const [loadingInvitation, setLoadingInvitation] = useState(false);
  const [showForgotPassword, setShowForgotPassword] = useState(false);
  const [resetEmail, setResetEmail] = useState("");

  // Sign In form
  const [signInEmail, setSignInEmail] = useState("");
  const [signInPassword, setSignInPassword] = useState("");

  // Sign Up form
  const [signUpEmail, setSignUpEmail] = useState("");
  const [signUpPassword, setSignUpPassword] = useState("");
  const [signUpName, setSignUpName] = useState("");

  // Inactivity-signout toast
  useEffect(() => {
    const fromQuery = searchParams.get("reason") === "inactivity";
    let fromStorage = false;
    try {
      fromStorage = sessionStorage.getItem(SIGNOUT_REASON_STORAGE_KEY) === "inactivity";
    } catch {
      // sessionStorage may be unavailable
    }

    if (fromQuery || fromStorage) {
      toast.info("Signed out due to inactivity");
      try {
        sessionStorage.removeItem(SIGNOUT_REASON_STORAGE_KEY);
      } catch {
        // ignore
      }
    }
  }, [searchParams]);

  // Check for invitation parameters
  useEffect(() => {
    const institutionId = searchParams.get("invitation");
    const email = searchParams.get("email");

    if (institutionId && email) {
      setLoadingInvitation(true);
      // Verify the invitation exists and is pending.
      //
      // Through an RPC rather than a table read: the caller has no account yet,
      // and the policy that used to allow the anonymous read matched on
      // `status = 'pending'` alone, so it returned every pending invitation in
      // the database to anyone holding the anon key (#1173). The `.eq()` filters
      // below used to be the only thing narrowing it, and a filter the client
      // supplies is a filter the client can drop.
      //
      // `get_pending_invitation` takes the same two values from the link and
      // returns at most the one row they name. The `invitation` parameter is
      // either an institution id or an invitation id depending on which sender
      // produced the link; the function accepts both.
      const verifyInvitation = async () => {
        // Awaited directly rather than through `.maybeSingle()`: the function
        // returns SETOF and already limits to one row, so the first element is
        // the answer, and reading it this way does not depend on the client
        // returning a chainable builder.
        const { data, error } = await supabase.rpc("get_pending_invitation", {
          _token: institutionId,
          _email: decodeURIComponent(email),
        });

        const invitation = Array.isArray(data) ? data[0] : null;

        if (error || !invitation) {
          toast.error("Invalid or expired invitation");
          setLoadingInvitation(false);
          return;
        }

        setInvitationData({
          id: invitation.id,
          email: invitation.email,
          institution_id: invitation.institution_id,
          institution_name: invitation.institution_name || "Institution",
          role: invitation.role,
          invited_name: invitation.invited_name,
        });
        setSignUpEmail(invitation.email);
        // Pre-fill name from invitation if provided
        if (invitation.invited_name) {
          setSignUpName(invitation.invited_name);
        }
        setLoadingInvitation(false);
      };

      verifyInvitation();
    }
  }, [searchParams]);

  useEffect(() => {
    if (user && !loading) {
      void checkVersionAndNavigate("/select-institution", navigate);
    }
  }, [user, loading, navigate]);

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);

    try {
      emailSchema.parse(signInEmail);
      signInPasswordSchema.parse(signInPassword);
    } catch (error) {
      if (error instanceof z.ZodError) {
        toast.error(error.errors[0].message);
        setIsSubmitting(false);
        return;
      }
    }

    const { error, mfaRequired } = await signIn(signInEmail, signInPassword);

    if (error) {
      const code = (error as { code?: string }).code;
      const message = error.message ?? "";
      if (code === "user_banned" || message.toLowerCase().includes("user is banned")) {
        toast.error("Login failed. Please contact an administrator.");
      } else if (message.includes("Invalid login credentials")) {
        toast.error("Invalid email or password");
      } else {
        toast.error(message);
      }
      setIsSubmitting(false);
      return;
    }

    if (mfaRequired) {
      // The challenge form renders now (mfaChallengeRequired flips via
      // onAuthStateChange); completeSignIn runs after the code is accepted.
      setIsSubmitting(false);
      return;
    }

    await completeSignIn();
    setIsSubmitting(false);
  };

  const completeSignIn = async () => {
    // If signing in with a pending invitation, process it via edge function
    if (invitationData) {
      try {
        const { data: { user: currentUser } } = await supabase.auth.getUser();
        
        if (currentUser) {
          const { data, error: fnError } = await supabase.functions.invoke('accept-invitation', {
            body: { invitationId: invitationData.id }
          });

          if (fnError) {
            console.error("Error accepting invitation:", fnError);
            toast.error("Signed in but failed to process invitation");
          } else {
            console.log("Invitation accepted:", data);
            toast.success(`Welcome to ${invitationData.institution_name}!`);
          }
        }
      } catch (err) {
        console.error("Error processing invitation on sign-in:", err);
        toast.error("Signed in but failed to process invitation");
      }
    } else {
      toast.success("Welcome back!");
    }

    await checkVersionAndNavigate("/select-institution", navigate);
  };

  const handleVerifyMfa = async (e: React.FormEvent) => {
    e.preventDefault();
    if (mfaCode.length !== 6) return;
    setIsSubmitting(true);

    try {
      const { data: factorData, error: factorError } = await supabase.auth.mfa.listFactors();
      const factors = factorData?.totp ?? [];
      if (factorError || factors.length === 0) {
        toast.error("Could not load your authenticator settings. Please sign in again.");
        await signOut();
        return;
      }

      // The settings dialog only enrolls one factor, but the API permits
      // several — and a code identifies its factor only by verifying against
      // it, so try each in turn rather than silently challenging the first.
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

      await completeSignIn();
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCancelMfa = async () => {
    setMfaCode("");
    await signOut();
  };

  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);

    try {
      emailSchema.parse(resetEmail);
    } catch (error) {
      if (error instanceof z.ZodError) {
        toast.error(error.errors[0].message);
        setIsSubmitting(false);
        return;
      }
    }

    const { error } = await supabase.auth.resetPasswordForEmail(resetEmail, {
      redirectTo: `${window.location.origin}/reset-password`,
    });

    if (error) {
      toast.error(error.message);
    } else {
      toast.success("Password reset link sent! Check your email (and spam/junk folder).");
      setShowForgotPassword(false);
      setResetEmail("");
    }

    setIsSubmitting(false);
  };

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);

    try {
      emailSchema.parse(signUpEmail);
      newPasswordSchema.parse(signUpPassword);
      if (!signUpName.trim()) {
        throw new Error("Please enter your full name");
      }
    } catch (error) {
      if (error instanceof z.ZodError) {
        toast.error(error.errors[0].message);
      } else if (error instanceof Error) {
        toast.error(error.message);
      }
      setIsSubmitting(false);
      return;
    }

    const { error, data } = await signUp(signUpEmail, signUpPassword, signUpName);
    
    if (error) {
      if (error.message.includes("already registered")) {
        toast.error("This email is already registered. Please sign in instead.");
      } else {
        toast.error(error.message);
      }
      setIsSubmitting(false);
      return;
    }

    // Check if user already exists (user_repeated_signup case)
    // In this case, data.user will be returned but no session is created
    // The user needs to sign in instead
    if (data?.user && !data.user.identities?.length) {
      toast.error("This email is already registered. Please sign in to accept the invitation.");
      setIsSubmitting(false);
      return;
    }

    // If this is an invitation-based signup, process via edge function
    if (invitationData && data?.user) {
      try {
        // Wait a moment for the session to be fully established
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Refresh the session to ensure JWT is available
        const { data: sessionData } = await supabase.auth.getSession();
        if (!sessionData.session) {
          console.error("No session after signup");
          toast.error("Account created but session not established. Please sign in.");
          setIsSubmitting(false);
          return;
        }

        // Upsert profile with full name (in case trigger didn't create it)
        await supabase
          .from("profiles")
          .upsert({
            user_id: data.user.id,
            email: signUpEmail,
            full_name: signUpName,
          }, { onConflict: 'user_id' });

        // Process invitation via edge function (handles membership + tags)
        const { data: inviteResult, error: fnError } = await supabase.functions.invoke('accept-invitation', {
          body: { invitationId: invitationData.id }
        });

        if (fnError) {
          console.error("Error processing invitation:", fnError);
          toast.error("Account created but failed to join institution. Please sign in and try again.");
          setIsSubmitting(false);
          return;
        }

        console.log("Invitation processed:", inviteResult);

        // Set session storage for immediate redirect to correct dashboard
        setSelectedInstitutionId(invitationData.institution_id);

        toast.success(`Welcome to ${invitationData.institution_name}!`);
      } catch (err) {
        console.error("Error processing invitation:", err);
        toast.error("Account created but failed to process invitation");
      }
    } else {
      toast.success("Account created successfully!");
    }

    await checkVersionAndNavigate("/select-institution", navigate);
    setIsSubmitting(false);
  };

  if (loading || loadingInvitation) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  const isInvitationSignup = !!invitationData;

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Header */}
      <nav className="container mx-auto px-6 py-6">
        <BrandMark to="/" size="lg" />
      </nav>

      {/* Auth Form */}
      <div className="flex-1 flex items-center justify-center px-6 py-12">
        <Card className="w-full max-w-md shadow-elegant animate-scale-in">
          <CardHeader className="text-center">
            <CardTitle className="text-2xl font-display">
              {mfaChallengeRequired
                ? "Two-Factor Authentication"
                : isInvitationSignup
                  ? `Join ${invitationData.institution_name}`
                  : showForgotPassword
                    ? "Reset Password"
                    : `Welcome to ${brand.name}`}
            </CardTitle>
            <CardDescription>
              {mfaChallengeRequired
                ? "Enter the 6-digit code from your authenticator app"
                : isInvitationSignup
                  ? "Complete your registration to accept the invitation"
                  : showForgotPassword
                    ? "We'll send you a link to reset your password"
                    : "Sign in to your account or create a new one"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {mfaChallengeRequired ? (
              <form onSubmit={handleVerifyMfa} className="space-y-6">
                <div className="flex justify-center">
                  <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
                    <ShieldCheck className="w-6 h-6 text-primary" />
                  </div>
                </div>
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
                  disabled={isSubmitting || mfaCode.length !== 6}
                >
                  {isSubmitting ? (
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
            ) : isInvitationSignup ? (
              // Invitation-based signup form (no tabs, just signup)
              <form onSubmit={handleSignUp} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="signup-name">Full Name</Label>
                  {invitationData.invited_name ? (
                    <div className="relative">
                      <Input
                        id="signup-name"
                        type="text"
                        value={signUpName}
                        readOnly
                        className="bg-muted pr-10"
                      />
                      <Lock className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    </div>
                  ) : (
                    <Input
                      id="signup-name"
                      type="text"
                      placeholder="John Doe"
                      value={signUpName}
                      onChange={(e) => setSignUpName(e.target.value)}
                      required
                    />
                  )}
                  {invitationData.invited_name && (
                    <p className="text-xs text-muted-foreground">
                      This name was specified in your invitation
                    </p>
                  )}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="signup-email">Email</Label>
                  <div className="relative">
                    <Input
                      id="signup-email"
                      type="email"
                      value={signUpEmail}
                      readOnly
                      className="bg-muted pr-10"
                    />
                    <Lock className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    This email was specified in your invitation
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="signup-password">Password</Label>
                  <Input
                    id="signup-password"
                    type="password"
                    placeholder="••••••••"
                    value={signUpPassword}
                    onChange={(e) => setSignUpPassword(e.target.value)}
                    required
                  />
                  <PasswordStrengthIndicator password={signUpPassword} />
                </div>
                <SignupAgreement />
                <Button
                  type="submit"
                  className="w-full"
                  size="lg"
                  disabled={isSubmitting}
                >
                  {isSubmitting ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Creating account...
                    </>
                  ) : (
                    "Accept Invitation"
                  )}
                </Button>
                <p className="text-center text-sm text-muted-foreground">
                  Already have an account?{" "}
                  <Link to="/auth" className="text-primary hover:underline">
                    Sign in
                  </Link>
                </p>
              </form>
            ) : showForgotPassword ? (
              <form onSubmit={handleForgotPassword} className="space-y-4">
                <button
                  type="button"
                  onClick={() => setShowForgotPassword(false)}
                  className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-4"
                >
                  <ArrowLeft className="w-4 h-4" />
                  Back to sign in
                </button>
                <div className="space-y-2">
                  <Label htmlFor="reset-email">Email</Label>
                  <Input
                    id="reset-email"
                    type="email"
                    placeholder="your@email.com"
                    value={resetEmail}
                    onChange={(e) => setResetEmail(e.target.value)}
                    required
                  />
                </div>
                <p className="text-sm text-muted-foreground">
                  Enter your email address and we'll send you a link to reset your password. Please check your spam/junk folder if you don't see it in your inbox.
                </p>
                <Button
                  type="submit"
                  className="w-full"
                  size="lg"
                  disabled={isSubmitting}
                >
                  {isSubmitting ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Sending...
                    </>
                  ) : (
                    "Send Reset Link"
                  )}
                </Button>
              </form>
            ) : (
              <Tabs defaultValue="signin" className="w-full">
                <TabsList className="grid w-full grid-cols-2 mb-6">
                  <TabsTrigger value="signin">Sign In</TabsTrigger>
                  <TabsTrigger value="signup">Sign Up</TabsTrigger>
                </TabsList>

                <TabsContent value="signin">
                  <form onSubmit={handleSignIn} className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="signin-email">Email</Label>
                      <Input
                        id="signin-email"
                        type="email"
                        placeholder="your@email.com"
                        value={signInEmail}
                        onChange={(e) => setSignInEmail(e.target.value)}
                        required
                      />
                    </div>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label htmlFor="signin-password">Password</Label>
                        <button
                          type="button"
                          onClick={() => setShowForgotPassword(true)}
                          className="text-xs text-primary hover:underline"
                        >
                          Forgot password?
                        </button>
                      </div>
                      <Input
                        id="signin-password"
                        type="password"
                        placeholder="••••••••"
                        value={signInPassword}
                        onChange={(e) => setSignInPassword(e.target.value)}
                        required
                      />
                    </div>
                    <Button
                      type="submit"
                      className="w-full"
                      size="lg"
                      disabled={isSubmitting}
                    >
                      {isSubmitting ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          Signing in...
                        </>
                      ) : (
                        "Sign In"
                      )}
                    </Button>
                  </form>
                </TabsContent>

                <TabsContent value="signup">
                  <div className="mb-4 p-4 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800">
                    <p className="text-sm text-amber-800 dark:text-amber-200 text-center">
                      <strong>Invitation Only</strong> — Registration is currently available only through institutional invitations.
                    </p>
                  </div>
                  <form onSubmit={handleSignUp} className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="signup-name">Full Name</Label>
                      <Input
                        id="signup-name"
                        type="text"
                        placeholder="John Doe"
                        value={signUpName}
                        onChange={(e) => setSignUpName(e.target.value)}
                        required
                        disabled
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="signup-email">Email</Label>
                      <Input
                        id="signup-email"
                        type="email"
                        placeholder="your@email.com"
                        value={signUpEmail}
                        onChange={(e) => setSignUpEmail(e.target.value)}
                        required
                        disabled
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="signup-password">Password</Label>
                      <Input
                        id="signup-password"
                        type="password"
                        placeholder="••••••••"
                        value={signUpPassword}
                        onChange={(e) => setSignUpPassword(e.target.value)}
                        required
                        disabled
                      />
                      <PasswordStrengthIndicator password={signUpPassword} />
                    </div>
                    <SignupAgreement />
                    <Button
                      type="submit"
                      className="w-full"
                      size="lg"
                      disabled
                    >
                      Create Account
                    </Button>
                    <p className="text-xs text-center text-muted-foreground mb-3">
                      Contact your institution administrator to receive an invitation.
                    </p>
                    {/* Only when the deployment overlay supplies an address.
                        An unconfigured clone must not invite a stranger to
                        mail whoever happened to be hardcoded here. */}
                    {interestMailto && (
                      <Button
                        type="button"
                        variant="outline"
                        className="w-full"
                        asChild
                      >
                        <a href={interestMailto}>
                          <Mail className="w-4 h-4 mr-2" />
                          Contact Us to Express Interest
                        </a>
                      </Button>
                    )}
                  </form>
                </TabsContent>
              </Tabs>
            )}
          </CardContent>
        </Card>
      </div>
      
      {/* Version */}
      <div className="py-4 text-center">
        <p className="text-xs text-muted-foreground/60">
          v{import.meta.env.VITE_BUILD_TIME || '1.0.0'}
        </p>
      </div>
    </div>
  );
};

export default Auth;