/**
 * The instructor home's data shapes.
 *
 * Everything hangs off `InstructorScope` (which courses this instructor
 * teaches here) the same way the student surface hangs off `StudentScope`.
 * Content rows are deliberately thin — the home page decides and deep-links,
 * the course workspace does the actual work.
 */

export interface InstructorCourse {
  id: string;
  title: string;
  description: string | null;
  /** "Β1", "Γ2 Θετική" … — the classes whose offerings carry this course. */
  classNames: string[];
}

export interface InstructorClass {
  id: string;
  name: string;
}

export interface InstructorScope {
  institutionId: string;
  courses: InstructorCourse[];
  courseIds: string[];
  /** Every class behind the instructor's offerings — the filter chips. */
  classes: InstructorClass[];
  classNameByOffering: Record<string, string>;
  classIdByOffering: Record<string, string>;
  classIdsByCourse: Record<string, string[]>;
}

export interface GuideSummary {
  id: string;
  courseId: string;
  title: string;
  createdAt: string;
  /** offering_study_guides rows with published_at set — live assignments. */
  assignedCount: number;
  /**
   * Published assignments that are DONE: marked done by the instructor
   * (closed_at) or past their due date (`assignmentIsDone`). Always ≤
   * assignedCount; a guide whose published assignments are all done reads
   * "Done" on the shelf and sorts behind live work.
   */
  doneAssignmentCount: number;
  /** Earliest due_date among the published, not-yet-done assignments. */
  nextDueDate: string | null;
  /** offering_study_guides rows still unpublished — staged but not visible. */
  draftAssignmentCount: number;
  /** Pieces in the guide. 0 is a real state: outline generation can fail. */
  pieceCount: number;
  /**
   * Pieces with no questions. Together with `pieceCount === 0` this is what
   * makes a guide "incomplete" — `guideIsAssignable` blocks handing it out,
   * so the shelf must suggest completing it rather than assigning it.
   */
  incompletePieceCount: number;
  /** Class names / ids behind the published assignments, deduped. */
  assignedClassNames: string[];
  assignedClassIds: string[];
  /** Distinct students with a `study_guide_progress.completed_at`. */
  studentsCompleted: number;
}

export interface QuizSummary {
  id: string;
  courseId: string;
  title: string;
  createdAt: string;
  questionCount: number;
  /** Mirrors AssessmentList's status model over offering_quizzes. */
  openCount: number;
  closedCount: number;
  draftAssignmentCount: number;
  /** Class names / ids behind the published assignments, deduped. */
  assignedClassNames: string[];
  assignedClassIds: string[];
  /** Distinct students who have submitted the quiz. */
  studentsCompleted: number;
}

export interface InstructorContent {
  materialCountByCourse: Record<string, number>;
  competencyCountByCourse: Record<string, number>;
  guides: GuideSummary[];
  quizzes: QuizSummary[];
}
