/**
 * Shapes the student surface renders from.
 *
 * Every loader in this folder answers the same question the old course page
 * answered per course, but across every course the student is enrolled in. The
 * types stay deliberately flat — a shelf maps them straight onto tiles, and no
 * component reaches back into a Supabase row.
 */

export interface SurfaceCourse {
  id: string;
  title: string;
  description: string | null;
  theme: string | null;
}

export interface SurfaceClass {
  id: string;
  name: string;
  grade_level_id: string | null;
  section_name: string | null;
  category: string | null;
  academic_period: string | null;
}

/**
 * Who the student is, in terms the loaders need: their classes, the offerings
 * those classes carry, and the courses behind them. Resolved once and passed
 * to every other loader, so the enrolment queries run a single time per view.
 */
export interface StudentScope {
  institutionId: string;
  classes: SurfaceClass[];
  courses: SurfaceCourse[];
  offeringIds: string[];
  /** Course id → the student's offerings for it, in a stable order. */
  offeringsByCourse: Record<string, string[]>;
  /** Offering id → its course, for grouping assignment rows. */
  courseByOffering: Record<string, string>;
}

export type DueStatus = "not_started" | "in_progress" | "completed";

/** A quiz or a study guide the student has been given, with its deadline. */
export interface DueItem {
  kind: "quiz" | "guide";
  /** Stable per assignment — the offering_quiz row, or the guide id. */
  id: string;
  courseId: string;
  courseTitle: string;
  title: string;
  dueDate: string | null;
  status: DueStatus;
  /** Quizzes only. */
  quizId?: string;
  questionCount?: number;
  timeLimit?: number | null;
  closedAt?: string | null;
  /** Guides only. */
  studyGuideId?: string;
  pieceCount?: number;
  completedCount?: number;
}

