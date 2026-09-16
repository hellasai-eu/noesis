import type { InstructorContent } from "./types";

/**
 * The sequential setup path the home page walks a non-technical instructor
 * through, per course. Pure derivation over `InstructorContent`, so the order
 * and the "what counts as done" rules live in one testable place.
 *
 * The steps mirror how the platform actually gates itself: nothing can be
 * generated without a material, competencies unlock the analytics surfaces,
 * and content only reaches students once an `offering_*` row is published.
 */
export type SetupStepKey = "material" | "competencies" | "content" | "assign";

export interface SetupStep {
  key: SetupStepKey;
  label: string;
  detail: string;
  done: boolean;
  /** Where "do this step" lands, relative to /course/:courseId. */
  link: string;
}

export interface CourseChecklist {
  steps: SetupStep[];
  doneCount: number;
  /** First step not done; undefined when the course is fully set up. */
  nextStep?: SetupStep;
}

/**
 * How many students must have completed a guide/quiz before the home page
 * promotes "Analysis & Follow-up" (guides) / "See results" (quizzes) to the tile's
 * primary action. Below this, one or
 * two finishers are visible in the meta line but the action stays "Inspect".
 */
export const ANALYTICS_PROMPT_MIN = 3;

/** Deep links into the course workspace tabs (CoursePage reads ?tab / ?sub). */
export const COURSE_LINKS = {
  myClass: "?tab=my-unit",
  materials: "?tab=classwork&sub=course-materials",
  notes: "?tab=classwork&sub=course-materials&sub2=notes",
  announcements: "?tab=classwork&sub=announcements",
  sectionProgress: "?tab=classwork&sub=progress",
  competencies: "?tab=classwork&sub=competencies",
  studyGuides: "?tab=ai-tutoring&sub=study-guides",
  quizzes: "?tab=assessments&sub=quizzes",
  practiceQuestions: "?tab=ai-tutoring&sub=question-bank",
  aiChatbots: "?tab=ai-tutoring&sub=ai-chatbots",
} as const;

export function deriveCourseChecklist(
  courseId: string,
  content: InstructorContent,
): CourseChecklist {
  const materialCount = content.materialCountByCourse[courseId] ?? 0;
  const competencyCount = content.competencyCountByCourse[courseId] ?? 0;
  const guides = content.guides.filter((g) => g.courseId === courseId);
  const quizzes = content.quizzes.filter((q) => q.courseId === courseId);
  const hasContent = guides.length > 0 || quizzes.length > 0;
  const hasAssignment =
    guides.some((g) => g.assignedCount > 0) ||
    quizzes.some((q) => q.openCount > 0 || q.closedCount > 0);

  // Assigning happens where the unassigned content lives; guides win the tie
  // because they are the richer surface.
  const assignLink =
    guides.some((g) => g.assignedCount === 0) || quizzes.length === 0
      ? COURSE_LINKS.studyGuides
      : COURSE_LINKS.quizzes;

  const steps: SetupStep[] = [
    {
      key: "material",
      label: "Upload a material",
      detail: "Add a textbook or PDF — everything else is generated from it.",
      done: materialCount > 0,
      link: COURSE_LINKS.materials,
    },
    {
      key: "competencies",
      label: "Extract competencies",
      detail: "Let the AI map what the material teaches, for analytics.",
      done: competencyCount > 0,
      link: COURSE_LINKS.competencies,
    },
    {
      key: "content",
      label: "Create a study guide or quiz",
      detail: "Turn the material into work your students can do.",
      done: hasContent,
      link: COURSE_LINKS.studyGuides,
    },
    {
      key: "assign",
      label: "Assign it to your class",
      detail: "Published work appears on your students' dashboards.",
      done: hasAssignment,
      link: assignLink,
    },
  ];

  return {
    steps,
    doneCount: steps.filter((s) => s.done).length,
    nextStep: steps.find((s) => !s.done),
  };
}
