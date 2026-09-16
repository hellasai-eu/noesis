import { createClient, SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;

let verifier: SupabaseClient | null = null;

/**
 * Check an email/password pair against GoTrue WITHOUT touching the app's
 * stored session.
 *
 * ChangePasswordDialog used to re-verify through the shared client, but
 * signInWithPassword replaces the stored session with the fresh aal1 one it
 * returns. For a user with an enrolled TOTP factor that downgrade flips
 * isMfaPending, useAuth nulls `user`, and every page's auth guard bounces the
 * app to the /auth challenge mid-dialog. A separate non-persisting client
 * verifies the password while the real (aal2) session stays in place.
 */
export async function verifyCurrentPassword(
  email: string,
  password: string
): Promise<{ error: Error | null }> {
  if (!verifier) {
    verifier = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        // Distinct from the main client's storage key so GoTrue doesn't warn
        // about (or ever cross) two clients sharing one storage slot.
        storageKey: 'sb-password-verify',
      },
    });
  }

  const { data, error } = await verifier.auth.signInWithPassword({ email, password });

  if (!error && data.session) {
    // The check created a real session server-side; revoke its refresh token
    // rather than leaving an orphan. A failed revoke must not fail the
    // verification — the password WAS correct — but it shouldn't be silent.
    const { error: signOutError } = await verifier.auth.signOut({ scope: 'local' });
    if (signOutError) {
      console.warn('Failed to revoke password-verification session:', signOutError);
    }
  }

  return { error };
}
