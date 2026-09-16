import { z } from "zod";

/**
 * The single client-side mirror of the server-enforced Supabase Auth password
 * policy: minimum 8 characters, at least one letter and one digit. The server
 * additionally rejects known-leaked passwords (HaveIBeenPwned) — that check
 * cannot be mirrored here and surfaces as a server error.
 *
 * Every form that SETS a password (sign-up, change, reset, admin reset) must
 * validate through this module, so the forms cannot drift from the policy or
 * from each other. Sign-in deliberately does not: accounts created before the
 * stricter policy may hold shorter passwords, and the server judges logins.
 */
export const MIN_PASSWORD_LENGTH = 8;

export const PASSWORD_LENGTH_MESSAGE = `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
export const PASSWORD_COMPOSITION_MESSAGE =
  "Password must contain at least one letter and one number";

/** The policy as a zod schema, for schema-based forms. */
export const newPasswordSchema = z
  .string()
  .min(MIN_PASSWORD_LENGTH, PASSWORD_LENGTH_MESSAGE)
  .regex(/[A-Za-z]/, PASSWORD_COMPOSITION_MESSAGE)
  .regex(/[0-9]/, PASSWORD_COMPOSITION_MESSAGE);

/** The policy as a plain check: the first violation's message, or null. */
export function validateNewPassword(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return PASSWORD_LENGTH_MESSAGE;
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    return PASSWORD_COMPOSITION_MESSAGE;
  }
  return null;
}
