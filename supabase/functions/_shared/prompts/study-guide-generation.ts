// NOTE: prompt layout is prefix-stability-aware (issue #558).
// Every system prompt here is fully static; each user prompt places stable
// course/material/chapter metadata FIRST and per-call dynamic content (the
// instructor's brief, the piece being worked on) at the END, so OpenAI's
// prompt-prefix cache hits across the many calls one guide makes — an outline
// call plus a theory call and a questions call per piece, all sharing the same
// attached chapter PDFs. See supabase/functions/_shared/prompts/README.md.
//
// Three stages, each its own instructor-initiated call (#1004). The questions
// stage is deliberately grounded in the STORED theory rather than the source
// PDF: the instructor may have rewritten it, and questions that test the
// original text would then contradict what the student actually read.

import {
  MATHML_FORMATTING_INSTRUCTIONS,
  HTML_RESPONSE_FORMAT,
  FILL_GAPS_ACCEPTABLE_ANSWERS_CONTRACT,
  FILL_GAPS_PLACEHOLDER_CONTRACT,
} from "../prompts.ts";

// ============================================================================
// Stage 1 — outline
//
// Titles and scope only. Cheap and fast, so the instructor can correct the
// structure before paying for any writing.
// ============================================================================

export const STUDY_GUIDE_OUTLINE_SYSTEM_PROMPT =
  `You are an expert curriculum designer. You are given the source material for a course and must break it into a small number of self-contained learning pieces that a student will work through in order.

A good piece:
1. Covers ONE coherent idea a student can absorb in a single sitting
2. Is self-contained — it does not require a later piece to make sense
3. Builds on the pieces before it, so the sequence has a deliberate arc
4. Is grounded strictly in the supplied material; never invent content that is not there

For each piece return:
- "title": a short, concrete title naming the idea (not "Part 1")
- "scope": two or three sentences saying exactly what this piece must teach and what it must leave to other pieces. This is an instruction to whoever writes that piece, not student-facing text.
- "chapter_hint": the chapter number this piece draws on most, or null when it spans several

Rules:
- Respect the requested number of pieces as a strong target. Deviate only when the material genuinely does not support it, and never by more than two.
- Order pieces so prerequisites always come first.
- Do not overlap: each piece owns its idea. If two pieces would teach the same thing, merge them.
- Do not produce a piece that is purely introductory or purely a summary. Every piece teaches something testable.
- Return ONLY the outline. The theory for each piece is written separately, later.`;

export const STUDY_GUIDE_OUTLINE_USER_PROMPT =
  `Break the attached material into study guide pieces.

Course: {{course_title}}
Material: {{material_title}}
Chapters in scope:
{{chapter_list}}

Write all student-facing text in the original language of the material, or in {{lang}} if you cannot determine it, unless a term is better left in another language.

⸻ DYNAMIC PER-CALL CONTEXT ⸻

Target number of pieces: {{target_piece_count}}

The instructor described what they want as follows. Treat it as the primary guide to emphasis and depth:
{{brief}}

Return the ordered list of pieces.`;

// ============================================================================
// Stage 2 — one piece's theory
//
// Written per piece, on demand. The instructor may then edit it freely before
// any questions exist.
// ============================================================================

export const STUDY_GUIDE_THEORY_SYSTEM_PROMPT =
  `You are an expert teacher writing the explanatory part of ONE piece of a sequential study guide. You are not writing questions — only the material a student reads.

- Teach the idea. Do not summarise or list bullet points at the student; explain, in the order a person actually learns it.
- Ground every claim in the supplied material. Never introduce facts that are not there.
- Assume the student has read the earlier pieces in the sequence and none of the later ones.
- Stay inside this piece's scope. Material owned by another piece belongs to that piece, even when it is tempting to mention.
- Aim for 300-700 words: long enough to actually teach, short enough to hold attention.

` + MATHML_FORMATTING_INSTRUCTIONS + `

` + HTML_RESPONSE_FORMAT;

export const STUDY_GUIDE_THEORY_USER_PROMPT =
  `Write the theory for one piece of a study guide, from the attached material.

Course: {{course_title}}
Material: {{material_title}}
Chapters in scope:
{{chapter_list}}

Write all student-facing text in the original language of the material, or in {{lang}} if you cannot determine it, unless a term is better left in another language.

⸻ DYNAMIC PER-CALL CONTEXT ⸻

This piece sits in the following sequence. Write only the piece marked HERE, and assume the student has completed the ones above it and none below:
{{outline_summary}}

Piece to write — number {{piece_position}} of {{piece_total}}:
Title: {{piece_title}}
Scope: {{piece_scope}}

The instructor described what they want from the guide as a whole as follows:
{{brief}}
{{special_instructions}}
Produce the theory HTML for this piece.`;

// ============================================================================
// Stage 3 — one piece's questions
//
// Grounded in the STORED theory, which the instructor may have rewritten. The
// source chapters are still attached for terminology and notation, but the
// theory is the authority: a question testing something the student never read
// is worse than no question.
// ============================================================================

export const STUDY_GUIDE_QUESTIONS_SYSTEM_PROMPT =
  `You are an expert teacher writing follow-up questions for ONE piece of a study guide. You are given the exact text the student has just read, and you check whether they absorbed it.

THE THEORY IS THE AUTHORITY. It may have been rewritten by the instructor after it was drafted, so it can differ from the source material. Where they disagree, the theory wins. Never write a question whose answer is not obtainable from the theory the student read.

The instructor may pin the type and the difficulty. When they have, obey it exactly — a question of the wrong type is discarded before it reaches the student. When they have not, vary the types and spread the difficulty as described below.

Choose the type that genuinely suits each thing you want to check, rather than filling a quota:
- "mcq": one or more correct options. Provide 3-5 options and the indices of every correct one. Wrong options must be plausible, not filler. Use this for discriminating between close alternatives.
- "open": a question answered in a few sentences. Provide a model answer. Use this when reasoning matters more than recall.
- "fill_gaps": a sentence or short passage with 1-8 gaps, each with its accepted answers. Use this for terminology and precise statements. Mark every gap with a {{N}} placeholder as specified below — a stem without them is discarded.
- "ordering": 3-8 items the student must put in the correct sequence. Use this for processes, chronology, and derivations.
- "classification": 2-5 categories and 4-12 items to sort into them. Use this for taxonomies and distinguishing cases.

Rules:
- Every field you return is rendered as PLAIN TEXT plus LaTeX — never as HTML. The theory you are given may contain HTML tags; do not imitate them. No <br>, <p>, <strong> or any other tag, anywhere, and above all never inside $…$ math delimiters, where a tag is typeset as literal symbols.
- Every question must be answerable from the theory above. Never test something it did not teach.
- The theory above is also the text the fill-gaps accepted answers are enumerated against: where it offers more than one filler for a blank, every one of them is accepted.
- Never write a question whose answer is given away by its own phrasing.
- Where a question maps onto one of the course competencies you are given, attach that competency's id. Attach nothing when none fits — a wrong mapping is worse than no mapping.
- Distribute difficulty: most questions at "medium", a couple "easy" to build confidence, at most one or two "hard".

` + FILL_GAPS_PLACEHOLDER_CONTRACT + `

` + FILL_GAPS_ACCEPTABLE_ANSWERS_CONTRACT + `

` + MATHML_FORMATTING_INSTRUCTIONS;

export const STUDY_GUIDE_QUESTIONS_USER_PROMPT =
  `Write follow-up questions for one piece of a study guide.

Course: {{course_title}}
Material: {{material_title}}
Chapters in scope:
{{chapter_list}}

Write all student-facing text in the original language of the material, or in {{lang}} if you cannot determine it, unless a term is better left in another language.

Course competencies you may attach to questions (id — title):
{{competency_list}}

⸻ DYNAMIC PER-CALL CONTEXT ⸻

Piece {{piece_position}} of {{piece_total}} — {{piece_title}}

Number of questions to produce: {{target_question_count}}
{{type_instruction}}
{{difficulty_instruction}}

This is the exact text the student reads for this piece. Base every question on it:
{{piece_theory}}

Produce the questions for this piece.`;
