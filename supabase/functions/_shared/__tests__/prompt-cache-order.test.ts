// Guardrail test (issue #558): assert that prompt templates follow the
// static-first / dynamic-last layout required for OpenAI's prompt-prefix cache
// to hit. Dynamic substitutions in the system prompt — or above stable ones in
// the user prompt — silently destroy ~50% input-token savings.
//
// If this test fails, see supabase/functions/_shared/prompts/README.md for the
// rule and the corrected layout.

import { assert, assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";

import {
  MCQ_SYSTEM_PROMPT,
  MCQ_USER_PROMPT,
} from "../prompts/generate-questions.ts";
import {
  OPEN_QUESTIONS_SYSTEM_PROMPT,
  OPEN_QUESTIONS_USER_PROMPT,
} from "../prompts/generate-open-questions.ts";
import {
  STUDY_TUTOR_SYSTEM_PROMPT,
  STUDY_TUTOR_USER_PROMPT,
} from "../prompts/study-tutor.ts";
import {
  SOCRATIC_CHAT_SYSTEM_PROMPT,
  SOCRATIC_CHAT_USER_PROMPT,
  SOCRATIC_CHAT_WELCOME_PROMPT,
} from "../prompts/socratic-chat.ts";
import {
  FLASHCARDS_SYSTEM_PROMPT,
  FLASHCARDS_USER_PROMPT,
} from "../prompts/generate-flashcards.ts";
import {
  CHEATSHEET_SYSTEM_PROMPT,
  CHEATSHEET_USER_PROMPT,
} from "../prompts/generate-cheatsheet.ts";
import {
  STUDY_GUIDE_OUTLINE_SYSTEM_PROMPT,
  STUDY_GUIDE_OUTLINE_USER_PROMPT,
  STUDY_GUIDE_THEORY_SYSTEM_PROMPT,
  STUDY_GUIDE_THEORY_USER_PROMPT,
  STUDY_GUIDE_QUESTIONS_SYSTEM_PROMPT,
  STUDY_GUIDE_QUESTIONS_USER_PROMPT,
} from "../prompts/study-guide-generation.ts";
import {
  ANALYZE_STUDY_GUIDE_SYSTEM_PROMPT,
  ANALYZE_STUDY_GUIDE_USER_PROMPT,
} from "../prompts/analyze-study-guide.ts";
import {
  EVALUATION_TIMELINE_SYSTEM_PROMPT,
  EVALUATION_TIMELINE_USER_PROMPT,
} from "../prompts/generate-evaluation-timeline.ts";

// Assert that every placeholder in `order` appears in `template`, and that
// each appears strictly before the next. Pinpoints the violating pair when it
// fails so the regression is obvious.
function assertPlaceholderOrder(
  label: string,
  template: string,
  order: string[],
): void {
  const positions = order.map((p) => ({ placeholder: p, idx: template.indexOf(p) }));
  for (const { placeholder, idx } of positions) {
    assert(
      idx !== -1,
      `${label}: expected placeholder ${placeholder} to appear in template`,
    );
  }
  for (let i = 0; i < positions.length - 1; i++) {
    const a = positions[i];
    const b = positions[i + 1];
    assert(
      a.idx < b.idx,
      `${label}: expected ${a.placeholder} (index ${a.idx}) to appear before ${b.placeholder} (index ${b.idx}). ` +
        `Dynamic substitutions must live AFTER stable ones — see prompts/README.md.`,
    );
  }
}

// Assert that a placeholder is absent. Used to enforce that dynamic per-call
// substitutions have been moved OUT of the system prompt (= the cached prefix).
function assertPlaceholderAbsent(
  label: string,
  template: string,
  forbidden: string[],
): void {
  for (const placeholder of forbidden) {
    assertEquals(
      template.includes(placeholder),
      false,
      `${label}: placeholder ${placeholder} must NOT appear here — it is per-call dynamic content ` +
        `and poisons the prompt-prefix cache. Move it into the user prompt at the END.`,
    );
  }
}

// generate-questions: dynamic substitutions banned from system prompt;
// user prompt orders static-first, dynamic-last.
Deno.test("generate-questions system prompt has no per-call dynamic placeholders", () => {
  assertPlaceholderAbsent("MCQ_SYSTEM_PROMPT", MCQ_SYSTEM_PROMPT, [
    "{{special_instructions}}",
    "{{group_audience_hint}}",
    "{{past_questions}}",
  ]);
});

Deno.test("generate-questions system prompt keeps stable per-chapter blocks at the end", () => {
  assertPlaceholderOrder("MCQ_SYSTEM_PROMPT", MCQ_SYSTEM_PROMPT, [
    "{{chapter_instructions}}",
    "{{chapter_content}}",
  ]);
});

Deno.test("generate-questions user prompt follows static-first / dynamic-last", () => {
  assertPlaceholderOrder("MCQ_USER_PROMPT", MCQ_USER_PROMPT, [
    "{{full_competency_list}}",
    "{{chapter_list}}",
    "{{competency_list}}",
    "{{group_audience_hint}}",
    "{{special_instructions}}",
    "{{past_questions}}",
    "{{num}}",
    "{{difficulty}}",
    "{{lang}}",
  ]);
});

// generate-open-questions: same shape.
Deno.test("generate-open-questions system prompt has no per-call dynamic placeholders", () => {
  assertPlaceholderAbsent("OPEN_QUESTIONS_SYSTEM_PROMPT", OPEN_QUESTIONS_SYSTEM_PROMPT, [
    "{{special_instructions}}",
    "{{group_audience_hint}}",
    "{{past_questions}}",
  ]);
});

Deno.test("generate-open-questions system prompt keeps stable per-chapter blocks at the end", () => {
  // study_guide_theory is stable per guide, so it belongs with the other
  // cacheable source blocks rather than in the per-call user message.
  assertPlaceholderOrder("OPEN_QUESTIONS_SYSTEM_PROMPT", OPEN_QUESTIONS_SYSTEM_PROMPT, [
    "{{chapter_instructions}}",
    "{{chapter_content}}",
    "{{study_guide_theory}}",
  ]);
});

Deno.test("generate-open-questions user prompt follows static-first / dynamic-last", () => {
  assertPlaceholderOrder("OPEN_QUESTIONS_USER_PROMPT", OPEN_QUESTIONS_USER_PROMPT, [
    "{{full_competency_list}}",
    "{{chapter_list}}",
    "{{competency_list}}",
    "{{group_audience_hint}}",
    "{{special_instructions}}",
    "{{past_questions}}",
    "{{num}}",
    "{{difficulty}}",
    "{{lang}}",
  ]);
});

// study-tutor: stable course/objective/content lives in the system prompt;
// session_state is the per-turn dynamic substitution and lives in the user
// prompt. Conversation history is appended after as separate input messages
// (the handler is responsible for that ordering — see handler.ts).
Deno.test("study-tutor system prompt keeps course/objective/content stable, before dynamic context", () => {
  assertPlaceholderOrder("STUDY_TUTOR_SYSTEM_PROMPT", STUDY_TUTOR_SYSTEM_PROMPT, [
    "{{course}}",
    "{{objective}}",
    "{{competency_list}}",
    "{{content}}",
  ]);
});

Deno.test("study-tutor system prompt does NOT embed per-turn dynamic state", () => {
  assertPlaceholderAbsent("STUDY_TUTOR_SYSTEM_PROMPT", STUDY_TUTOR_SYSTEM_PROMPT, [
    "{{session_state}}",
    "{{chat_history}}",
  ]);
});

Deno.test("study-tutor user prompt carries session_state (dynamic-tail)", () => {
  assert(
    STUDY_TUTOR_USER_PROMPT.includes("{{session_state}}"),
    "STUDY_TUTOR_USER_PROMPT must carry session_state — it is the per-turn dynamic substitution",
  );
});

// socratic-chat: stable assignment/reference/competencies live early in the
// user prompt; chat_history lives at the END.
Deno.test("socratic-chat system prompt does NOT embed per-turn dynamic chat_history", () => {
  assertPlaceholderAbsent("SOCRATIC_CHAT_SYSTEM_PROMPT", SOCRATIC_CHAT_SYSTEM_PROMPT, [
    "{{chat_history}}",
  ]);
});

Deno.test("socratic-chat user prompt orders stable question/reference/competencies before chat_history", () => {
  assertPlaceholderOrder("SOCRATIC_CHAT_USER_PROMPT", SOCRATIC_CHAT_USER_PROMPT, [
    "{{question}}",
    "{{model_answer}}",
    "{{explanation}}",
    "{{competencies}}",
    "{{chat_history}}",
  ]);
});

// socratic-chat welcome: static instructions first; dynamic question/competencies at the end.
Deno.test("socratic-chat welcome prompt places dynamic placeholders after static instructions", () => {
  assertPlaceholderOrder("SOCRATIC_CHAT_WELCOME_PROMPT", SOCRATIC_CHAT_WELCOME_PROMPT, [
    "{{lang}}",
    "{{question}}",
    "{{competencies}}",
  ]);
});

// generate-flashcards: stable course/material/chapter metadata first;
// instructor_notes is the per-call dynamic substitution and lives at the END.
Deno.test("generate-flashcards system prompt is fully static (no substitutions)", () => {
  assertPlaceholderAbsent("FLASHCARDS_SYSTEM_PROMPT", FLASHCARDS_SYSTEM_PROMPT, [
    "{{instructor_notes}}",
    "{{course_title}}",
    "{{material_title}}",
    "{{chapter_title}}",
  ]);
});

Deno.test("generate-flashcards user prompt orders metadata before instructor_notes", () => {
  assertPlaceholderOrder("FLASHCARDS_USER_PROMPT", FLASHCARDS_USER_PROMPT, [
    "{{course_title}}",
    "{{material_title}}",
    "{{chapter_number}}",
    "{{chapter_title}}",
    "{{lang}}",
    "{{instructor_notes}}",
  ]);
});

// generate-cheatsheet: same shape as flashcards.
Deno.test("generate-cheatsheet system prompt is fully static (no substitutions)", () => {
  assertPlaceholderAbsent("CHEATSHEET_SYSTEM_PROMPT", CHEATSHEET_SYSTEM_PROMPT, [
    "{{instructor_notes}}",
    "{{course_title}}",
    "{{material_title}}",
    "{{chapter_title}}",
  ]);
});

Deno.test("generate-cheatsheet user prompt orders metadata before instructor_notes", () => {
  assertPlaceholderOrder("CHEATSHEET_USER_PROMPT", CHEATSHEET_USER_PROMPT, [
    "{{course_title}}",
    "{{material_title}}",
    "{{chapter_number}}",
    "{{chapter_title}}",
    "{{lang}}",
    "{{instructor_notes}}",
  ]);
});

// study-guide-generation (#978): two prompt pairs sharing one attached set of
// chapter PDFs across an outline call plus one call per piece, so prefix
// stability matters more here than anywhere else in the codebase.
Deno.test("study-guide outline system prompt is fully static (no substitutions)", () => {
  assertPlaceholderAbsent("STUDY_GUIDE_OUTLINE_SYSTEM_PROMPT", STUDY_GUIDE_OUTLINE_SYSTEM_PROMPT, [
    "{{brief}}",
    "{{course_title}}",
    "{{material_title}}",
    "{{chapter_list}}",
    "{{target_piece_count}}",
  ]);
});

Deno.test("study-guide outline user prompt orders metadata before the brief", () => {
  assertPlaceholderOrder("STUDY_GUIDE_OUTLINE_USER_PROMPT", STUDY_GUIDE_OUTLINE_USER_PROMPT, [
    "{{course_title}}",
    "{{material_title}}",
    "{{chapter_list}}",
    "{{lang}}",
    "{{target_piece_count}}",
    "{{brief}}",
  ]);
});

Deno.test("study-guide theory system prompt is fully static (no substitutions)", () => {
  assertPlaceholderAbsent("STUDY_GUIDE_THEORY_SYSTEM_PROMPT", STUDY_GUIDE_THEORY_SYSTEM_PROMPT, [
    "{{brief}}",
    "{{course_title}}",
    "{{material_title}}",
    "{{chapter_list}}",
    "{{outline_summary}}",
    "{{piece_title}}",
    "{{piece_scope}}",
    "{{special_instructions}}",
  ]);
});

Deno.test("study-guide theory user prompt orders stable context before per-piece data", () => {
  assertPlaceholderOrder("STUDY_GUIDE_THEORY_USER_PROMPT", STUDY_GUIDE_THEORY_USER_PROMPT, [
    "{{course_title}}",
    "{{material_title}}",
    "{{chapter_list}}",
    "{{lang}}",
    "{{outline_summary}}",
    "{{piece_position}}",
    "{{piece_total}}",
    "{{piece_title}}",
    "{{piece_scope}}",
    "{{brief}}",
    // Volatile per-call steering, so it sits behind everything cacheable.
    "{{special_instructions}}",
  ]);
});

Deno.test("study-guide questions system prompt is fully static (no substitutions)", () => {
  assertPlaceholderAbsent(
    "STUDY_GUIDE_QUESTIONS_SYSTEM_PROMPT",
    STUDY_GUIDE_QUESTIONS_SYSTEM_PROMPT,
    [
      "{{piece_theory}}",
      "{{course_title}}",
      "{{competency_list}}",
      "{{piece_title}}",
      "{{type_instruction}}",
      "{{difficulty_instruction}}",
    ],
  );
});

// The theory is the LAST placeholder on purpose: it is the most volatile input
// in the whole feature — the instructor edits it between calls — so it must sit
// behind everything stable for the prefix cache to survive an edit.
Deno.test("study-guide questions user prompt puts the edited theory last", () => {
  assertPlaceholderOrder("STUDY_GUIDE_QUESTIONS_USER_PROMPT", STUDY_GUIDE_QUESTIONS_USER_PROMPT, [
    "{{course_title}}",
    "{{material_title}}",
    "{{chapter_list}}",
    "{{lang}}",
    "{{competency_list}}",
    "{{piece_position}}",
    "{{piece_total}}",
    "{{piece_title}}",
    "{{target_question_count}}",
    "{{type_instruction}}",
    "{{difficulty_instruction}}",
    "{{piece_theory}}",
  ]);
});

// analyze-study-guide (#981): re-run on the same guide + class every time the
// instructor hits Refresh, so the stable head (guide title, competency list)
// must sit above the response aggregates, which change with every submission.
Deno.test("analyze-study-guide system prompt is fully static (no substitutions)", () => {
  assertPlaceholderAbsent(
    "ANALYZE_STUDY_GUIDE_SYSTEM_PROMPT",
    ANALYZE_STUDY_GUIDE_SYSTEM_PROMPT,
    [
      "{{lang}}",
      "{{guide_title}}",
      "{{competencies}}",
      "{{pieces}}",
      "{{student_profiles}}",
      "{{submission_count}}",
    ],
  );
});

Deno.test("analyze-study-guide user prompt orders stable context before the response data", () => {
  assertPlaceholderOrder("ANALYZE_STUDY_GUIDE_USER_PROMPT", ANALYZE_STUDY_GUIDE_USER_PROMPT, [
    "{{lang}}",
    "{{guide_title}}",
    "{{piece_count}}",
    "{{competencies}}",
    "{{submission_count}}",
    "{{pieces}}",
    "{{student_profiles}}",
  ]);
});


// generate-evaluation-timeline: moved in-repo from an OpenAI-hosted saved
// prompt, so these are the first assertions its template has ever had. The
// analysis re-runs whenever an instructor opens Student 360 for a student with
// 2+ evaluations and no cached result, so the static head earns its cache.
Deno.test("evaluation-timeline system prompt is fully static (no substitutions)", () => {
  assertPlaceholderAbsent(
    "EVALUATION_TIMELINE_SYSTEM_PROMPT",
    EVALUATION_TIMELINE_SYSTEM_PROMPT,
    ["{{lang}}", "{{competency_history}}"],
  );
});

Deno.test("evaluation-timeline user prompt puts the language rule above the history", () => {
  // `competency_history` is the only per-call payload and must come last.
  assertPlaceholderOrder("EVALUATION_TIMELINE_USER_PROMPT", EVALUATION_TIMELINE_USER_PROMPT, [
    "{{lang}}",
    "{{competency_history}}",
  ]);
});
