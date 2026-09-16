-- Repair fill-the-gaps stems that mark their blanks with `___` instead of the
-- `{{N}}` placeholders every renderer splits on (#1035).
--
-- The study guide question schema used to instruct the model to write each gap
-- as `___`, so it did. Nothing validated the stem on write, and the renderer
-- fails silently on a stem with no placeholders: it draws zero inputs, and the
-- markdown pass in `processLatexContent` consumes `___` as bold-italic, so the
-- orphaned markers do not even show up as stray characters. The result is a
-- question that looks normal, cannot be answered, and — because a study guide
-- piece only submits once every question is answered — locks every later piece
-- of the guide behind it.
--
-- The prompt, the schema description and the converter are fixed in code; this
-- migration repairs the rows already stored. Nothing here can invalidate a
-- student answer: these questions were unanswerable, so none exists.
--
-- Idempotent: a repaired stem contains `{{`, which the WHERE clause excludes.

DO $$
DECLARE
  r            RECORD;
  new_stem     TEXT;
  run_count    INT;
  gap_ordinals INT[];
  i            INT;
  repaired     INT := 0;
  skipped      INT := 0;
BEGIN
  FOR r IN
    SELECT
      q.id,
      q.answer_key,
      q.payload ->> 'stem' AS stem,
      jsonb_array_length(q.answer_key -> 'gaps') AS gap_count
    FROM public.questions q
    WHERE q.type = 'fill_gaps'
      AND q.payload ->> 'stem' IS NOT NULL
      AND q.payload ->> 'stem' NOT LIKE '%{{%'
      AND jsonb_typeof(q.answer_key -> 'gaps') = 'array'
      AND jsonb_array_length(q.answer_key -> 'gaps') > 0
  LOOP
    -- Runs of two or more underscores are the blank markers. A single `_` is
    -- left alone: it is a LaTeX subscript (`$x_0$`), which these stems contain.
    SELECT count(*) INTO run_count
    FROM regexp_matches(r.stem, '_{2,}', 'g');

    -- Only rewrite when the markers and the answer key agree exactly, and the
    -- key is the contiguous 1..N the converter produces. Anything else is
    -- guesswork about which blank takes which answer, and a mis-paired answer
    -- key is worse than a question the student is told to report: the frontend
    -- guard shows an alert for whatever this leaves behind.
    SELECT array_agg((g ->> 'ordinal')::int ORDER BY (g ->> 'ordinal')::int)
      INTO gap_ordinals
    FROM jsonb_array_elements(r.answer_key -> 'gaps') AS g;

    IF run_count <> r.gap_count THEN
      skipped := skipped + 1;
      RAISE NOTICE 'fill_gaps question % left as-is: % underscore run(s) vs % gap(s)',
        r.id, run_count, r.gap_count;
      CONTINUE;
    END IF;

    IF gap_ordinals IS DISTINCT FROM ARRAY(SELECT generate_series(1, r.gap_count)) THEN
      skipped := skipped + 1;
      RAISE NOTICE 'fill_gaps question % left as-is: answer key ordinals % are not 1..%',
        r.id, gap_ordinals, r.gap_count;
      CONTINUE;
    END IF;

    -- Replace the runs left to right. The replacement holds no underscores, so
    -- each un-flagged regexp_replace hits the next original run.
    new_stem := r.stem;
    FOR i IN 1..r.gap_count LOOP
      new_stem := regexp_replace(new_stem, '_{2,}', '{{' || i || '}}');
    END LOOP;

    UPDATE public.questions
    SET payload = jsonb_set(payload, '{stem}', to_jsonb(new_stem))
    WHERE id = r.id;

    repaired := repaired + 1;
  END LOOP;

  RAISE NOTICE 'fill_gaps stem repair: % repaired, % left for an instructor to remove',
    repaired, skipped;
END $$;
