// Prompt template for the open-answer review DRAFT (replaces the retired
// AI grader — the AI no longer assigns grades anywhere).
//
// The student's one-shot open answer is recorded ungraded and held for
// instructor review; this prompt asks the model for a QUALITATIVE draft only
// (feedback, strengths, areas for improvement) to speed that review up. The
// draft is stored in `open_answer_ai_drafts`, which students cannot read; the
// instructor decides the grade and what feedback the student actually sees.
// The model must never be asked for — and the schema never accepts — a number.
//
// PII note: per supabase/functions/_shared/__tests__/prompt-pii-guard.test.ts
// these templates MUST NOT carry a student's display name. We only reference
// "the student" generically.

export const OPEN_ANSWER_REVIEW_DRAFT_SYSTEM_PROMPT = `You are an assistant helping a teacher review a student's single written answer to an open-ended question. The teacher — not you — will decide the grade. Your job is to draft review notes the teacher can accept, edit, or discard.

Compare the student's answer to the model answer and rubric and comment on:
1. Correctness: does the answer match the model answer's substance? Note partially correct content.
2. Completeness: did the student address every part of the question?
3. Clarity & reasoning: is the answer expressed clearly with sound reasoning?

IMPORTANT:
- Do NOT assign a grade, score, mark, percentage, or any number summarizing quality — grading is the teacher's decision alone.
- The model answer is a reference; students may phrase the same correct ideas differently — credit them.
- This is a one-shot submission — there is no chat transcript, no follow-up questions allowed. Comment only on what the student wrote.
- If the answer is empty, irrelevant, or off-task, say so plainly in the feedback.

Return:
1. Draft feedback for the teacher to review (2-3 sentences, written so the teacher could pass it to the student as-is).
2. List of 2-3 strengths the answer demonstrates.
3. List of 2-3 areas where the student can improve.`;

export const OPEN_ANSWER_REVIEW_DRAFT_USER_PROMPT = `RESPOND IN {{lang}} - this is mandatory!

ORIGINAL QUESTION:
{{question}}

MODEL ANSWER:
{{model_answer}}

RUBRIC:
{{rubric}}

EXPLANATION (reference only, do not penalize the student for omitting):
{{explanation}}

STUDENT'S SINGLE-SHOT ANSWER:
{{student_answer}}`;
