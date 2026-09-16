-- Per-school AI feature toggles (compliance redline G8).
--
-- Schools have different comfort levels with AI. This column lets an
-- institution's own admin switch off whole AI feature families for their
-- school; every OpenAI entry point checks it (see _shared/ai-feature-gate.ts)
-- before a request leaves the platform. The families mirror the
-- model-policy key namespaces:
--
--   'tutoring'   — the pupil-facing tutors and session suggestions
--   'grading'    — AI grading and answer validation
--   'analytics'  — evaluations, timelines, clustering, quiz/guide analysis
--   'generation' — question/material/study-guide generation
--
-- Deliberately NOT toggleable: moderation.* (safety screening is not a
-- feature a school opts out of) and the study-image safety check.
--
-- Unlike `openai_store_enabled` (super-admin-only, trigger-guarded), this
-- column is meant to be written by the institution's admin: the existing
-- "Admins can update their institution" UPDATE policy covers it, and every
-- institution member can read it ("Users can view their institutions"), so
-- the frontend can hide what the school switched off. The guard trigger
-- `trg_guard_openai_store_enabled` only fires on changes to its own column,
-- so admin updates here pass through it untouched.

ALTER TABLE public.institutions
  ADD COLUMN ai_features_disabled jsonb NOT NULL DEFAULT '[]'::jsonb
  CONSTRAINT institutions_ai_features_disabled_valid CHECK (
    jsonb_typeof(ai_features_disabled) = 'array'
    AND ai_features_disabled <@ '["tutoring","grading","analytics","generation"]'::jsonb
  );

COMMENT ON COLUMN public.institutions.ai_features_disabled IS
  'AI feature families this school has switched off: subset of ["tutoring","grading","analytics","generation"]. Written by the institution''s own admins; enforced server-side in _shared/ai-feature-gate.ts before any OpenAI request. Safety screening (moderation.*) is not toggleable.';
