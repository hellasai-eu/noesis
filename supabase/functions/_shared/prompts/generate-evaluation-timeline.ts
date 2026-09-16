/**
 * Student competency-timeline analysis (`generate-evaluation-timeline`).
 *
 * Moved in-repo from an OpenAI-hosted saved prompt
 * (`pmpt_694902dfc968819382767ceac42bd7ad0f6b1bf0b4a95c74`, version 2). That
 * template lived in the dashboard, so neither its text nor its model was
 * reviewable here, and `prompt-pii-guard.test.ts` carried a standing
 * scope-limitation note requiring a MANUAL audit whenever a variable was added
 * or the version bumped. Holding it here puts both under the same tests as
 * every other prompt.
 *
 * NO STUDENT IDENTIFIER IS PASSED. The handler receives only the evaluation
 * texts and a language; the analysis is rendered to an instructor already
 * looking at that student in Student 360, so naming them adds nothing the
 * reader lacks. A student-name placeholder is banned outright (#557), and the
 * sanctioned student_id variable would be identity without meaning here — the
 * model has no other data keyed to it.
 *
 * (Deliberately phrased without the literal brace-wrapped tokens: the PII
 * guard is a line scan, so quoting one in a comment trips it.)
 *
 * Residual exposure worth knowing about: `competency_history` is assembled
 * from `overallAssessment` and `instructorFeedback`, which are free prose
 * written by instructors and by prior AI evaluations. An instructor who types
 * a student's name into feedback puts it in this payload. The guard stops the
 * template from *asking* for a name; it cannot stop the content from carrying
 * one.
 */

export const EVALUATION_TIMELINE_SYSTEM_PROMPT =
  `You are an educational analytics expert. Analyze the student's competency mastery progress over time and provide actionable insights.

Given the student's learning history, generate a structured JSON analysis with these fields:
- summary: A 2-3 sentence overview of the student's overall progress
- overallTrend: "improving", "declining", or "stable"
- competencyInsights: Array of objects with:
  - competencyTitle: string
  - trend: "improving", "declining", or "stable"
  - insight: A brief observation about this competency
- strengths: Array of 2-3 strengths identified
- areasForImprovement: Array of 2-3 areas needing improvement
- recommendations: Array of 2-3 specific, actionable recommendations

Be specific, constructive, and encouraging. Focus on patterns and trends rather than individual events.`;

export const EVALUATION_TIMELINE_USER_PROMPT =
  `All responses must be in the {{lang}} language
Analyze the competency mastery progress for this student

The competency history follows in the input (most recent first):
{{competency_history}}`;
