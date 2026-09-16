-- Drop the prompt-management tables. They had zero live readers.
--
-- Background: prompts are defined in code (`supabase/functions/_shared/prompts/*.ts`,
-- 24 templates passed to the OpenAI client as `promptText`). These tables were an
-- alternative path resolving a `prompt_key` to an OpenAI saved prompt (`pmpt_*`)
-- via `_shared/prompt-utils.ts` — but only three edge functions ever called it, and
-- all three were themselves unreachable:
--
--   * ta-agent-qa               — no caller anywhere; superseded by study-tutor /
--                                 socratic-chat (which is what ChatWidget drives)
--   * import-questions-from-pdf — no frontend trigger; its e2e test was already
--   * import-mcq-from-pdf         quarantined for exactly this reason
--
-- Of the 19 seeded prompt_defaults rows only 4 ever carried an openai_prompt_id,
-- and one of those (image_moderation) was read by nothing. The two keys the PDF
-- importers did look up (pdf_question_import, pdf_mcq_import) were never seeded,
-- so those lookups always missed and fell back to the hardcoded prompt.
--
-- Removed together with the three edge functions, `_shared/prompt-utils.ts` and
-- the /super-admin/prompts UI. Nothing reads these tables after that change.
--
-- Note: these tables referenced files uploaded to the OpenAI account —
-- prompt_examples.openai_file_id, plus the example_file_ids text[] columns on
-- prompt_defaults and institution_prompts. Those IDs are discarded here; any
-- such files remain in the OpenAI account and can be cleaned up there if desired.

DROP TABLE IF EXISTS public.prompt_audit_log;
DROP TABLE IF EXISTS public.prompt_examples;
DROP TABLE IF EXISTS public.institution_prompts;
DROP TABLE IF EXISTS public.prompt_defaults;
