/**
 * Controlled, presentation-only per-type answer fields (#980).
 *
 * These are the codebase's single source of truth for rendering a student's
 * answer surface for each unified question type. Every field is fully
 * controlled (`value` / change callback + `disabled` + `reveal`) and computes
 * NO grade and does NO persistence — the parent owns state, grading and
 * submission. That makes them reusable across both the formal quiz flow
 * (`StudentQuiz`) and the sequential study-guide player.
 *
 * `reveal` switches a field into read-only review mode: inputs lock and, where
 * a field has correctness to show (mcq / fill_gaps / ordering / classification),
 * per-answer correct/incorrect marks appear. `open` has no deterministic key,
 * so its reveal is simply the submitted text, read-only.
 *
 * Extracted verbatim from the inline `StudentQuiz` components (#820/#829) so
 * there is one implementation; the only shape change is that `ClassificationField`
 * takes explicit `categories` / `items` / `assignments` props instead of a whole
 * `question` object, so it does not depend on `StudentQuiz`'s local type.
 */
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle, XCircle, AlertTriangle, GripVertical } from "lucide-react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { seededShuffle } from "@/lib/seeded-shuffle";
import { processLatexContent } from "@/lib/latex-utils";

// ---------------------------------------------------------------------------
// MCQ
// ---------------------------------------------------------------------------

/**
 * Controlled MCQ options grid (incl. multi-correct). Clicks toggle option
 * membership and are blocked only by `disabled` — NOT by `reveal` — so a
 * caller that lets the student revise an answer after seeing the result (the
 * quiz "go back" path) keeps working; a caller that wants immutability simply
 * sets `disabled` once submitted. `canShowCorrectness` gates the green/red
 * marks so a formal quiz with answers withheld can reveal only the selection.
 */
export function McqField({
  options,
  correctIndices,
  value,
  onToggle,
  disabled,
  reveal,
  canShowCorrectness = true,
}: {
  options: string[];
  correctIndices: number[];
  value: number[];
  onToggle: (index: number) => void;
  disabled: boolean;
  reveal: boolean;
  canShowCorrectness?: boolean;
}) {
  return (
    <div className="space-y-3">
      {options.map((option, index) => {
        const isSelected = value.includes(index);
        const isCorrect = correctIndices.includes(index);

        let optionClass =
          "border rounded-xl p-4 cursor-pointer transition-all flex items-center gap-4";
        if (reveal) {
          if (canShowCorrectness) {
            if (isCorrect) {
              optionClass += " border-green-500 bg-green-500/10";
            } else if (isSelected && !isCorrect) {
              optionClass += " border-red-500 bg-red-500/10";
            } else {
              optionClass += " border-border opacity-50";
            }
          } else if (isSelected) {
            optionClass += " border-primary bg-primary/5";
          } else {
            optionClass += " border-border opacity-50";
          }
        } else if (isSelected) {
          optionClass += " border-primary bg-primary/5 ring-2 ring-primary/20";
        } else {
          optionClass += " border-border hover:border-primary/50 hover:bg-secondary/50";
        }

        return (
          <div
            key={index}
            role="checkbox"
            aria-checked={isSelected}
            className={optionClass}
            onClick={() => {
              if (disabled) return;
              onToggle(index);
            }}
          >
            <span
              className={`w-6 h-6 rounded-md border-2 flex items-center justify-center text-sm font-medium flex-shrink-0 ${
                isSelected
                  ? "bg-primary border-primary text-primary-foreground"
                  : "border-muted-foreground/30"
              }`}
              aria-hidden="true"
            >
              {isSelected && <CheckCircle className="w-4 h-4" />}
            </span>
            <span className="w-8 h-8 rounded-full border-2 flex items-center justify-center text-sm font-medium flex-shrink-0">
              {String.fromCharCode(65 + index)}
            </span>
            <span
              className="flex-1 text-left"
              dangerouslySetInnerHTML={{ __html: processLatexContent(option) }}
            />
            {reveal && canShowCorrectness && isCorrect && (
              <CheckCircle className="w-6 h-6 text-green-500" />
            )}
            {reveal && canShowCorrectness && isSelected && !isCorrect && (
              <XCircle className="w-6 h-6 text-red-500" />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Controlled classification surface. Renders each card (deterministically
 * shuffled per student/question) with a row of category buttons; the student
 * taps the bucket a card belongs to. When `reveal` is true, per-item
 * correctness is shown and edits are locked.
 */
export function ClassificationField({
  questionId,
  categories,
  items,
  assignments,
  userId,
  value,
  onSelect,
  disabled,
  reveal,
}: {
  questionId: string;
  categories: { id: string; label: string }[];
  items: { id: string; text: string }[];
  assignments: Record<string, string>;
  userId: string;
  value: Record<string, string>;
  onSelect: (itemId: string, categoryId: string) => void;
  disabled: boolean;
  reveal: boolean;
}) {
  const { t } = useTranslation("quiz");
  const shuffledItems = useMemo(() => {
    return userId ? seededShuffle(items, `${questionId}::${userId}`) : items;
  }, [items, questionId, userId]);

  if (shuffledItems.length === 0 || categories.length === 0) {
    return (
      <Alert className="border-amber-500/30 bg-amber-500/5">
        <AlertTriangle className="h-4 w-4 text-amber-600" />
        <AlertDescription className="text-sm">
          {t("fields.classificationBroken")}
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-3" role="group" aria-label={t("fields.classificationGroup")}>
      {shuffledItems.map((item) => {
        const selectedCategory = value[item.id];
        const correctCategory = assignments[item.id];
        const itemCorrect = reveal && selectedCategory === correctCategory;
        const itemMissed = reveal && !selectedCategory;
        const itemWrong = reveal && !!selectedCategory && selectedCategory !== correctCategory;
        return (
          <div
            key={item.id}
            className={`border rounded-xl p-4 space-y-3 transition-colors ${
              itemCorrect
                ? "border-green-500 bg-green-500/10"
                : itemWrong || itemMissed
                  ? "border-red-500 bg-red-500/10"
                  : "border-border"
            }`}
          >
            <div className="flex items-center justify-between gap-3">
              <span
                className="flex-1 font-medium"
                dangerouslySetInnerHTML={{ __html: processLatexContent(item.text) }}
              />
              {itemCorrect && <CheckCircle className="w-5 h-5 text-green-500 flex-shrink-0" />}
              {(itemWrong || itemMissed) && <XCircle className="w-5 h-5 text-red-500 flex-shrink-0" />}
            </div>
            <div
              className="flex flex-wrap gap-2"
              role="radiogroup"
              aria-label={item.text}
            >
              {categories.map((cat) => {
                const isSelected = selectedCategory === cat.id;
                const isCorrectBucket = reveal && correctCategory === cat.id;
                let btnClass =
                  "px-3 py-2 rounded-lg border text-sm font-medium transition-all";
                if (isCorrectBucket) {
                  btnClass += " border-green-500 bg-green-500/10 text-green-700 dark:text-green-400";
                } else if (isSelected) {
                  btnClass += reveal
                    ? " border-red-500 bg-red-500/10 text-red-700 dark:text-red-400"
                    : " border-primary bg-primary/5 ring-2 ring-primary/20";
                } else {
                  btnClass += " border-border hover:border-primary/50 hover:bg-secondary/50";
                }
                return (
                  <button
                    key={cat.id}
                    type="button"
                    role="radio"
                    aria-checked={isSelected}
                    disabled={disabled || reveal}
                    onClick={() => onSelect(item.id, cat.id)}
                    className={btnClass}
                    dangerouslySetInnerHTML={{ __html: processLatexContent(cat.label) }}
                  />
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

/** One draggable row of the ordering surface; marks correctness on `reveal`. */
function OrderingSortableRow({
  uid,
  index,
  disabled,
  reveal,
  isCorrect,
}: {
  uid: string;
  index: number;
  disabled: boolean;
  reveal: boolean;
  isCorrect: boolean | null;
}) {
  const { t } = useTranslation("quiz");
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: uid, disabled });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex items-center gap-3 rounded-xl border p-4 bg-background ${
        reveal
          ? isCorrect
            ? "border-green-500 bg-green-500/10"
            : "border-red-500 bg-red-500/10"
          : "border-border"
      }`}
    >
      <button
        type="button"
        className={`text-muted-foreground ${
          disabled
            ? "cursor-not-allowed opacity-50"
            : "cursor-grab hover:text-foreground active:cursor-grabbing"
        } focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded`}
        aria-label={t("fields.dragItem", { position: index + 1 })}
        disabled={disabled}
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-5 w-5" />
      </button>
      <span className="text-xs text-muted-foreground w-6 text-right tabular-nums">
        {index + 1}.
      </span>
      <span
        className="flex-1 text-left"
        dangerouslySetInnerHTML={{ __html: processLatexContent(uid) }}
      />
      {reveal && isCorrect === true && <CheckCircle className="w-5 h-5 text-green-500" />}
      {reveal && isCorrect === false && <XCircle className="w-5 h-5 text-red-500" />}
    </div>
  );
}

/**
 * Controlled ordering surface. Drag-to-reorder list, identity tracked by the
 * item string (the canonical order IS the answer key). On `reveal`, each
 * position is marked and the correct order is listed.
 *
 * `needsConfirm` (#1043) says the caller is still showing the seeded shuffle
 * rather than an order the student chose, so the question does not yet count
 * as answered. It renders the "Keep this order" escape hatch for the student
 * who thinks the order in front of them is already right — the one case where
 * requiring a drag would demand a pointless one. Confirming re-emits the
 * current order through `onChange`, which is the caller's cue to record the
 * choice; every drag does the same.
 */
export function OrderingField({
  value,
  canonical,
  onChange,
  disabled,
  reveal,
  needsConfirm = false,
}: {
  value: string[];
  canonical: string[];
  onChange: (order: string[]) => void;
  disabled: boolean;
  reveal: boolean;
  needsConfirm?: boolean;
}) {
  const { t } = useTranslation("quiz");
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  if (value.length === 0) {
    return (
      <Alert className="border-amber-500/30 bg-amber-500/5">
        <AlertTriangle className="h-4 w-4 text-amber-600" />
        <AlertDescription className="text-sm">
          {t("fields.orderingBroken")}
        </AlertDescription>
      </Alert>
    );
  }

  const handleDragEnd = (event: DragEndEvent) => {
    if (reveal || disabled) return;
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = value.indexOf(String(active.id));
    const newIndex = value.indexOf(String(over.id));
    if (oldIndex < 0 || newIndex < 0) return;
    onChange(arrayMove(value, oldIndex, newIndex));
  };

  return (
    <div className="space-y-3">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={value} strategy={verticalListSortingStrategy}>
          <div className="space-y-2" role="list" aria-label={t("fields.orderingGroup")}>
            {value.map((item, idx) => (
              <OrderingSortableRow
                key={item}
                uid={item}
                index={idx}
                disabled={disabled || reveal}
                reveal={reveal}
                isCorrect={reveal ? value[idx] === canonical[idx] : null}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
      {needsConfirm && !reveal && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed p-3">
          <p className="text-xs text-muted-foreground">
            {t("fields.shuffledHint")}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => onChange([...value])}
          >
            {t("fields.keepThisOrder")}
          </Button>
        </div>
      )}
      {reveal && value.some((item, idx) => item !== canonical[idx]) && (
        <div className="space-y-1 pt-2 border-t">
          <span className="text-xs text-muted-foreground">{t("fields.correctOrder")}</span>
          <ol className="text-sm space-y-1 list-decimal list-inside">
            {canonical.map((item, idx) => (
              <li key={`${item}-${idx}`} className="font-medium">
                <span dangerouslySetInnerHTML={{ __html: processLatexContent(item) }} />
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Fill the gaps
// ---------------------------------------------------------------------------

// Normalize a fill-gaps answer the same way `gradeFillGaps` does (NFC → trim →
// lowercase → collapse whitespace) so the reveal marks match grading.
function normalizeGap(s: string): string {
  return s.normalize("NFC").trim().toLowerCase().replace(/\s+/g, " ");
}

// Whether a typed gap value matches any acceptable answer (non-empty).
function isGapCorrect(value: string | undefined, acceptable: string[]): boolean {
  const norm = normalizeGap(value ?? "");
  if (norm.length === 0) return false;
  return acceptable.some((a) => normalizeGap(a) === norm);
}

// Split a fill-gaps stem on `{{N}}` placeholders into ordered text/gap segments.
function splitFillGapsStem(
  stem: string,
): Array<{ kind: "text"; value: string } | { kind: "gap"; ordinal: number }> {
  const out: Array<{ kind: "text"; value: string } | { kind: "gap"; ordinal: number }> = [];
  const re = /\{\{(\d+)\}\}/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(stem)) !== null) {
    out.push({ kind: "text", value: stem.slice(lastIndex, match.index) });
    out.push({ kind: "gap", ordinal: Number(match[1]) });
    lastIndex = match.index + match[0].length;
  }
  out.push({ kind: "text", value: stem.slice(lastIndex) });
  return out;
}

/**
 * Controlled fill-the-gaps surface. Renders the cloze stem with an inline
 * `<Input>` per `{{N}}` placeholder. On `reveal`, each blank is marked and the
 * expected answers are listed.
 */
export function FillGapsField({
  stem,
  gaps,
  value,
  onChange,
  disabled,
  reveal,
  perGap,
}: {
  stem: string;
  gaps: { ordinal: number; acceptable: string[] }[];
  value: string[];
  onChange: (index: number, value: string) => void;
  disabled: boolean;
  reveal: boolean;
  /**
   * Which gaps were accepted, when a grader has already said so. Supplied by
   * surfaces whose verdict comes from the server, because that verdict can be
   * more generous than the exact matcher below — the LLM equivalence judge
   * accepts a synonym or an obvious typo (#784). Marking those gaps red under
   * an answer the server called correct is the contradiction this avoids.
   * Omitted, the field falls back to exact matching, which is right for
   * surfaces that grade nothing (an instructor previewing a question).
   */
  perGap?: boolean[] | null;
}) {
  const { t } = useTranslation("quiz");
  const segments = splitFillGapsStem(stem);
  // A stem with no `{{N}}` placeholders yields zero gap segments, so no input
  // is ever rendered — and because `processLatexContent` runs a markdown pass,
  // a stem that marked its blanks as `___` has them silently consumed as
  // bold-italic rather than left visible. That looked like a normal question
  // that simply could not be answered, and blocked the whole guide (#1035).
  // The answer key being populated is not enough: what matters is whether the
  // stem declares a blank the student can type into.
  //
  // EVERY gap must be rendered, not merely one of them. The submit gate sizes
  // its draft from `gaps.length` (`emptyNonMcqAnswer`) and requires every entry
  // non-empty, so a gap the stem never places has no input to type into and can
  // never be filled — the same permanent block, just with some of the question
  // visible. The reverse (a placeholder with no gap) stays renderable: those
  // show as a visible `___(N)` marker and do not hold the gate open.
  const answerable = gaps.every((g) =>
    segments.some((s) => s.kind === "gap" && s.ordinal === g.ordinal),
  );
  if (gaps.length === 0 || stem.length === 0 || !answerable) {
    return (
      <Alert className="border-amber-500/30 bg-amber-500/5">
        <AlertTriangle className="h-4 w-4 text-amber-600" />
        <AlertDescription className="text-sm">
          {t("fields.fillGapsBroken")}
        </AlertDescription>
      </Alert>
    );
  }

  const GAP_INPUT_WIDTH_CH = 15;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-x-1 gap-y-2 text-base leading-relaxed">
        {segments.map((seg, i) => {
          if (seg.kind === "text") {
            return (
              <span
                key={`t-${i}`}
                className="whitespace-pre-wrap"
                dangerouslySetInnerHTML={{ __html: processLatexContent(seg.value) }}
              />
            );
          }
          const gapIndex = gaps.findIndex((g) => g.ordinal === seg.ordinal);
          if (gapIndex < 0) {
            return (
              <span key={`g-${i}`} className="text-destructive italic">
                ___({seg.ordinal})
              </span>
            );
          }
          const gapCorrect = reveal
            ? (perGap?.[gapIndex] ?? isGapCorrect(value[gapIndex], gaps[gapIndex].acceptable))
            : null;
          return (
            <span key={`g-${i}`} className="inline-flex items-center gap-1">
              <Input
                aria-label={t("fields.gap", { ordinal: seg.ordinal })}
                value={value[gapIndex] ?? ""}
                onChange={(e) => onChange(gapIndex, e.target.value)}
                disabled={disabled || reveal}
                style={{ width: `${GAP_INPUT_WIDTH_CH}ch` }}
                className={`inline h-8 px-2 text-sm align-baseline ${
                  reveal
                    ? gapCorrect
                      ? "border-green-500 bg-green-500/10"
                      : "border-red-500 bg-red-500/10"
                    : ""
                }`}
              />
              {reveal && gapCorrect === true && (
                <CheckCircle className="w-4 h-4 text-green-500 inline" />
              )}
              {reveal && gapCorrect === false && (
                <XCircle className="w-4 h-4 text-red-500 inline" />
              )}
            </span>
          );
        })}
      </div>
      {reveal &&
        gaps.some((g, idx) =>
          !(perGap?.[idx] ?? isGapCorrect(value[idx], g.acceptable))
        ) && (
          <div className="space-y-1 pt-2 border-t">
            <span className="text-xs text-muted-foreground">{t("fields.expectedAnswers")}</span>
            <ul className="text-sm space-y-1">
              {gaps.map((g, idx) => (
                <li key={g.ordinal} className="flex items-baseline gap-2">
                  <span className="text-xs text-muted-foreground">
                    {t("fields.gapLabel", { ordinal: g.ordinal })}
                  </span>
                  <span className="font-medium">{g.acceptable[0]}</span>
                  {g.acceptable.length > 1 && (
                    <span className="text-xs text-muted-foreground">
                      {t("fields.alsoAccepted", {
                        answers: g.acceptable.slice(1).join(", "),
                      })}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Open
// ---------------------------------------------------------------------------

/**
 * Controlled open-answer surface — a single textarea. Open questions have no
 * deterministic key; `reveal` renders the submitted text read-only.
 */
export function OpenField({
  value,
  onChange,
  disabled,
  reveal,
}: {
  value: string;
  onChange: (text: string) => void;
  disabled: boolean;
  reveal: boolean;
}) {
  const { t } = useTranslation("quiz");
  if (reveal) {
    return (
      <div className="space-y-2">
        <div className="p-3 bg-muted rounded-md text-sm whitespace-pre-wrap">
          {value || t("fields.noAnswer")}
        </div>
        <p className="text-xs text-muted-foreground italic">
          {t("fields.openRecorded")}
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <Textarea
        aria-label={t("fields.yourAnswer")}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t("fields.answerPlaceholder")}
        rows={8}
        disabled={disabled}
        className="resize-y"
      />
      <p className="text-xs text-muted-foreground">
        {t("fields.openWillRecord")}
      </p>
    </div>
  );
}
