import { describe, it, expect } from 'vitest';
import type { Session } from '@supabase/supabase-js';
import { getCurrentAal, hasVerifiedTotpFactor, isMfaPending } from '@/lib/mfa';

/** Build an unsigned JWT whose payload carries the given claims. */
function fakeJwt(claims: Record<string, unknown>): string {
  const encode = (obj: Record<string, unknown>) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${encode({ alg: 'none' })}.${encode(claims)}.sig`;
}

function fakeSession(opts: {
  aal?: string;
  factors?: Array<{ factor_type: string; status: string }>;
  accessToken?: string;
}): Session {
  return {
    access_token: opts.accessToken ?? fakeJwt({ aal: opts.aal ?? 'aal1' }),
    user: { id: 'u1', factors: opts.factors },
  } as unknown as Session;
}

const verifiedTotp = { factor_type: 'totp', status: 'verified' };
const unverifiedTotp = { factor_type: 'totp', status: 'unverified' };

describe('getCurrentAal', () => {
  it('reads aal1 and aal2 from the access token', () => {
    expect(getCurrentAal(fakeSession({ aal: 'aal1' }))).toBe('aal1');
    expect(getCurrentAal(fakeSession({ aal: 'aal2' }))).toBe('aal2');
  });

  it('returns null for a missing session or undecodable token', () => {
    expect(getCurrentAal(null)).toBeNull();
    expect(getCurrentAal(fakeSession({ accessToken: 'not-a-jwt' }))).toBeNull();
    expect(getCurrentAal(fakeSession({ accessToken: 'a.%%%.c' }))).toBeNull();
  });

  it('handles base64url payloads that need padding', () => {
    // Claim lengths chosen so the encoded payload is not a multiple of 4.
    expect(getCurrentAal(fakeSession({ aal: 'aal2', factors: undefined }))).toBe('aal2');
  });
});

describe('hasVerifiedTotpFactor', () => {
  it('is true only when a verified totp factor exists', () => {
    expect(hasVerifiedTotpFactor(fakeSession({ factors: [verifiedTotp] }))).toBe(true);
    expect(hasVerifiedTotpFactor(fakeSession({ factors: [unverifiedTotp] }))).toBe(false);
    expect(hasVerifiedTotpFactor(fakeSession({ factors: [] }))).toBe(false);
    expect(hasVerifiedTotpFactor(fakeSession({ factors: undefined }))).toBe(false);
    expect(hasVerifiedTotpFactor(null)).toBe(false);
  });

  it('ignores verified factors of other types', () => {
    expect(
      hasVerifiedTotpFactor(fakeSession({ factors: [{ factor_type: 'phone', status: 'verified' }] }))
    ).toBe(false);
  });
});

describe('isMfaPending', () => {
  it('is pending when a verified factor exists but the token is aal1', () => {
    expect(isMfaPending(fakeSession({ aal: 'aal1', factors: [verifiedTotp] }))).toBe(true);
  });

  it('is not pending once the token is aal2', () => {
    expect(isMfaPending(fakeSession({ aal: 'aal2', factors: [verifiedTotp] }))).toBe(false);
  });

  it('is not pending without a verified factor', () => {
    expect(isMfaPending(fakeSession({ aal: 'aal1', factors: [unverifiedTotp] }))).toBe(false);
    expect(isMfaPending(fakeSession({ aal: 'aal1' }))).toBe(false);
    expect(isMfaPending(null)).toBe(false);
  });

  it('fails open on an undecodable token: login gate, not security boundary', () => {
    expect(isMfaPending(fakeSession({ accessToken: 'garbage', factors: [verifiedTotp] }))).toBe(
      false
    );
  });
});
