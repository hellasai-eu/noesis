import { Sparkles } from "lucide-react";

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * Transparency notice for AI-generated content shown to students (issue #936).
 *
 * The EU AI Act's Art. 50 transparency duty is owed to the person reading the
 * output, and the people reading these surfaces are Greek secondary-school
 * students and their parents. So the notice is bilingual and always says both
 * halves of the same thing: a machine wrote this, and the teacher — not the
 * machine — is the authority on the grade.
 *
 * Both languages render together rather than behind a toggle. There is no i18n
 * framework in the app, so a toggle would mean inventing per-user language
 * state for one sentence; and a notice that has to be switched on is a notice
 * some readers never see. The Greek line leads because it binds.
 *
 * Never render this on human-authored content — an instructor's own question,
 * or an evaluation an instructor overrode (`is_manual`). Labelling a teacher's
 * words as machine output is the same transparency failure in reverse.
 *
 * Which is why there are two wordings rather than one. Some surfaces are
 * unambiguously the model's: a tutor's reply, a generated summary.
 * Others start as the model's and can be rewritten in place by an instructor —
 * `material_chapters.cheat_sheet` through the cheat-sheet editor,
 * `study_guide_pieces.theory_html` and a question's `explanation` through the
 * piece editor. Neither table records who last wrote the column, so on those
 * surfaces the honest claim is the weaker one: made by a machine, possibly
 * edited by your teacher, still capable of being wrong.
 *
 * Adding a provenance column would let them all use the strong wording. Until
 * one exists, `source` is how a caller says which claim it can actually stand
 * behind — and a caller that has to think about it is the point.
 */

/** Greek is the binding text for Greek schools; English is the reference. */
export const AI_DISCLAIMER_EL =
  "Παράγεται από τεχνητή νοημοσύνη και ενδέχεται να περιέχει λάθη — απευθυνθείτε στον καθηγητή σας.";
export const AI_DISCLAIMER_EN =
  "AI-generated and may contain errors — your teacher has the final say.";

/** For content the model wrote and an instructor may since have rewritten. */
export const AI_DISCLAIMER_MIXED_EL =
  "Δημιουργήθηκε με τεχνητή νοημοσύνη και μπορεί να έχει επεξεργαστεί από τον καθηγητή σας — ενδέχεται να περιέχει λάθη.";
export const AI_DISCLAIMER_MIXED_EN =
  "Created with AI and may have been edited by your teacher — it may contain errors.";

/**
 * The extra sentence for a surface that shows a score or a judgement about the
 * student, rather than generated study material.
 *
 * "The teacher has the final say" tells a student who to argue with. It does
 * not tell anyone what the output is *for*, and that is the question the EU AI
 * Act's Annex III turns on: a system evaluating learning outcomes is high-risk
 * precisely because those outcomes get used to decide things about the person.
 * Saying plainly that these scores are formative — not a basis for official
 * marks, promotion, placement or admission — is the boundary the platform asks
 * schools to hold, and §9 of the operator's data-processing agreement makes it
 * a deployer obligation rather than a hope. (That template is not in this
 * repository — see `docs/compliance/README.md`.)
 *
 * Not merged into the base sentence: it is true of four surfaces, and putting
 * it on a flashcard would be noise that teaches students to stop reading the
 * notice.
 */
export const AI_FORMATIVE_NOTICE_EL =
  "Οι βαθμοί και οι αξιολογήσεις της τεχνητής νοημοσύνης έχουν διαμορφωτικό χαρακτήρα: δεν καθορίζουν επίσημους βαθμούς, προαγωγή, τοποθέτηση ή εισαγωγή. Την επίσημη αξιολόγηση την κάνει ο εκπαιδευτικός.";
export const AI_FORMATIVE_NOTICE_EN =
  "AI scores and assessments are formative: they do not determine official grades, promotion, placement or admission. Your teacher is responsible for formal assessment.";

export type AiDisclaimerVariant = "banner" | "compact" | "tooltip";

/**
 * `model` — the surface is model output and nothing else.
 * `model-or-teacher` — the model wrote it and an instructor can have edited it
 * in place, with no column recording which happened.
 */
export type AiDisclaimerSource = "model" | "model-or-teacher";

interface AiDisclaimerProps {
  /**
   * `banner` — a bordered notice, for a surface whose whole content is AI
   * output (a chat, a grade, an evaluation).
   * `compact` — one muted line, for placing under a heading or above a chat
   * input where a bordered box would crowd the surface.
   * `tooltip` — an icon that reveals the text on hover/focus, for dense rows
   * where there is no room for a sentence.
   */
  variant?: AiDisclaimerVariant;
  /** Which claim this surface can stand behind. Defaults to the strong one. */
  source?: AiDisclaimerSource;
  /**
   * True when the surface shows a score or a judgement about the student — a
   * grade, feedback on their answer, an evaluation. Adds the formative-use
   * sentence. Generated study material does not get it: a flashcard decides
   * nothing about anyone.
   */
  assessment?: boolean;
  className?: string;
}

const WORDING: Record<AiDisclaimerSource, { el: string; en: string }> = {
  model: { el: AI_DISCLAIMER_EL, en: AI_DISCLAIMER_EN },
  "model-or-teacher": { el: AI_DISCLAIMER_MIXED_EL, en: AI_DISCLAIMER_MIXED_EN },
};

export const AiDisclaimer = ({
  variant = "banner",
  source = "model",
  assessment = false,
  className,
}: AiDisclaimerProps) => {
  const { el, en } = WORDING[source];
  const formativeEl = assessment ? AI_FORMATIVE_NOTICE_EL : null;
  const formativeEn = assessment ? AI_FORMATIVE_NOTICE_EN : null;
  // Greek first, both sentences, then English — so a Greek reader gets the
  // whole notice before any English, rather than the two languages interleaved.
  const label = [el, formativeEl, en, formativeEn].filter(Boolean).join(" ");

  if (variant === "tooltip") {
    return (
      // Its own provider, so the notice can be dropped into any surface
      // without that surface having to know. A transparency notice that
      // throws because its host forgot a context is not a notice — and
      // nesting providers is supported (the nearest one wins).
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              data-testid="ai-disclaimer"
              data-variant="tooltip"
              // Focusable and labelled, so the notice is reachable without a
              // pointer — a hover-only disclaimer discloses nothing on a phone.
              tabIndex={0}
              role="note"
              aria-label={label}
              className={cn(
                "inline-flex items-center text-muted-foreground cursor-help align-middle",
                className,
              )}
            >
              <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            <p>{el}</p>
            {formativeEl && <p className="mt-1">{formativeEl}</p>}
            <p className="mt-1 opacity-80">{en}</p>
            {formativeEn && <p className="mt-1 opacity-80">{formativeEn}</p>}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  if (variant === "compact") {
    return (
      <p
        data-testid="ai-disclaimer"
        data-variant="compact"
        role="note"
        className={cn(
          "flex items-start gap-1.5 text-xs leading-snug text-muted-foreground",
          className,
        )}
      >
        <Sparkles className="h-3 w-3 mt-0.5 shrink-0" aria-hidden="true" />
        {/*
          No `opacity-80` on the English here, unlike the banner and the
          tooltip. `text-muted-foreground` is already the dimmest readable
          token: on `--card` it measures 5.20:1 in light and 5.66:1 in dark,
          and dimming it another 20% drops it to 3.46:1 and 4.10:1 — under the
          4.5:1 WCAG AA needs for text this size. The banner can afford the
          same treatment because it starts from amber-900 on a tinted panel
          (8.41:1, still 5.11:1 after dimming), and the tooltip because it
          starts from popover-foreground (16.9:1).

          This variant is the one on both tutor chats, so it is the notice most
          students actually read. Greek still leads by position; it does not
          need the English to be harder to read to do that.
        */}
        <span>
          {el}
          {formativeEl ? ` ${formativeEl}` : ""} {en}
          {formativeEn ? ` ${formativeEn}` : ""}
        </span>
      </p>
    );
  }

  return (
    <div
      data-testid="ai-disclaimer"
      data-variant="banner"
      role="note"
      className={cn(
        "flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200",
        className,
      )}
    >
      <Sparkles className="h-4 w-4 mt-px shrink-0" aria-hidden="true" />
      <span>
        {el}
        {formativeEl && <> {formativeEl}</>}
        <br />
        <span className="opacity-80">
          {en}
          {formativeEn && <> {formativeEn}</>}
        </span>
      </span>
    </div>
  );
};

export default AiDisclaimer;
