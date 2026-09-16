-- A home for images an author drops into a rich-text editor.
--
-- The visual editor behind study-guide theory, test documents and cheat sheets
-- stores its output as an HTML string. An image inside that string has to be a
-- URL that keeps resolving for as long as the content does — which rules out
-- both of the shapes already in the codebase:
--
--   * a signed URL from a private bucket expires, and the HTML that embeds it
--     has no way to know it did. The image silently turns into a broken icon
--     weeks later, in front of the students it was drawn for.
--   * a `data:` URI needs no bucket, but the theory text is also what the
--     question generator is prompted with, so a base64 blob would be shipped
--     to the model on every regeneration and counted as tokens.
--
-- So: a public bucket, like `study-session-images` and `course-thumbnails`
-- before it. Public read is the point — the URL is baked into content that
-- outlives any session.
--
-- Writes are not public. Only instructors, admins and super-admins author
-- content, and each may only write under their own uid prefix, which is the
-- pattern `bug-reports` established.
--
-- `file_size_limit` and `allowed_mime_types` are set on the bucket rather than
-- trusted to the client. The editor already downscales and re-encodes before
-- uploading, but that is a UX affordance running in the browser; this is the
-- boundary. SVG is deliberately absent from the list — it is a scriptable
-- document, not an image, and this bucket serves what it is given.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'content-images',
  'content-images',
  true,
  5242880, -- 5 MB, comfortably above anything the editor's downscaler emits
  ARRAY['image/png', 'image/jpeg', 'image/webp', 'image/gif']
)
ON CONFLICT (id) DO UPDATE
SET public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

-- storage.foldername returns the path segments as text[], so [1] is the folder
-- the object sits in — here, the uploader's uid.
-- "May this user author content right now?" — asked by BOTH the INSERT and the
-- DELETE policy below.
--
-- It is a function rather than the same EXISTS written twice because the two
-- policies drifting apart is the specific failure mode here: the first draft
-- checked the role on the way in and only the uid prefix on the way out, so an
-- instructor demoted to student — or removed from the institution entirely —
-- kept the power to delete images still embedded in live study guides. Stating
-- the rule once makes that particular drift impossible rather than merely
-- fixed.
--
-- Suspension counts. `is_suspended` is the schema's "this membership is
-- switched off without being deleted" flag, and the membership-level helpers
-- that gate institution access — `is_institution_admin`,
-- `get_user_role_in_institution`, `user_belongs_to_institution` — all exclude
-- it. (`is_admin` and `is_institution_instructor` do not, which looks like an
-- oversight in those rather than a convention to copy.) A suspended instructor
-- publishing images into a public bucket, or deleting ones already embedded in
-- live study guides, is precisely what suspending them was meant to stop.
--
-- The check is per membership, not per user: someone suspended at one
-- institution but active at another is still an author, and the EXISTS finds
-- the row that is still live.
--
-- Deliberately NOT security definer: it must see exactly what the calling user
-- sees, which is the same visibility the inline predicate had.
CREATE OR REPLACE FUNCTION public.can_author_content(uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT public.is_super_admin(uid)
      OR EXISTS (
        SELECT 1 FROM public.user_institutions
        WHERE user_id = uid
          AND role IN ('instructor', 'admin')
          AND NOT is_suspended
      );
$$;

DROP POLICY IF EXISTS "Authors can upload their own content images" ON storage.objects;
CREATE POLICY "Authors can upload their own content images"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'content-images'
    AND (storage.foldername(name))[1] = auth.uid()::text
    AND public.can_author_content(auth.uid())
  );

-- Read is open, matching the bucket's public flag. Without this the REST
-- download/list paths refuse what the public URL already serves.
DROP POLICY IF EXISTS "Anyone can view content images" ON storage.objects;
CREATE POLICY "Anyone can view content images"
  ON storage.objects
  FOR SELECT
  USING (bucket_id = 'content-images');

-- An author may clear up their own uploads. Nobody sweeps this bucket: an
-- image whose <img> tag was deleted from the HTML stays, because the same
-- image may be embedded in another piece of content that is still live.
--
-- Which is exactly why the role is re-checked on the way out and not only the
-- uid prefix. The uid is permanent; authorship is not. Someone who has been
-- demoted or removed from the institution still owns the prefix their old
-- uploads sit under, and those images are load-bearing in study guides the
-- institution is still teaching from.
DROP POLICY IF EXISTS "Authors can delete their own content images" ON storage.objects;
CREATE POLICY "Authors can delete their own content images"
  ON storage.objects
  FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'content-images'
    AND (storage.foldername(name))[1] = auth.uid()::text
    AND public.can_author_content(auth.uid())
  );
