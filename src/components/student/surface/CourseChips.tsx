import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { subjectColor } from "@/lib/subject-colors";
import type { SurfaceCourse } from "@/lib/student-surface";

/**
 * The surface's only navigation.
 *
 * Selecting a course filters every shelf rather than opening a page — which is
 * the whole argument of this layout, so the control stays a filter, visibly:
 * one row of chips, the selected one filled in its course's hue, "Everything"
 * always first and always reachable.
 *
 * It is a real radio group, keyboard behaviour included: one stop in the tab
 * order, arrows move between options and select as they go, Home and End jump
 * to the ends. A row of eight separately-tabbable buttons would put the whole
 * timetable between a keyboard user and the first shelf.
 */
interface CourseChipsProps {
  courses: SurfaceCourse[];
  selectedCourseId: string | null;
  onSelect: (courseId: string | null) => void;
}

export function CourseChips({ courses, selectedCourseId, onSelect }: CourseChipsProps) {
  const { t } = useTranslation("student");
  const groupRef = useRef<HTMLDivElement>(null);

  if (courses.length === 0) return null;

  // "Everything" is index 0; the courses follow in order.
  const values: (string | null)[] = [null, ...courses.map((c) => c.id)];
  const selectedIndex = Math.max(0, values.indexOf(selectedCourseId));

  const focusOption = (index: number) => {
    const options = groupRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    options?.[index]?.focus();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const last = values.length - 1;
    let next: number | null = null;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = selectedIndex === last ? 0 : selectedIndex + 1;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        next = selectedIndex === 0 ? last : selectedIndex - 1;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = last;
        break;
      default:
        return;
    }
    event.preventDefault();
    onSelect(values[next]);
    focusOption(next);
  };

  const chipClass = (selected: boolean) =>
    cn(
      "inline-flex h-8 items-center gap-2 rounded-full border px-3.5 text-sm font-medium transition-colors",
      "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2",
      selected
        ? "text-primary-foreground"
        : "border-border bg-card text-muted-foreground hover:border-muted-foreground/40",
    );

  return (
    <div
      ref={groupRef}
      className="mb-6 flex flex-wrap gap-2"
      role="radiogroup"
      aria-label={t("surface.filter.label")}
      onKeyDown={handleKeyDown}
    >
      <button
        type="button"
        role="radio"
        aria-checked={selectedCourseId === null}
        // Roving tabindex: the group is one tab stop, and it is the selected
        // option that receives focus when the group is reached.
        tabIndex={selectedIndex === 0 ? 0 : -1}
        onClick={() => onSelect(null)}
        className={cn(chipClass(selectedCourseId === null), selectedCourseId === null && "border-primary bg-primary")}
      >
        {t("surface.filter.all")}
      </button>

      {courses.map((course, index) => {
        const color = subjectColor(course.id);
        const selected = selectedCourseId === course.id;
        return (
          <button
            key={course.id}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selectedIndex === index + 1 ? 0 : -1}
            onClick={() => onSelect(course.id)}
            className={chipClass(selected)}
            style={
              selected
                ? { background: color.hero, borderColor: color.hero, color: color.heroInk }
                : undefined
            }
            data-testid={`course-chip-${course.id}`}
          >
            <span
              className="h-2 w-2 rounded-full"
              style={{ background: selected ? color.heroInk : color.solid }}
              aria-hidden="true"
            />
            {course.title}
          </button>
        );
      })}
    </div>
  );
}
