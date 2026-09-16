/**
 * Database types for tables introduced in migrations that have not yet been
 * applied to the linked Supabase project at the time this PR was authored,
 * so `npm run gen:types` would not yet emit them into `types.ts` (which is
 * generated from the linked schema and must never be hand-edited per
 * CLAUDE.md).
 *
 * Each table block here mirrors exactly what `supabase gen types typescript`
 * would emit, so this file becomes redundant — and can be deleted — once
 * the corresponding migration lands and types.ts is regenerated.
 *
 * Currently augments: `question_evaluation_sessions`, `question_evaluations`
 * (migrations `20260625000000_question_evaluation_schema.sql`,
 * `20260625010000_simplify_correctness_checks.sql`).
 */
import type { Database as GeneratedDatabase } from "./types";

type QuestionEvaluationSessionsTable = {
  Row: {
    course_id: string;
    created_at: string;
    ended_at: string | null;
    evaluator_id: string;
    id: string;
    overall_quality: number | null;
    recurring_problems: string | null;
    started_at: string;
    would_use: string | null;
  };
  Insert: {
    course_id: string;
    created_at?: string;
    ended_at?: string | null;
    evaluator_id: string;
    id?: string;
    overall_quality?: number | null;
    recurring_problems?: string | null;
    started_at?: string;
    would_use?: string | null;
  };
  Update: {
    course_id?: string;
    created_at?: string;
    ended_at?: string | null;
    evaluator_id?: string;
    id?: string;
    overall_quality?: number | null;
    recurring_problems?: string | null;
    started_at?: string;
    would_use?: string | null;
  };
  Relationships: [
    {
      foreignKeyName: "question_evaluation_sessions_course_id_fkey";
      columns: ["course_id"];
      isOneToOne: false;
      referencedRelation: "courses";
      referencedColumns: ["id"];
    },
  ];
};

type QuestionEvaluationsTable = {
  Row: {
    answer_good: boolean;
    clarity: number;
    cognitive_level: string | null;
    comment: string | null;
    created_at: string;
    curriculum_alignment: number | null;
    difficulty_confirmation: string;
    distractor_quality: number | null;
    evaluator_id: string;
    id: string;
    language_appropriateness: number | null;
    pedagogical_value: number;
    problem_categories: string[];
    question_bank_alignment: number | null;
    question_good: boolean;
    question_id: string;
    session_id: string;
    updated_at: string;
    verdict: string;
    was_sampled: boolean;
  };
  Insert: {
    answer_good: boolean;
    clarity: number;
    cognitive_level?: string | null;
    comment?: string | null;
    created_at?: string;
    curriculum_alignment?: number | null;
    difficulty_confirmation: string;
    distractor_quality?: number | null;
    evaluator_id: string;
    id?: string;
    language_appropriateness?: number | null;
    pedagogical_value: number;
    problem_categories?: string[];
    question_bank_alignment?: number | null;
    question_good: boolean;
    question_id: string;
    session_id: string;
    updated_at?: string;
    verdict: string;
    was_sampled?: boolean;
  };
  Update: {
    answer_good?: boolean;
    clarity?: number;
    cognitive_level?: string | null;
    comment?: string | null;
    created_at?: string;
    curriculum_alignment?: number | null;
    difficulty_confirmation?: string;
    distractor_quality?: number | null;
    evaluator_id?: string;
    id?: string;
    language_appropriateness?: number | null;
    pedagogical_value?: number;
    problem_categories?: string[];
    question_bank_alignment?: number | null;
    question_good?: boolean;
    question_id?: string;
    session_id?: string;
    updated_at?: string;
    verdict?: string;
    was_sampled?: boolean;
  };
  Relationships: [
    {
      foreignKeyName: "question_evaluations_question_id_fkey";
      columns: ["question_id"];
      isOneToOne: false;
      referencedRelation: "questions";
      referencedColumns: ["id"];
    },
    {
      foreignKeyName: "question_evaluations_session_id_fkey";
      columns: ["session_id"];
      isOneToOne: false;
      referencedRelation: "question_evaluation_sessions";
      referencedColumns: ["id"];
    },
  ];
};

export type Database = Omit<GeneratedDatabase, "public"> & {
  public: Omit<GeneratedDatabase["public"], "Tables"> & {
    Tables: GeneratedDatabase["public"]["Tables"] & {
      question_evaluation_sessions: QuestionEvaluationSessionsTable;
      question_evaluations: QuestionEvaluationsTable;
    };
  };
};
