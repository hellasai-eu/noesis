import { useTranslation } from "react-i18next";
import { useDateFnsLocale } from "@/i18n/formatters";
import { isDeadDueItem, type DueItem } from "@/lib/student-surface";
import { SurfaceTile, type SurfaceTileProps } from "./SurfaceTile";
import { dueLabel } from "./due-label";

interface DueTileProps {
  item: DueItem;
  /** Layout the tile takes — a shelf strip wants `wide`, a wrapping list `fill`. */
  width?: SurfaceTileProps["width"];
  onOpen: (item: DueItem) => void;
}

/**
 * One assigned quiz or study guide, rendered the same wherever it appears:
 * the dashboard's shelves, or the course page's quiz and guide lists.
 *
 * Keeps the hard rule inherited from `ActivityRow`: an assignment the student
 * cannot act on renders inert (`tone="locked"`), so a closed or past-due quiz
 * cannot be opened by clicking the card body. Study guides keep the id the
 * guide cards have always carried: three E2E specs reach for it, and the tile
 * is the same object under a new shape.
 */
export function DueTile({ item, width = "wide", onOpen }: DueTileProps) {
  const { t } = useTranslation("student");
  const locale = useDateFnsLocale();

  const due = dueLabel(item.dueDate, t, locale);
  const isCompleted = item.status === "completed";
  // Both kinds close now: `offering_study_guides.closed_at` mirrors the quiz
  // column, so a done study guide wears the same badge a closed quiz does.
  const isClosed = !!item.closedAt;
  const isDead = isDeadDueItem(item);

  const meta =
    item.kind === "quiz"
      ? [
          t("course.quiz.questions", { count: item.questionCount ?? 0 }),
          item.timeLimit ? t("course.quiz.minutes", { count: item.timeLimit }) : null,
        ]
          .filter(Boolean)
          .join(" · ")
      : t("course.guide.progress", {
          count: item.pieceCount ?? 0,
          completed: item.completedCount ?? 0,
        });

  const action = isCompleted
    ? t("course.quiz.actionResults")
    : item.status === "in_progress"
      ? t("course.quiz.actionResume")
      : item.kind === "guide"
        ? t("course.guide.actionStart")
        : t("course.quiz.actionStart");

  return (
    <SurfaceTile
      courseId={item.courseId}
      kicker={item.courseTitle}
      title={item.title}
      meta={meta}
      width={width}
      tone={isDead ? "locked" : isCompleted ? "muted" : "plain"}
      badge={
        isClosed
          ? { label: t("course.quiz.badgeClosed"), tone: "neutral" }
          : isCompleted
            ? { label: t("course.quiz.badgeCompleted"), tone: "success" }
            : due
              ? { label: due.label, tone: due.overdue ? "urgent" : "warning" }
              : undefined
      }
      actionLabel={isDead ? undefined : action}
      onAction={() => onOpen(item)}
      testId={
        item.kind === "guide"
          ? `study-guide-card-${item.studyGuideId}`
          : `due-tile-quiz-${item.id}`
      }
    />
  );
}
