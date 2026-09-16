import { LucideIcon, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { subjectColor, type SubjectColor } from "@/lib/subject-colors";
import type { InstructorCourse } from "@/lib/instructor-surface";

/**
 * One "what do you want to do today?" button. Every action needs a course, so
 * with several courses the button opens a picker; with exactly one it goes
 * straight there — the common single-course instructor never sees a menu.
 */
interface QuickActionProps {
  label: string;
  icon: LucideIcon;
  courses: InstructorCourse[];
  /** Hue from the subject palette; tint fills the pill, ink carries the text. */
  accent: SubjectColor;
  /** Called with the chosen course id; the caller owns the navigation. */
  onPick: (courseId: string) => void;
}

const pillClass =
  "h-11 rounded-full border-transparent px-5 font-semibold transition-[filter] hover:brightness-95 dark:hover:brightness-110";

export function QuickAction({ label, icon: Icon, courses, accent, onPick }: QuickActionProps) {
  // Inline style because the palette is CSS-variable based (theme-aware) and
  // cannot be expressed as a static Tailwind class.
  const accentStyle = { background: accent.tint, color: accent.ink };

  if (courses.length <= 1) {
    return (
      <Button
        variant="outline"
        className={pillClass}
        style={accentStyle}
        disabled={courses.length === 0}
        onClick={() => courses[0] && onPick(courses[0].id)}
      >
        <Icon className="mr-2 h-4 w-4" />
        {label}
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className={pillClass} style={accentStyle}>
          <Icon className="mr-2 h-4 w-4" />
          {label}
          <ChevronDown className="ml-1.5 h-3.5 w-3.5 opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>For which course?</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {courses.map((course) => (
          <DropdownMenuItem key={course.id} onClick={() => onPick(course.id)}>
            <span
              className="mr-2 h-2.5 w-2.5 flex-shrink-0 rounded-full"
              style={{ background: subjectColor(course.id).solid }}
            />
            <span className="min-w-0 flex-1 truncate">
              {course.title}
              {course.classNames.length > 0 && (
                <span className="text-muted-foreground"> ({course.classNames.join(", ")})</span>
              )}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
