import { ArrowRight, Check, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { subjectColor } from "@/lib/subject-colors";
import { COURSE_LINKS } from "@/lib/instructor-surface";
import type { InstructorCourse, CourseChecklist } from "@/lib/instructor-surface";

/**
 * One course's guided setup: the four steps in order, with exactly one
 * "you are here". The card's single button always points at the first
 * unfinished step — the whole point is that a non-technical instructor
 * never has to work out what comes next.
 */
interface CourseSetupCardProps {
  course: InstructorCourse;
  checklist: CourseChecklist;
  /** Navigate to /course/:id + the step's ?tab deep link. */
  onGo: (link: string) => void;
}

export function CourseSetupCard({ course, checklist, onGo }: CourseSetupCardProps) {
  const color = subjectColor(course.id);
  const { steps, doneCount, nextStep } = checklist;
  const complete = !nextStep;

  return (
    <div
      className="flex flex-col rounded-2xl border border-border bg-card p-5 shadow-sm"
      data-testid="course-setup-card"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <span
            className="text-[10px] font-bold uppercase tracking-[0.07em]"
            style={{ color: color.ink }}
          >
            {course.classNames.length > 0 ? course.classNames.join(" · ") : "No class yet"}
          </span>
          <h3 className="mt-0.5 truncate font-display text-sm font-bold text-foreground">
            {course.title}
          </h3>
        </div>
        <span
          className={cn(
            "flex-shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold",
            complete
              ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
              : "bg-muted text-muted-foreground",
          )}
        >
          {complete ? "All set" : `${doneCount}/${steps.length} steps`}
        </span>
      </div>

      <ol className="mt-4 space-y-2">
        {steps.map((step, i) => {
          const isNext = step.key === nextStep?.key;
          return (
            <li key={step.key} className="flex items-start gap-2">
              <span
                className={cn(
                  "mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full text-[10px] font-bold",
                  step.done
                    ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                    : isNext
                      ? "text-white"
                      : "bg-muted text-muted-foreground",
                )}
                style={isNext ? { background: color.solid } : undefined}
              >
                {step.done ? <Check className="h-2.5 w-2.5" aria-label="done" /> : i + 1}
              </span>
              <button
                type="button"
                className={cn(
                  "min-w-0 text-left",
                  !step.done && !isNext && "opacity-50",
                )}
                onClick={() => onGo(step.link)}
              >
                <span
                  className={cn(
                    "block text-xs font-semibold leading-snug",
                    step.done ? "text-muted-foreground line-through decoration-1" : "text-foreground",
                  )}
                >
                  {step.label}
                </span>
                {isNext && (
                  <span className="block text-[11px] text-muted-foreground">{step.detail}</span>
                )}
              </button>
            </li>
          );
        })}
      </ol>

      <div className="mt-auto flex gap-2 pt-4">
        <Button
          size="sm"
          variant={complete ? "outline" : "default"}
          className="h-8 min-w-0 flex-1 px-2.5 text-xs"
          onClick={() => onGo(nextStep?.link ?? "")}
        >
          <span className="truncate">{nextStep ? nextStep.label : "Open course"}</span>
          <ArrowRight className="ml-1.5 h-3.5 w-3.5 flex-shrink-0" />
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-8 min-w-0 flex-1 px-2.5 text-xs"
          onClick={() => onGo(COURSE_LINKS.sectionProgress)}
        >
          <TrendingUp className="mr-1.5 h-3.5 w-3.5 flex-shrink-0" />
          <span className="truncate">Mark your progress</span>
        </Button>
      </div>
    </div>
  );
}
