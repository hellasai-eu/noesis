import { Link } from "react-router-dom";

/**
 * The agreement line on the signup forms (issue #937).
 *
 * Not a checkbox: the platform does not rely on the account holder's consent
 * for anything — the school is the controller and decides that the platform is
 * used, and most account holders are minors who could not give it anyway.
 * A tick box would imply a basis we do not use and record a consent we would
 * never act on. What is owed here is notice with a working link, which is what
 * this is.
 */
export const SignupAgreement = () => (
  <p data-testid="signup-agreement" className="text-xs text-center text-muted-foreground">
    By creating an account you agree to the{" "}
    <Link to="/legal/terms" className="text-primary hover:underline">
      Terms of Service
    </Link>{" "}
    and the{" "}
    <Link to="/legal/privacy" className="text-primary hover:underline">
      Privacy Policy
    </Link>
    .
  </p>
);

export default SignupAgreement;
