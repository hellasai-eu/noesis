-- Every pending invitation was readable by anyone, unauthenticated (#1173).
--
-- `20260109095706` added, in its entirety:
--
--     CREATE POLICY "Pending invitations can be viewed by email"
--     ON public.invitations FOR SELECT
--     USING ( status = 'pending' );
--
-- The name says "by email". The predicate does not mention email, and the
-- policy has no TO clause, so it applied to PUBLIC — which includes `anon`.
-- One request carrying only the anon key that ships in the frontend bundle
-- returned every pending invitation in the database: invitee address, full
-- name, assigned role, institution and course, across every tenant. Verified
-- against the live API, not inferred.
--
-- The intended caller is `src/pages/Auth.tsx`, which narrows with
-- `.eq("institution_id", ...).eq("email", ...).eq("status", "pending")` before
-- signup. Those are client-side query filters. RLS cannot see them, and an
-- attacker simply omits them.
--
-- The read genuinely has to work for someone with no account — that is the
-- whole point of an invitation link — so this cannot be fixed by requiring
-- authentication. It is fixed by moving the narrowing to where the caller
-- cannot remove it: a function that takes the two identifiers the link already
-- carries and returns at most the single row they name.

CREATE OR REPLACE FUNCTION public.get_pending_invitation(
  _token uuid,
  _email text
)
RETURNS TABLE (
  id uuid,
  email text,
  institution_id uuid,
  institution_name text,
  role text,
  invited_name text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT i.id, i.email, i.institution_id, inst.name, i.role, i.invited_name
  FROM public.invitations i
  LEFT JOIN public.institutions inst ON inst.id = i.institution_id
  WHERE i.status = 'pending'
    AND lower(i.email) = lower(_email)
    AND (i.id = _token OR i.institution_id = _token)
  ORDER BY i.created_at DESC
  LIMIT 1;
$$;

-- `_token` accepts EITHER identifier because the two senders disagree about
-- which one they put in the link, and both kinds are already in people's
-- inboxes:
--
--   send-invitation/handler.ts:208   ?invitation=<institution_id>
--   bulk-invite-users/handler.ts:389 ?invitation=<invitation.id>
--
-- `Auth.tsx` only ever matched on `institution_id`, so links from the bulk
-- sender have never resolved — they show "Invalid or expired invitation".
-- Accepting either identifier is what lets this function serve both, and fixes
-- that as a side effect. An invitation id is the better of the two: it is an
-- unguessable uuid, so such a link is a capability, whereas institution id plus
-- address is guessable by anyone who has both.
--
-- `ORDER BY created_at DESC LIMIT 1` is ordered on purpose. The same address
-- can hold two pending invitations to one institution — invite, then re-invite
-- — and a bare LIMIT 1 would return an arbitrary one, which is exactly the
-- nondeterminism finding 1 of #947 was about. Newest wins.
--
-- Email is matched case-insensitively. `invitations.email` stores whatever case
-- the admin typed (UserManagement.tsx) while the auth record is lowercased, so
-- an exact match left `First_Last@…` unresolvable. `erase_user_unlinked_data`
-- already had to learn this. `lower() = lower()` and not ILIKE: the address is
-- data, not a pattern, and `_` in an ILIKE pattern is a wildcard that would
-- match `firstXlast@…` too (20260726010000).
--
-- What this still discloses, deliberately: someone who supplies a valid
-- (identifier, address) pair learns that the pair has a pending invitation, and
-- gets the invitee's name, role and institution. That is the minimum the signup
-- screen needs in order to say "Join <Institution>" and prefill the form. It is
-- an oracle for a guessed pair, not an enumeration: no query returns a row the
-- caller could not already name, and nothing returns a list.

REVOKE ALL ON FUNCTION public.get_pending_invitation(uuid, text) FROM PUBLIC;
-- anon by necessity: the caller has no account yet. That is the entire reason
-- the old policy existed, and the difference is that this grant hands out one
-- named row instead of the table.
GRANT EXECUTE ON FUNCTION public.get_pending_invitation(uuid, text)
  TO anon, authenticated;

COMMENT ON FUNCTION public.get_pending_invitation(uuid, text) IS
  'Resolve ONE pending invitation from the (identifier, email) pair an invitation '
  'link carries, for a caller who has no account yet. SECURITY DEFINER because '
  'public.invitations has no anon-readable policy by design — see #1173, where '
  'the policy that did allow it exposed every pending invitation in the database '
  'to any unauthenticated caller. _token matches either invitations.id or '
  'invitations.institution_id, because the two invitation senders disagree.';

-- `invitation_courses` was leaning on the leak.
--
-- Its SELECT policy asks whether the caller shares an institution with the
-- parent invitation:
--
--     EXISTS (SELECT 1 FROM invitations i
--               JOIN user_institutions ui ON ui.institution_id = i.institution_id
--              WHERE i.id = invitation_courses.invitation_id
--                AND ui.user_id = auth.uid())
--
-- A subquery inside a policy is itself subject to the inner table's RLS, so
-- that EXISTS could only ever see `invitations` rows the caller was allowed to
-- read — and for an ordinary institution member, who is neither an admin nor
-- the invitee, the ONLY thing granting that was the blanket policy below.
-- Dropping it therefore silently revokes a documented behaviour, caught by
-- "institution member reads the course scoping of their institution's
-- invitations" in quiz-internals-and-remaining-tables.test.ts.
--
-- The behaviour is intended, so it is preserved — but by asking the question
-- directly rather than by leaving the whole table readable to get at one row of
-- it. SECURITY DEFINER, like every other predicate helper here
-- (`has_offering_access`, `is_institution_admin`, `user_belongs_to_institution`
-- are all definer with a pinned search_path).

CREATE OR REPLACE FUNCTION public.invitation_shares_my_institution(_invitation_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.invitations i
    JOIN public.user_institutions ui ON ui.institution_id = i.institution_id
    WHERE i.id = _invitation_id
      AND ui.user_id = auth.uid()
  );
$$;

REVOKE ALL ON FUNCTION public.invitation_shares_my_institution(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.invitation_shares_my_institution(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.invitation_shares_my_institution(uuid) TO authenticated;

COMMENT ON FUNCTION public.invitation_shares_my_institution(uuid) IS
  'Does the calling user belong to the institution of this invitation? '
  'SECURITY DEFINER so the invitation_courses policy can ask without '
  'public.invitations being readable — see #1173. Not granted to anon: an '
  'unauthenticated caller has no institutions, so it could only ever answer '
  'false, and granting it would hand out one more oracle for nothing.';

DROP POLICY IF EXISTS "Institution members can view invitation courses" ON public.invitation_courses;
CREATE POLICY "Institution members can view invitation courses"
  ON public.invitation_courses
  FOR SELECT
  TO authenticated
  USING (public.invitation_shares_my_institution(invitation_id));

-- The policy this replaces.
DROP POLICY IF EXISTS "Pending invitations can be viewed by email" ON public.invitations;

-- What remains on `invitations` after this:
--
--   Users can view invitations       SELECT  admins of the institution, super
--                                            admins, or auth.jwt()->>'email'
--                                            matching the row — all authenticated
--   Users can accept their own invitation
--                                    UPDATE  TO authenticated, own address only
--   Admins can create/update/delete  INSERT/UPDATE/DELETE
--
-- No SELECT policy admits `anon` any more. The only unauthenticated read path
-- is the function above.
