/**
 * The shared client mirror of the server-enforced Supabase Auth password
 * policy (min 8, letters and digits). Every form that sets a password —
 * sign-up (Auth, InstitutionPage), ChangePasswordDialog, ResetPassword,
 * ResetUserPasswordDialog — validates through this module, so these cases
 * cover the acceptance/rejection matrix once for all of them; the per-form
 * tests only need to prove the form calls it.
 */
import { describe, it, expect } from "vitest";
import {
  MIN_PASSWORD_LENGTH,
  PASSWORD_COMPOSITION_MESSAGE,
  PASSWORD_LENGTH_MESSAGE,
  newPasswordSchema,
  validateNewPassword,
} from "@/lib/password-policy";

describe("validateNewPassword", () => {
  it("accepts a policy-compliant password", () => {
    expect(validateNewPassword("abcdef12")).toBeNull();
    expect(validateNewPassword("testpass123")).toBeNull();
    expect(validateNewPassword("X1!X1!X1!")).toBeNull();
  });

  it("rejects anything under the minimum length, letters+digits or not", () => {
    expect(validateNewPassword("abc123")).toBe(PASSWORD_LENGTH_MESSAGE);
    expect(validateNewPassword("a1")).toBe(PASSWORD_LENGTH_MESSAGE);
    expect(validateNewPassword("")).toBe(PASSWORD_LENGTH_MESSAGE);
  });

  it("rejects a long password with no digit", () => {
    expect(validateNewPassword("abcdefgh")).toBe(PASSWORD_COMPOSITION_MESSAGE);
  });

  it("rejects a long password with no letter", () => {
    expect(validateNewPassword("12345678")).toBe(PASSWORD_COMPOSITION_MESSAGE);
    expect(validateNewPassword("1234!@#$5678")).toBe(PASSWORD_COMPOSITION_MESSAGE);
  });

  it("exactly the minimum length passes with letters and digits", () => {
    expect("abcdef12".length).toBe(MIN_PASSWORD_LENGTH);
    expect(validateNewPassword("abcdef12")).toBeNull();
  });
});

describe("newPasswordSchema (the zod twin used by Auth sign-up)", () => {
  it("agrees with the validator on acceptance", () => {
    expect(newPasswordSchema.safeParse("abcdef12").success).toBe(true);
  });

  it("agrees with the validator on both rejection axes", () => {
    const short = newPasswordSchema.safeParse("abc123");
    expect(short.success).toBe(false);
    expect(short.success ? "" : short.error.issues[0].message).toBe(PASSWORD_LENGTH_MESSAGE);

    const noDigit = newPasswordSchema.safeParse("abcdefgh");
    expect(noDigit.success).toBe(false);
    expect(noDigit.success ? "" : noDigit.error.issues[0].message).toBe(
      PASSWORD_COMPOSITION_MESSAGE,
    );

    const noLetter = newPasswordSchema.safeParse("12345678");
    expect(noLetter.success).toBe(false);
    expect(noLetter.success ? "" : noLetter.error.issues[0].message).toBe(
      PASSWORD_COMPOSITION_MESSAGE,
    );
  });
});
