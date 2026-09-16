-- Greek translations for default horizontal competencies + auto-seed trigger.
--
-- Three pieces:
--   1. seed_default_horizontal_competencies(inst_id) — reusable seeder that
--      reads institutions.default_language and inserts the four defaults in
--      the matching language, then enables every grade level.
--   2. Backfill: rewrite existing English default rows to Greek when the
--      parent institution has default_language = 'el'. Idempotent: gated on
--      the current title matching the original English default, so re-runs
--      and admin-edited rows are skipped.
--   3. AFTER INSERT trigger on institutions so future institutions get seeded
--      automatically. Closes the gap that the original seed in
--      20260426000000_horizontal_competencies.sql only ran once for
--      institutions that existed at migration time.

CREATE OR REPLACE FUNCTION public.seed_default_horizontal_competencies(inst_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  lang text;
BEGIN
  SELECT default_language INTO lang
  FROM public.institutions
  WHERE id = inst_id;

  IF lang IS NULL THEN
    lang := 'en';
  END IF;

  IF lang = 'el' THEN
    INSERT INTO public.horizontal_competencies
      (institution_id, title, description, is_default, order_num)
    VALUES
      (inst_id, 'Επίλυση Προβλημάτων',
        'Ικανότητα προσέγγισης προβλημάτων με δομημένο και αποτελεσματικό τρόπο, αναλύοντάς τα σε βήματα και προχωρώντας λογικά προς τη λύση',
        true, 0),
      (inst_id, 'Λογική Σκέψη',
        'Ικανότητα εξαγωγής ορθών συμπερασμάτων από δεδομένες πληροφορίες, εφαρμόζοντας τη λογική με συνέπεια και αποφεύγοντας άκυρες παραδοχές',
        true, 1),
      (inst_id, 'Εννοιολογική Κατανόηση',
        'Βάθος κατανόησης των υποκείμενων ιδεών, που αποδεικνύεται με την εφαρμογή της γνώσης σε νέες καταστάσεις αντί της εξάρτησης από απομνημονευμένα μοτίβα',
        true, 2),
      (inst_id, 'Ανίχνευση & Διόρθωση Σφαλμάτων',
        'Ικανότητα αναγνώρισης λαθών, κατανόησης του λόγου εμφάνισής τους και αποτελεσματικής βελτίωσης ή διόρθωσής τους',
        true, 3)
    ON CONFLICT (institution_id, lower(btrim(title))) DO NOTHING;
  ELSE
    INSERT INTO public.horizontal_competencies
      (institution_id, title, description, is_default, order_num)
    VALUES
      (inst_id, 'Problem Solving',
        'Ability to approach problems in a structured and effective way, breaking them into steps and progressing logically toward a solution',
        true, 0),
      (inst_id, 'Reasoning',
        'Ability to draw correct conclusions from given information, applying logic consistently and avoiding invalid assumptions',
        true, 1),
      (inst_id, 'Conceptual Understanding',
        'Depth of understanding of underlying ideas, shown by applying knowledge to new situations rather than relying on memorized patterns',
        true, 2),
      (inst_id, 'Error Detection & Correction',
        'Ability to recognize mistakes, understand why they occurred, and improve or correct them effectively',
        true, 3)
    ON CONFLICT (institution_id, lower(btrim(title))) DO NOTHING;
  END IF;

  INSERT INTO public.horizontal_competency_grades (competency_id, grade_level)
  SELECT hc.id, g.grade_level
  FROM public.horizontal_competencies hc
  CROSS JOIN (VALUES
    ('dimotiko_1'),('dimotiko_2'),('dimotiko_3'),('dimotiko_4'),('dimotiko_5'),('dimotiko_6'),
    ('gymnasio_1'),('gymnasio_2'),('gymnasio_3'),
    ('lykeio_1'),('lykeio_2'),('lykeio_3')
  ) AS g(grade_level)
  WHERE hc.institution_id = inst_id AND hc.is_default = true
  ON CONFLICT DO NOTHING;
END;
$$;

GRANT EXECUTE ON FUNCTION public.seed_default_horizontal_competencies(uuid)
  TO service_role;

-- Backfill existing English default rows for Greek institutions. Idempotent:
-- only rewrites rows whose current title still matches the original English
-- default, so rows admins have already renamed are left alone. The WHERE
-- NOT EXISTS guard prevents the UPDATE from colliding with a pre-existing
-- Greek row (e.g. if the seed function already ran for this institution).

DO $$
DECLARE
  skipped_institution uuid;
BEGIN
  FOR skipped_institution IN
    SELECT DISTINCT i.id
    FROM public.institutions i
    JOIN public.horizontal_competencies hc ON hc.institution_id = i.id
    WHERE i.default_language = 'el'
      AND hc.is_default = true
      AND hc.title NOT IN (
        'Problem Solving','Reasoning','Conceptual Understanding','Error Detection & Correction',
        'Επίλυση Προβλημάτων','Λογική Σκέψη','Εννοιολογική Κατανόηση','Ανίχνευση & Διόρθωση Σφαλμάτων'
      )
  LOOP
    RAISE NOTICE 'Institution % has admin-edited default horizontal competencies; Greek backfill skipped. Review manually.', skipped_institution;
  END LOOP;
END $$;

UPDATE public.horizontal_competencies hc
SET title = 'Επίλυση Προβλημάτων',
    description = 'Ικανότητα προσέγγισης προβλημάτων με δομημένο και αποτελεσματικό τρόπο, αναλύοντάς τα σε βήματα και προχωρώντας λογικά προς τη λύση',
    updated_at = now()
FROM public.institutions i
WHERE hc.institution_id = i.id
  AND i.default_language = 'el'
  AND hc.is_default = true
  AND hc.title = 'Problem Solving'
  AND NOT EXISTS (
    SELECT 1 FROM public.horizontal_competencies hc2
    WHERE hc2.institution_id = hc.institution_id
      AND hc2.id <> hc.id
      AND lower(btrim(hc2.title)) = lower(btrim('Επίλυση Προβλημάτων'))
  );

UPDATE public.horizontal_competencies hc
SET title = 'Λογική Σκέψη',
    description = 'Ικανότητα εξαγωγής ορθών συμπερασμάτων από δεδομένες πληροφορίες, εφαρμόζοντας τη λογική με συνέπεια και αποφεύγοντας άκυρες παραδοχές',
    updated_at = now()
FROM public.institutions i
WHERE hc.institution_id = i.id
  AND i.default_language = 'el'
  AND hc.is_default = true
  AND hc.title = 'Reasoning'
  AND NOT EXISTS (
    SELECT 1 FROM public.horizontal_competencies hc2
    WHERE hc2.institution_id = hc.institution_id
      AND hc2.id <> hc.id
      AND lower(btrim(hc2.title)) = lower(btrim('Λογική Σκέψη'))
  );

UPDATE public.horizontal_competencies hc
SET title = 'Εννοιολογική Κατανόηση',
    description = 'Βάθος κατανόησης των υποκείμενων ιδεών, που αποδεικνύεται με την εφαρμογή της γνώσης σε νέες καταστάσεις αντί της εξάρτησης από απομνημονευμένα μοτίβα',
    updated_at = now()
FROM public.institutions i
WHERE hc.institution_id = i.id
  AND i.default_language = 'el'
  AND hc.is_default = true
  AND hc.title = 'Conceptual Understanding'
  AND NOT EXISTS (
    SELECT 1 FROM public.horizontal_competencies hc2
    WHERE hc2.institution_id = hc.institution_id
      AND hc2.id <> hc.id
      AND lower(btrim(hc2.title)) = lower(btrim('Εννοιολογική Κατανόηση'))
  );

UPDATE public.horizontal_competencies hc
SET title = 'Ανίχνευση & Διόρθωση Σφαλμάτων',
    description = 'Ικανότητα αναγνώρισης λαθών, κατανόησης του λόγου εμφάνισής τους και αποτελεσματικής βελτίωσης ή διόρθωσής τους',
    updated_at = now()
FROM public.institutions i
WHERE hc.institution_id = i.id
  AND i.default_language = 'el'
  AND hc.is_default = true
  AND hc.title = 'Error Detection & Correction'
  AND NOT EXISTS (
    SELECT 1 FROM public.horizontal_competencies hc2
    WHERE hc2.institution_id = hc.institution_id
      AND hc2.id <> hc.id
      AND lower(btrim(hc2.title)) = lower(btrim('Ανίχνευση & Διόρθωση Σφαλμάτων'))
  );

-- AFTER INSERT trigger so newly-created institutions get defaults seeded
-- automatically, in the institution's chosen default_language.

CREATE OR REPLACE FUNCTION public.tg_seed_horizontal_competencies_on_institution()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.seed_default_horizontal_competencies(NEW.id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS seed_horizontal_competencies_on_institution ON public.institutions;
CREATE TRIGGER seed_horizontal_competencies_on_institution
AFTER INSERT ON public.institutions
FOR EACH ROW
EXECUTE FUNCTION public.tg_seed_horizontal_competencies_on_institution();
