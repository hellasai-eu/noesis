export type ContentType = 'open_question' | 'mcq_question' | 'fill_gaps' | 'ordering' | 'classification' | 'study_session' | 'chapter_flashcard' | 'chapter_cheatsheet' | 'study_guide' | 'quiz';

/**
 * Every member of {@link ContentType}, so tests can assert that the
 * table/id-column resolvers in `useContentAssignments` handle each one
 * explicitly rather than falling through to their default branch.
 */
export const CONTENT_TYPES: readonly ContentType[] = [
  'open_question',
  'mcq_question',
  'fill_gaps',
  'ordering',
  'classification',
  'study_session',
  'chapter_flashcard',
  'chapter_cheatsheet',
  'study_guide',
  'quiz',
] as const;

export interface CourseClass {
  id: string;
  name: string;
  grade_level_id: string | null;
  section_name: string | null;
  category: string | null;
  academic_period: string | null;
  offering_id: string;
}

export interface OfferingAssignment {
  offering_id: string;
  published_at: string | null;
  group_id?: string | null;
}

export interface AssignmentTarget {
  offering_id: string;
  group_id: string | null;
}

export interface OfferingGroup {
  id: string;
  offering_id: string;
  name: string;
  description?: string | null;
  is_individual?: boolean;
  /** For individual groups, the display name of the owning student (full_name → email → "Student"). */
  owner_label?: string | null;
}

export interface OfferingSelection {
  wholeClass: boolean;
  groupIds: Set<string>;
}

export type AssignSelection =
  | { kind: 'offerings'; offeringIds: Set<string> }
  | { kind: 'targets'; perOffering: Map<string, OfferingSelection> };
