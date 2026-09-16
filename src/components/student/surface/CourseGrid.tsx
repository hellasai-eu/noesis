import { useTranslation } from "react-i18next";
import { GraduationCap } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { subjectColor, subjectColorByIndex } from "@/lib/subject-colors";
import type { SurfaceCourse } from "@/lib/student-surface";

/** What is still actionable in one course, for the card's counts line. */
export interface CourseDueCounts {
  quizzes: number;
  guides: number;
}

/**
 * The dashboard's navigation: one card per course, in the course's hue,
 * carrying what is still due there. Clicking a card opens the course page.
 *
 * A wrapping grid rather than a shelf — the timetable is small and finite,
 * and every course must be visible at once for the row of cards to work as a
 * map of the student's week. The hue is the same `hero` fill the selected
 * course chip uses, so the colour a student learned on the chips carries over.
 */
interface CourseGridProps {
  courses: SurfaceCourse[];
  counts: Map<string, CourseDueCounts>;
  loading: boolean;
  onOpen: (courseId: string) => void;
}

export function CourseGrid({ courses, counts, loading, onOpen }: CourseGridProps) {
  const { t } = useTranslation("student");
  const accent = subjectColorByIndex(4);

  const countsLine = (courseId: string) => {
    const c = counts.get(courseId);
    const parts: string[] = [];
    if (c && c.quizzes > 0) parts.push(t("surface.courses.quizzesDue", { count: c.quizzes }));
    if (c && c.guides > 0) parts.push(t("surface.courses.guidesDue", { count: c.guides }));
    return parts.length > 0 ? parts.join(" · ") : t("surface.courses.clear");
  };

  return (
    <section className="mb-7" aria-label={t("surface.courses.title")} data-testid="course-grid">
      <div className="mb-3 flex items-center gap-2.5">
        <span
          className="flex h-7 w-7 items-center justify-center rounded-lg"
          style={{ background: accent.tint }}
        >
          <GraduationCap className="h-4 w-4" style={{ color: accent.ink }} aria-hidden="true" />
        </span>
        <h2 className="text-base font-bold tracking-tight">{t("surface.courses.title")}</h2>
      </div>

      {loading ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-[104px] rounded-2xl" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {courses.map((course) => {
            const color = subjectColor(course.id);
            return (
              <div
                key={course.id}
                role="button"
                tabIndex={0}
                onClick={() => onOpen(course.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onOpen(course.id);
                  }
                }}
                className="flex min-h-[104px] cursor-pointer flex-col justify-between rounded-2xl p-4 shadow-sm transition-shadow hover:shadow-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                style={{ background: color.hero, color: color.heroInk }}
                data-testid={`course-card-${course.id}`}
                data-subject={color.index}
              >
                <h3 className="font-display text-base font-bold leading-snug">
                  {course.title}
                </h3>
                <p className="mt-2 text-xs" style={{ opacity: 0.85 }}>
                  {countsLine(course.id)}
                </p>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
