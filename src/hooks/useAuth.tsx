/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useState, ReactNode } from 'react';
import { User, Session } from '@supabase/supabase-js';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { isMfaPending } from '@/lib/mfa';
import { useInactivityTimer, ACTIVITY_STORAGE_KEY } from '@/hooks/useInactivityTimer';

interface Profile {
  id: string;
  user_id: string;
  full_name: string | null;
  email: string | null;
  father_name: string | null;
  date_of_birth: string | null;
}

interface AuthContextType {
  user: User | null;
  session: Session | null;
  profile: Profile | null;
  loading: boolean;
  /**
   * True while a password sign-in still owes a TOTP code. `user` stays null
   * for the duration, so every page's `!user` guard redirects to /auth, which
   * renders the challenge.
   */
  mfaChallengeRequired: boolean;
  signIn: (email: string, password: string) => Promise<{ error: Error | null; mfaRequired?: boolean }>;
  signUp: (email: string, password: string, fullName: string) => Promise<{ error: Error | null; data: { user: User | null } | null }>;
  signOut: () => Promise<void>;
  updatePassword: (newPassword: string) => Promise<{ error: Error | null }>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const INACTIVITY_TIMEOUT_MS = 60 * 60 * 1000;
export const SIGNOUT_REASON_STORAGE_KEY = 'signoutReason';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [mfaChallengeRequired, setMfaChallengeRequired] = useState(false);
  const queryClient = useQueryClient();

  const fetchProfile = async (userId: string) => {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    if (!error && data) {
      setProfile(data as Profile);
    }
  };

  const recordLoginHistory = async (userId: string) => {
    try {
      // Fetch client IP from a public API
      let ipAddress = null;
      try {
        const response = await fetch('https://api.ipify.org?format=json');
        const data = await response.json();
        ipAddress = data.ip;
      } catch (ipError) {
        console.warn('Could not fetch IP address:', ipError);
      }

      const userAgent = navigator.userAgent;

      await supabase.from('login_history').insert({
        user_id: userId,
        ip_address: ipAddress,
        user_agent: userAgent,
      });
    } catch (err) {
      console.error('Failed to record login history:', err);
    }
  };

  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event, session) => {
        // The password step deferred this until the code was accepted.
        if (event === 'MFA_CHALLENGE_VERIFIED' && session?.user) {
          const userId = session.user.id;
          setTimeout(() => {
            recordLoginHistory(userId);
          }, 0);
        }

        const pending = isMfaPending(session);
        setMfaChallengeRequired(pending);
        setSession(session);
        setUser(pending ? null : session?.user ?? null);

        if (session?.user && !pending) {
          setTimeout(() => {
            fetchProfile(session.user.id);
          }, 0);
        } else {
          setProfile(null);
        }

        setLoading(false);
      }
    );

    supabase.auth.getSession().then(({ data: { session } }) => {
      const pending = isMfaPending(session);
      setMfaChallengeRequired(pending);
      setSession(session);
      setUser(pending ? null : session?.user ?? null);

      if (session?.user && !pending) {
        fetchProfile(session.user.id);
      }

      setLoading(false);
    });

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  /**
   * Report a failed sign-in so it lands in `failed_login_attempts`.
   *
   * The edge function is what writes the row: it reads the client IP from the
   * request headers (rightmost x-forwarded-for hop) and writes with the service
   * role. That is better than `login_history.ip_address`, which the browser
   * fetches from api.ipify.org below and is wholly client-chosen — but it is
   * still best-effort, and the report itself is unverified: the endpoint cannot
   * be authenticated, so anyone who can reach it can forge one.
   *
   * ⚠️ This only sees failures that go through OUR UI. Credential stuffing
   * aimed straight at `/auth/v1/token` never calls this, so treat the table as
   * operational visibility, not as brute-force protection — that belongs to
   * Supabase Auth's Attack Protection settings.
   */
  const recordFailedLogin = async (email: string, reason: string) => {
    try {
      await supabase.functions.invoke('record-login-attempt', {
        body: { email, reason },
      });
    } catch (err) {
      // Never let reporting a failed login turn into a second failure the user
      // sees — they are already looking at "invalid email or password".
      console.warn('Failed to report login attempt:', err);
    }
  };

  /** Map a GoTrue error onto the reasons `record-login-attempt` accepts. */
  const classifyLoginError = (error: { code?: string; message?: string }): string => {
    const code = error.code;
    const message = (error.message ?? '').toLowerCase();
    if (code === 'user_banned' || message.includes('user is banned')) return 'user_banned';
    if (message.includes('invalid login credentials')) return 'invalid_credentials';
    return 'other';
  };

  const signIn = async (email: string, password: string) => {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    // A session that still owes a TOTP code is not a completed login: don't
    // record it yet (the MFA_CHALLENGE_VERIFIED handler above does that), and
    // tell the caller so it can show the challenge instead of proceeding.
    const mfaRequired = !error && isMfaPending(data?.session ?? null);

    // Record login history on successful sign-in
    if (!error && data?.user && !mfaRequired) {
      // Use setTimeout to not block the login flow
      setTimeout(() => {
        recordLoginHistory(data.user.id);
      }, 0);
    }

    // ...and record the failure otherwise. Same fire-and-forget shape: the
    // caller's error handling must not wait on, or be affected by, reporting.
    if (error) {
      setTimeout(() => {
        void recordFailedLogin(email, classifyLoginError(error));
      }, 0);
    }

    return { error, mfaRequired };
  };

  const signUp = async (email: string, password: string, fullName: string) => {
    const redirectUrl = `${window.location.origin}/`;

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: redirectUrl,
        data: {
          full_name: fullName,
        },
      },
    });
    return { error, data: data ? { user: data.user } : null };
  };

  const signOut = useCallback(async () => {
    setUser(null);
    setSession(null);
    setProfile(null);
    queryClient.clear();
    try { localStorage.removeItem(ACTIVITY_STORAGE_KEY); } catch { /* ignore */ }
    await supabase.auth.signOut({ scope: 'global' });
  }, [queryClient]);

  const handleInactivityLogout = useCallback(() => {
    try {
      sessionStorage.setItem(SIGNOUT_REASON_STORAGE_KEY, 'inactivity');
    } catch {
      // sessionStorage may be unavailable; query param still carries the reason
    }
    void signOut().finally(() => {
      window.location.assign('/auth?reason=inactivity');
    });
  }, [signOut]);

  useInactivityTimer({
    timeoutMs: INACTIVITY_TIMEOUT_MS,
    enabled: !!session,
    onTimeout: handleInactivityLogout,
  });

  const updatePassword = async (newPassword: string) => {
    const { error } = await supabase.auth.updateUser({
      password: newPassword,
    });
    return { error };
  };

  return (
    <AuthContext.Provider value={{ user, session, profile, loading, mfaChallengeRequired, signIn, signUp, signOut, updatePassword }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
