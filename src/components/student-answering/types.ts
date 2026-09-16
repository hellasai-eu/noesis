/**
 * Shared types for the per-type single-question answering panels (#755).
 *
 * Each panel renders the answering view for ONE question by id. The unified
 * Practice surface (#756) embeds the right panel for the right `type` and
 * uses these callbacks to refresh its list and dispatch next-question.
 */
export type SinglePanelStatus = "not_started" | "in_progress" | "completed";

export interface SinglePanelCompletion {
  /** 0–100 grade if known. */
  grade?: number;
  /** Deterministic types report whether the whole answer was correct. */
  allCorrect?: boolean;
}

export interface SinglePanelProps {
  questionId: string;
  courseId: string;
  /** Offering this question is assigned to — RLS scopes writes per offering. */
  offeringId?: string | null;
  /** Always fires when the back arrow is clicked. */
  onBack: () => void;
  /** Fires once after a successful grade is persisted. */
  onCompleted?: (result?: SinglePanelCompletion) => void;
  /** Fires whenever local status transitions, for optimistic list refresh. */
  onStatusChange?: (status: SinglePanelStatus) => void;
}
